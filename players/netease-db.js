/* players/netease-db.js — 网易云专用进度适配器（补偿 SMTC 不上报时间轴）
 *
 * 背景：网易云(Win32/CEF)只向 SMTC 上报 歌名/歌手/封面/播放状态，时间轴(Position/EndTime/LastUpdatedTime)
 *       恒为 0（实测播放中也全 0），故进度只能墙钟估算——中途接管/已放一半时会整体偏移。
 *
 * 方案：网易云会把"最近播放"写进本地 SQLite 库
 *       %LOCALAPPDATA%\Netease\CloudMusic\Library\webdb.dat 的 historyTracks 表：
 *         (playtime BIGINT=歌曲开始播放的 epoch 毫秒, id VARCHAR=网易云歌曲ID, jsonStr TEXT=完整曲目JSON)
 *       该行在"歌曲开始播放"时写入，playtime 即真实起点。于是：
 *         position = now - playtime - 累计暂停时长
 *       —— 即使中途才开始跟随也知道真实进度（不像墙钟从检测到那刻的 0 估）。
 *       歌曲 ID 还能换来网易云官方的精确时长与逐行歌词（见 lyrics-service）。
 *
 * 实现：零依赖。Electron 31 内置 Node 20 无 node:sqlite；原生 better-sqlite3 会给打包增加风险。
 *       故直接以字节扫描 db + wal 定位 historyTracks 记录（已逐位验证与 node:sqlite 查询结果一致）：
 *       记录体布局为 [playtime(变宽BE整数)][id文本][jsonStr文本]，从 jsonStr 的 '{' 回推 id 长度再回推 playtime。
 *       全程只读，绝不写库；文件被网易云占用时以共享读方式读取（Node fs 默认共享读，实测可读）。
 *
 * 局限：拖动进度条不会重写 playtime（实测 seek 全程不触发写库），故 seek 无法自动感知——提供 realign()
 *       供用户“点歌词行手动对齐”重设锚点补偿；开始跟随之前发生的暂停无法计入（少见），之后均正确补偿。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DB_FILE = 'webdb.dat';
const WAL_FILE = 'webdb.dat-wal';
const SCAN_WINDOW = 1200;          // 从 '{' 起最多读多少字节找 duration/name（overflow 会截断，取不到就用 API 补）
const EPOCH_MIN = 1.4e12;          // 合理 epoch-ms 下界(约2014)——用于自适应整数宽度
const EPOCH_MAX = 3e12;            // 上界(约2065)

function libDir() {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || '';
  return base ? path.join(base, 'Netease', 'CloudMusic', 'Library') : '';
}

// 从 jsonStr 起点回推 playtime：SQLite 用最小字节宽存整数(48bit/40bit/...)，逐宽度试出落在合理 epoch-ms 区间的那个
function playtimeBefore(buf, jsonStart, idLen) {
  const idStart = jsonStart - idLen;
  for (const w of [6, 5, 4, 8, 3, 7, 2, 1]) {
    const s = idStart - w;
    if (s < 0) continue;
    let v = 0;
    for (let i = 0; i < w; i++) v = v * 256 + buf[s + i];
    if (v > EPOCH_MIN && v < EPOCH_MAX) return v;
  }
  return 0;
}

// 扫描一个 db/wal 缓冲区里所有"歌曲历史"记录（只要 R_SO_4_ 歌曲行）
function scanRecords(buf) {
  const recs = [];
  const needle = Buffer.from('{"id":"', 'ascii');
  let idx = -1;
  while ((idx = buf.indexOf(needle, idx + 1)) >= 0) {
    const limit = Math.min(buf.length, idx + SCAN_WINDOW);
    let end = idx;
    while (end < limit && buf[end] >= 0x20 && buf[end] < 0x7f) end++;
    const js = buf.slice(idx, end).toString('latin1');
    const idm = /^\{"id":"(\d+)","commentThreadId":"R_SO_4_/.exec(js);
    if (!idm) continue;
    const durm = /"duration":(\d+)/.exec(js);
    const pt = playtimeBefore(buf, idx, idm[1].length);
    if (pt > 0) recs.push({ id: idm[1], playtime: pt, duration: durm ? Number(durm[1]) : 0 });
  }
  return recs;
}

// 极简 JSON GET（取歌曲详情：时长兜底）
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', Referer: 'https://music.163.com/' },
    }, (res) => {
      let d = ''; res.setEncoding('utf-8');
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

function createNeteaseDbAdapter() {
  let timer = null;
  let playing = false;        // 由 registry 用网易云 SMTC 播放状态馈送
  let curId = '';             // 当前歌曲网易云 id
  let anchor = 0;             // 当前歌曲 playtime（开始播放的 epoch ms）
  let curDur = 0;             // 当前歌曲时长（扫描或 API）
  let pausedAccum = 0;        // 已结束的暂停累计（ms）
  let pauseStart = 0;         // 进行中的暂停起点（now），0=未在暂停
  let manualAnchor = false;   // 用户手动对齐后置真：同首歌内 rescan 不再用 playtime 覆盖 anchor，直到切歌
  let lastScanMtime = { db: -1, wal: -1 };
  const durCache = new Map();  // id -> duration（含扫描到的与 API 取的，>0 才有效）
  const durInflight = new Set(); // 正在请求时长的 id
  const durFailAt = new Map();   // id -> 上次失败时刻（20s 冷却，避免持续失败时频繁请求）

  function statMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (e) { return -1; } }

  function fetchDuration(id) {
    if (!id) return;
    if ((durCache.get(id) || 0) > 0) return;                 // 已有有效时长
    if (durInflight.has(id)) return;                          // 正在请求
    if ((durFailAt.get(id) || 0) + 20000 > Date.now()) return; // 失败冷却中
    durInflight.add(id);
    httpGetJson('https://music.163.com/api/song/detail?ids=[' + id + ']')
      .then((j) => {
        const s = ((j || {}).songs || [])[0] || {};
        const d = Number(s.duration) || 0;
        if (d > 0) { durCache.set(id, d); if (id === curId) curDur = d; }
        else durFailAt.set(id, Date.now());
      })
      .catch(() => { durFailAt.set(id, Date.now()); })
      .then(() => { durInflight.delete(id); });
  }

  function rescan(force) {
    const dir = libDir();
    if (!dir) return;
    const dbp = path.join(dir, DB_FILE);
    const walp = path.join(dir, WAL_FILE);
    const dbM = statMtime(dbp);
    const walM = statMtime(walp);
    if (dbM < 0 && walM < 0) return;                    // 网易云未安装/无库：静默降级
    if (!force && dbM === lastScanMtime.db && walM === lastScanMtime.wal) return;  // 无变化：省 IO
    lastScanMtime = { db: dbM, wal: walM };

    let recs = [];
    for (const p of [dbp, walp]) {
      try { recs = recs.concat(scanRecords(fs.readFileSync(p))); } catch (e) {}
    }
    if (!recs.length) return;
    // 记录每个 id 的已知时长（overflow 截断时用同 id 其它记录补全）
    for (const r of recs) if (r.duration > 0 && !durCache.get(r.id)) durCache.set(r.id, r.duration);
    recs.sort((a, b) => b.playtime - a.playtime);
    const best = recs[0];

    if (best.id !== curId) {
      // 切歌：锚定到新歌起点，清除手动对齐标记
      curId = best.id;
      anchor = best.playtime;
      manualAnchor = false;
      pausedAccum = 0;
      pauseStart = playing ? 0 : Date.now();
      curDur = 0;
    } else if (!manualAnchor && best.playtime > anchor) {
      // 同歌且网易云刷新了 playtime：跟随重锚；手动对齐后不覆盖（否则 1s 内被冲掉）
      anchor = best.playtime;
      pausedAccum = 0;
      pauseStart = playing ? 0 : Date.now();
      curDur = 0;
    }
    curDur = best.duration > 0 ? best.duration : (durCache.get(curId) || 0);
    if (!(curDur > 0)) fetchDuration(curId);            // 扫描取不到时长 → API 兜底
  }

  function positionMs() {
    if (!anchor) return 0;
    const now = Date.now();
    const paused = pausedAccum + (pauseStart ? (now - pauseStart) : 0);
    let pos = now - anchor - paused;
    if (pos < 0) pos = 0;
    if (curDur > 0 && pos > curDur) pos = curDur;
    return Math.round(pos);
  }

  return {
    start() {
      if (timer) return;
      try { rescan(true); } catch (e) {}
      timer = setInterval(() => { try { rescan(false); } catch (e) {} }, 1000);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    // registry 用网易云 SMTC 播放状态馈送：playing=true 继续计时，false 冻结并累计暂停时长
    setPlaying(v) {
      v = !!v;
      const now = Date.now();
      if (v) {
        if (!playing && pauseStart) pausedAccum += now - pauseStart;
        pauseStart = 0;
        playing = true;
      } else {
        if (playing) pauseStart = now;         // 播放→暂停：记起点
        else if (!pauseStart) pauseStart = now; // 观测到的一直是暂停且无起点：以现在为起点（近似）
        playing = false;
      }
    },
    refresh() { try { rescan(true); } catch (e) {} },
    // 供 registry 拉取当前进度快照（网易云在播且有锚点时 ok）
    getProgress() {
      if (!curId || !anchor) return { ok: false };
      return { ok: true, id: curId, positionMs: positionMs(), durationMs: curDur > 0 ? curDur : 0 };
    },
    // 用户 seek 后手动对齐：把锚点重设为“当前时刻 - 指定位置”，使 positionMs() 立即等于该位置并继续 1:1 递增。
    // 置 manualAnchor 后同首歌内 rescan 不再用 playtime 覆盖，直到切歌复位（解决 seek 无信号无法自动重锚）。
    realign(positionMs) {
      if (!curId || !anchor) return false;
      const now = Date.now();
      anchor = now - Math.max(0, Number(positionMs) || 0);
      pausedAccum = 0;
      pauseStart = playing ? 0 : now;
      manualAnchor = true;
      return true;
    },
  };
}

module.exports = { createNeteaseDbAdapter };
