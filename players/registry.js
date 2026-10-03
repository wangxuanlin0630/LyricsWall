/* players/registry.js — 播放器识别 + 多来源融合（PlayerManager）
 *
 * 职责：
 *  1) 把 SMTC 的 SourceAppUserModelId 映射到播放器 id（kugou/qq/netease/...）。
 *  2) 融合多个适配器：有专用适配器且数据新鲜时用专用（酷狗→CDP），否则用 SMTC；
 *     两者都不可用时输出 ok:false，由上层回退墙钟估算。
 *  3) 对外只发一种归一化事件（unified），渲染层/服务器/歌词服务都消费它。
 *
 * 统一事件形状：
 *  { ok, source:'cdp'|'smtc', playerId, status:'playing|paused|stopped',
 *    positionMs, durationMs, title, artist, album, cover, hash, updatedMs, rate, ts }
 */
'use strict';

const { createSmtcAdapter } = require('./smtc');
const { createKugouCdpAdapter } = require('./kugou-cdp');
const { createNeteaseDbAdapter } = require('./netease-db');
const { createNeteaseCdpAdapter } = require('./netease-cdp');
const neteasePatch = require('./netease-patch');

// SourceAppUserModelId / 进程名 关键词 → 播放器 id
const SOURCE_PATTERNS = [
  [/kugou|kgmusic|\bkg\b/i, 'kugou'],
  [/qqmusic|qq\.com|tencent/i, 'qq'],
  [/netease|cloudmusic|163/i, 'netease'],
  [/kuwo/i, 'kuwo'],
  [/qishui|sipshui|bytedance.*music/i, 'qishui'],
  [/spotify/i, 'spotify'],
  [/applemusic|apple.*music|itunes/i, 'apple'],
  [/potplayer/i, 'potplayer'],
  [/foobar/i, 'foobar'],
];

function mapSourceId(id) {
  const s = String(id || '');
  if (!s) return 'unknown';
  for (const [re, pid] of SOURCE_PATTERNS) {
    if (re.test(s)) return pid;
  }
  return 'unknown';
}

// playerId → 传给 watch 脚本的 SourceAppUserModelId 过滤正则（字符串形式，供 PowerShell -match）
const PLAYER_REGEX = {
  kugou: 'kugou|kgmusic|\\bkg\\b',
  qq: 'qqmusic|qq\\.com|tencent',
  netease: 'netease|cloudmusic|163',
  kuwo: 'kuwo',
  qishui: 'qishui|bytedance.*music',
  spotify: 'spotify',
  apple: 'applemusic|apple.*music|itunes',
  potplayer: 'potplayer',
  foobar: 'foobar',
};

// 专用适配器表：playerId → 是否已有比 SMTC 更准的专用来源
const SPECIAL_ADAPTERS = { kugou: 'cdp' };

function createPlayerManager(onUnified, opts) {
  let smtc = null;
  let cdp = null;
  let nedb = null;       // 网易云进度适配器（读本地库补偿 SMTC 无时间轴）
  let ncdp = null;       // 网易云 CDP 适配器（优先于 nedb，seek 自动感知）
  let running = false;
  let preferred = 'auto';   // 'auto' 或具体 playerId：锁定只认该播放器，它没在放则输出无播放（不回退）
  let lastNedbKey = '';  // 网易云上次 歌名|歌手，用于切歌即时重扫锚定

  let lastSmtc = null;   // 最近一次 smtc 归一化事件
  let lastCdp = null;    // 最近一次 cdp 归一化事件
  let lastCdpOkAt = 0;   // cdp 最近一次 ok 的时刻
  let lastSmtcOkAt = 0;
  let lastNcdp = null;   // 最近一次网易云 cdp 事件
  let lastNcdpOkAt = 0;

  const CDP_FRESH_MS = 3000;   // cdp 数据新鲜度窗口
  const SMTC_FRESH_MS = 3000;
  const NCDP_FRESH_MS = 3000;

  /* ---- 停滞检测（对齐 PlayerCap 的 time-stall 判据）----
   * 场景：播放器实际已暂停/卡住，但状态通道未上报（如 QQ 音乐 SMTC 偶发冻结）。
   * 判据：status=playing 且有进度轴，但 positionMs/updatedMs 连续 STALL_MS 未前进
   * → 把 rate 置 0 冻结下游插值，避免歌词按墙钟越走越偏；进度恢复前进自动解除。 */
  const STALL_MS = 2500;
  const stall = { lastPos: -1, lastUpd: -1, lastAdvanceAt: 0, on: false };
  let stallKey = '';
  function stallCheck(ev) {
    const key = (ev.playerId || '') + '|' + (ev.title || '') + '|' + (ev.artist || '');
    if (key !== stallKey) { stallKey = key; stall.lastPos = -1; stall.lastUpd = -1; stall.on = false; }
    if (ev.status !== 'playing' || !(ev.durationMs > 0) || !ev.updatedMs) { stall.on = false; return; }
    const pos = Number(ev.positionMs || 0), upd = Number(ev.updatedMs || 0);
    const now = Date.now();
    if (pos !== stall.lastPos || upd !== stall.lastUpd) {
      stall.lastPos = pos; stall.lastUpd = upd; stall.lastAdvanceAt = now; stall.on = false;
      return;
    }
    if (!stall.on && now - stall.lastAdvanceAt > STALL_MS) stall.on = true;
    if (stall.on) { ev.rate = 0; ev.stalled = true; }
  }

  function emit(ev) { if (onUnified) { try { onUnified(ev); } catch (e) {} } }

  // 网易云：SMTC 只给 歌名/状态、时间轴恒 0；用 CDP/nedb 读到的真实起点算出精确进度覆盖上去，
  // 并带上精确歌曲 id(nid) 供歌词按 id 取官方逐行词。CDP 不可用时回退 nedb；都无则保持原 SMTC 事件（上层回退墙钟）。
  function applyNeteaseProgress(ev) {
    if (!ev || !ev.ok) return ev;
    const pid = ev.playerId || mapSourceId(ev.sourceId);
    if (pid !== 'netease') return ev;
    const np = getNeteaseProgress();
    if (np.ok) {
      const p = np.data;
      ev.positionMs = p.positionMs;
      if (p.durationMs > 0) ev.durationMs = p.durationMs;
      ev.updatedMs = Date.now();   // 让上层 hasPos() 成立、按真实进度插值（暂停时不插值，天然冻结）
      if (p.nid) ev.nid = String(p.nid);
      else if (p.id) ev.nid = String(p.id);
      ev.progress = np.source === 'cdp' ? 'netease-cdp' : 'netease-db';
    }
    return ev;
  }

  function cdpFresh() { return lastCdp && lastCdp.ok && (Date.now() - lastCdpOkAt) < CDP_FRESH_MS; }
  function smtcFresh() { return lastSmtc && lastSmtc.ok && (Date.now() - lastSmtcOkAt) < SMTC_FRESH_MS; }
  function ncdpFresh() { return lastNcdp && lastNcdp.ok && (Date.now() - lastNcdpOkAt) < NCDP_FRESH_MS; }

  // 网易云进度来源选择：CDP 直连 > nedb 锚点 > SMTC 原始（无时间轴）
  function getNeteaseProgress() {
    if (ncdpFresh()) {
      return { ok: true, source: 'cdp', data: lastNcdp };
    }
    try {
      const p = nedb.getProgress();
      if (p && p.ok && p.positionMs >= 0) {
        return { ok: true, source: 'nedb', data: p };
      }
    } catch (e) {}
    return { ok: false };
  }

  function recompute() {
    // 决定当前播放器 id：优先 smtc 的 sourceId；smtc 无会话时用 cdp（酷狗）
    let playerId = 'unknown';
    if (smtcFresh()) playerId = mapSourceId(lastSmtc.sourceId);
    else if (cdpFresh()) playerId = 'kugou';

    // 选择来源：根据首选播放器锁定
    let chosen = null;
    if (preferred === 'auto') {
      // 酷狗且 cdp 新鲜 → cdp；否则 smtc 新鲜 → smtc；再否则 cdp（酷狗在播但 smtc 无会话）
      if (playerId === 'kugou' && cdpFresh() && lastCdp.status !== 'stopped') {
        chosen = lastCdp;
      } else if (smtcFresh()) {
        chosen = lastSmtc;
        // 若 smtc 识别为酷狗但 cdp 也新鲜且 smtc 无进度（酷狗不上报），仍用 cdp
        if (mapSourceId(lastSmtc.sourceId) === 'kugou' && cdpFresh() &&
            !(lastSmtc.durationMs > 0) && lastCdp.status !== 'stopped') {
          chosen = lastCdp;
        }
      } else if (cdpFresh() && lastCdp.status !== 'stopped') {
        chosen = lastCdp;
      }
    } else if (preferred === 'kugou') {
      // 锁定酷狗：优先 cdp（零漂移），否则酷狗的 smtc 会话
      if (cdpFresh() && lastCdp.status !== 'stopped') chosen = lastCdp;
      else if (smtcFresh() && mapSourceId(lastSmtc.sourceId) === 'kugou') chosen = lastSmtc;
    } else {
      // 锁定其它播放器：只认匹配的 smtc 会话，忽略 cdp（cdp 仅酷狗）
      if (smtcFresh() && mapSourceId(lastSmtc.sourceId) === preferred) chosen = lastSmtc;
    }

    if (!chosen) {
      emit({ ok: false, source: 'none', playerId: preferred !== 'auto' ? preferred : playerId, ts: Date.now() });
      return;
    }
    // 补 playerId（cdp 事件已带；smtc 事件需映射）
    const ev = Object.assign({}, chosen);
    ev.playerId = ev.playerId || mapSourceId(ev.sourceId);
    ev.ts = Date.now();
    applyNeteaseProgress(ev);
    stallCheck(ev);
    emit(ev);
  }

  nedb = createNeteaseDbAdapter();
  smtc = createSmtcAdapter((ev) => {
    if (ev.ok) { lastSmtc = ev; lastSmtcOkAt = Date.now(); }
    else { lastSmtc = ev; }   // 保留 ok:false 以便 smtcFresh() 失效
    // 馈送网易云播放状态给 nedb（暂停补偿），切歌时立即重扫锚定，减少 1s 轮询延迟
    try {
      if (ev.ok && mapSourceId(ev.sourceId) === 'netease') {
        nedb.setPlaying(ev.status === 'playing');
        const key = (ev.title || '') + '|' + (ev.artist || '');
        if (key !== lastNedbKey) { lastNedbKey = key; nedb.refresh(); }
      }
    } catch (e) {}
    recompute();
  });
  cdp = createKugouCdpAdapter((ev) => {
    if (ev.ok) { lastCdp = ev; lastCdpOkAt = Date.now(); }
    else { lastCdp = ev; }
    recompute();
  }, { onPortClosed: (opts && opts.onKugouPortClosed) || null });
  ncdp = createNeteaseCdpAdapter((ev) => {
    if (ev.ok) { lastNcdp = ev; lastNcdpOkAt = Date.now(); }
    else { lastNcdp = ev; }
    recompute();
  }, { onPortClosed: (opts && opts.onNeteasePortClosed) || null });

  return {
    start() {
      if (running) return;
      running = true;
      smtc.start();
      cdp.start();
      try { nedb.start(); } catch (e) {}
      try { ncdp.start(); } catch (e) {}
    },
    stop() {
      running = false;
      smtc.stop();
      cdp.stop();
      try { nedb.stop(); } catch (e) {}
      try { ncdp.stop(); } catch (e) {}
      lastSmtc = null; lastCdp = null; lastCdpOkAt = 0; lastSmtcOkAt = 0;
      lastNcdp = null; lastNcdpOkAt = 0;
    },
    // 供服务器/歌词服务主动查询当前快照
    snapshot() {
      if (preferred === 'auto') {
        if (cdpFresh() && lastCdp.status !== 'stopped') return Object.assign({}, lastCdp);
        if (smtcFresh()) return applyNeteaseProgress(Object.assign({}, lastSmtc, { playerId: mapSourceId(lastSmtc.sourceId) }));
        if (cdpFresh()) return Object.assign({}, lastCdp);
        return null;
      }
      if (preferred === 'kugou') {
        if (cdpFresh() && lastCdp.status !== 'stopped') return Object.assign({}, lastCdp);
        if (smtcFresh() && mapSourceId(lastSmtc.sourceId) === 'kugou') return Object.assign({}, lastSmtc, { playerId: 'kugou' });
        return null;
      }
      if (smtcFresh() && mapSourceId(lastSmtc.sourceId) === preferred) return applyNeteaseProgress(Object.assign({}, lastSmtc, { playerId: preferred }));
      return null;
    },
    // 设置首选播放器（'auto' 或 playerId）：同步过滤正则给 smtc 并立即重算
    setPreferred(pid) {
      preferred = (pid && PLAYER_REGEX[pid]) ? pid : 'auto';
      try { smtc.setPreferred(preferred === 'auto' ? '' : PLAYER_REGEX[preferred]); } catch (e) {}
      recompute();
    },
    getPreferred() { return preferred; },
    // 当前可检测到的播放器 id 列表（所有已注册 SMTC 会话 + cdp 新鲜的酷狗），供 UI 活跃标记
    getActivePlayers() {
      const set = new Set();
      try { (smtc.getActiveSourceIds() || []).forEach((sid) => { const p = mapSourceId(sid); if (p !== 'unknown') set.add(p); }); } catch (e) {}
      if (cdpFresh()) set.add('kugou');
      return Array.from(set);
    },
    // 网易云 CDP 状态查询（供 UI 显示当前接入状态）
    getNeteaseCdpState() {
      return {
        connected: ncdpFresh(),
        hasData: !!(lastNcdp && lastNcdp.ok),
      };
    },
    // 网易云 seek 后手动对齐：转发给 nedb 重设锚点，并立即用新锚点重算广播（无需等下一轮 500ms）
    realignNetease(positionMs) {
      let ok = false;
      try { ok = nedb.realign(positionMs); } catch (e) {}
      if (ok) { try { recompute(); } catch (e) {} }
      return ok;
    },
  };
}

module.exports = { createPlayerManager, mapSourceId, PLAYER_REGEX, SPECIAL_ADAPTERS };
