/* lyrics-service.js — 主进程统一歌词服务
 *
 * 把"取词"从渲染层上移到主进程：歌曲变化时按
 *   酷狗 hash 精确 → 歌名/歌手本地 krc → 在线(网易云) 的顺序解析出 lines，
 * 然后通过回调广播给所有客户端（桌面渲染层 + 网页/手机），实现多端同一份歌词。
 *
 * 只读播放器/本地缓存/公开歌词接口；任何一步失败都降级到下一级，最终失败返回 null。
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const krc = require('./krc');

/* ---------------- LRC 解析（Node 侧，与 src/lrc.js 输出对齐） ---------------- */
function parseLrc(text) {
  const rows = String(text || '').split(/\r\n|\n|\r/);
  const raw = [];
  for (const line of rows) {
    const s = line.trim();
    if (!s || s[0] !== '[') continue;
    // 抽取所有 [mm:ss.xx] 时间标签
    const tags = [];
    const re = /\[(\d+):([0-9.]+)\]/g;
    let m;
    let lastEnd = 0;
    while ((m = re.exec(s))) {
      tags.push(parseInt(m[1], 10) * 60 + parseFloat(m[2]));
      lastEnd = re.lastIndex;
    }
    if (!tags.length) continue;
    const content = s.slice(lastEnd).replace(/<[^>]*>/g, '').trim();
    if (!content) continue;
    for (const t of tags) raw.push({ time: t, text: content });
  }
  raw.sort((a, b) => a.time - b.time);
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    const dur = i + 1 < raw.length ? Math.max(0.5, raw[i + 1].time - raw[i].time) : 4;
    lines.push({ time: raw[i].time, text: raw[i].text, duration: dur });
  }
  return lines;
}

// 无时间轴纯文本词：剔除制作信息/标签/空行后，按歌曲时长均匀分布合成时间轴（估算同步）。
// 仅用于网易云只有纯文本词、而播放器（如 QQ）又上报了真实时长的兜底场景。
function synthesizeTimeline(text, durationMs) {
  const dur = Number(durationMs) || 0;
  if (!(dur > 0)) return [];
  const creditRe = /^(作词|作曲|编曲|演唱|制作人|制作|录音|混音|母带|吉他|贝斯|和声|和音|唢呐|统筹|策划|监制|出品|发行|歌词|vocal|arranger|producer|mixing|mastering|op|sp)\s*[:：]/i;
  const texts = [];
  for (const raw of String(text || '').split(/\r\n|\n|\r/)) {
    const s = raw.replace(/<[^>]*>/g, '').trim();
    if (!s) continue;
    if (s[0] === '[' && s.indexOf(']') >= 0) continue;   // [ti:][ar:][00:00.00] 等标签行
    if (creditRe.test(s)) continue;                       // 作词/作曲/编曲 等制作信息
    texts.push(s);
  }
  if (!texts.length) return [];
  const per = dur / 1000 / texts.length;
  const lines = [];
  let t = 0;
  for (const s of texts) { lines.push({ time: t, text: s, duration: Math.max(1, per) }); t += per; }
  return lines;
}

/* ---------------- 在线歌词（网易云公开接口 + QQ 音乐官方接口） ---------------- */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const HEADERS_163 = { 'User-Agent': UA, Referer: 'https://music.163.com/' };

// headers：自定义请求头（默认网易云）；netOpts：https.get 额外项（如 { family: 4 } 强制 IPv4）
function httpGetJson(url, headers, netOpts) {
  return new Promise((resolve, reject) => {
    const opt = Object.assign({ headers: headers || HEADERS_163 }, netOpts || {});
    const req = https.get(url, opt, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('响应解析失败')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('请求超时')));
  });
}

/* ---------------- HTML 实体反转义 ----------------
 * QQ fcg 返回的 lyric/trans 含 HTML 实体（&amp; &quot; &#39; 等），
 * 对齐 PlayerCap 的 html.UnescapeString——不转义会把 &amp; 直接推上歌词墙。
 * 注意：roma 是 QRC/base64 包装，不能反转义（会破坏 base64 字符集）。
 */
function htmlUnescape(s) {
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(s || '').replace(/&(amp|lt|gt|quot|apos|nbsp);|&#(\d+);|&#x([0-9a-fA-F]+);/g,
    (m, named, dec, hex) => {
      if (named) return NAMED[named];
      try { return String.fromCodePoint(dec ? parseInt(dec, 10) : parseInt(hex, 16)); } catch (e) { return m; }
    });
}

/* ---------------- 翻译/音译轨合并（对齐 PlayerCap） ----------------
 * 网易云：tlyric/romalrc 是独立 LRC，按毫秒时间戳就近匹配主行 → line.sub / line.roma。
 * 酷狗 KRC：内嵌 [language:] 轨已在 krc.krcToLines 按行号对齐，此处无需再合。
 * QQ：trans 字段是独立 LRC，按毫秒时间戳就近匹配 → line.sub。
 */
// QQ 翻译轨的产品文案/占位符（对齐 PlayerCap transIsDroppable）：
// 首行常塞"QQ音乐享有本翻译作品的著作权"/"以下歌词翻译由文曲大模型提供"声明，
// "//"是"本行不翻译"占位符——不过滤会被就近匹配挂到第一行上墙。
const TRANS_DROP_RE = /著作权|版权|歌词翻译/;
function transDroppable(text) {
  const t = String(text || '').trim();
  return !t || t === '//' || TRANS_DROP_RE.test(t);
}
function mergeTrackByTime(lines, trackLrc, field) {
  if (!trackLrc || !lines || !lines.length) return;
  const tLines = parseLrc(trackLrc);   // parseLrc 已按 time 升序
  if (!tLines.length) return;
  // 就近匹配（±1.2s 窗口）：同一接口的主轨/译轨时间戳常差几到几十毫秒
  // （主轨 [00:00.85] 两位 vs 译轨 [00:00.851] 三位），严格等值匹配会大面积落空；
  // 相邻歌词行间隔通常 >2s，就近取最近一条误配风险很低。双指针要求两边都有序。
  const TOL = 1.2;
  let j = 0;
  for (const ln of lines) {
    while (j + 1 < tLines.length &&
           Math.abs(tLines[j + 1].time - ln.time) <= Math.abs(tLines[j].time - ln.time)) j++;
    const cand = tLines[j];
    if (cand && Math.abs(cand.time - ln.time) <= TOL && !(field === 'sub' && transDroppable(cand.text))) {
      ln[field] = cand.text;
    }
  }
}

/* 结构化行的时间就近合并（±1.5s）：用于汽水「借」酷狗音译轨。
 * 两边断行不同（PlayerCap 为此做了字级贴合）；行级就近是简化版——对不上留空，宁缺毋滥。 */
function mergeLinesTimeNearest(lines, srcLines, field) {
  if (!Array.isArray(srcLines) || !srcLines.length || !lines || !lines.length) return;
  for (const ln of lines) {
    if (ln[field]) continue;
    let best = null, bestDiff = 1.6;
    for (const s of srcLines) {
      const v = s[field];
      if (!v) continue;
      const d = Math.abs(s.time - ln.time);
      if (d < bestDiff) { bestDiff = d; best = v; }
    }
    if (best) ln[field] = best;
  }
}

async function onlineSearch(keyword) {
  const url = 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(keyword) + '&type=1&limit=5&offset=0';
  const json = await httpGetJson(url);
  return (((json || {}).result || {}).songs) || [];
}
async function onlineLyric(id) {
  const url = 'https://music.163.com/api/song/lyric?id=' + id + '&lv=1&kv=1&tv=-1';
  const json = await httpGetJson(url);
  return ((json || {}).lrc || {}).lyric || '';
}
// 网易云完整歌词（含翻译/音译轨）：用 lyric/v1 接口一次拿全
async function onlineLyricFull(id) {
  const url = 'https://music.163.com/api/song/lyric/v1?id=' + id + '&cp=false&tv=0&lv=0&rv=0&kv=0&yv=0&ytv=0&yrv=0';
  const json = await httpGetJson(url);
  return {
    lrc: ((json || {}).lrc || {}).lyric || '',
    tlyric: ((json || {}).tlyric || {}).lyric || '',
    romalrc: ((json || {}).romalrc || {}).lyric || '',
  };
}

// 在线择优：歌名为主、歌手仅用于加分。
// QQ音乐等上报的歌手名常不准，直接拼“歌名+歌手”会把结果带偏到错误版本；
// 故同时用“歌名+歌手”与“仅歌名”两次检索汇成候选池，按歌名相似度(+歌手加成)排序，
// 过滤过低相似后依次试取歌词直到命中，避免盲取 songs[0] 导致无词/张冠李戴。
const ONLINE_MIN_SIM = 0.6;
async function pickOnlineSong(title, artist, durationMs) {
  const queries = [];
  const ta = (String(title || '') + ' ' + String(artist || '')).trim();
  const t = String(title || '').trim();
  if (ta) queries.push(ta);
  if (t && t !== ta) queries.push(t);

  const pool = new Map(); // id -> { s, score }
  for (const q of queries) {
    let songs;
    try { songs = await onlineSearch(q); } catch (e) { continue; }
    for (const s of (songs || [])) {
      let score = krc.similarity(title, s.name);   // 歌名相似为主
      if (artist) {
        const hit = (s.artists || []).some((a) => krc.similarity(artist, a.name) >= 0.6);
        score += hit ? 0.25 : -0.1;                 // 歌手命中强加分；不符轻微降权（翻唱仍可能同词，不排除）
      }
      // 非原版降权：优先录音室原版，避开 Live/翻唱/伴奏/DJ 等（常改词或非同曲）
      if (/\blive\b|翻唱|翻自|\bcover\b|伴奏|instrumental|\bdj\b|remix/i.test(s.name)) score -= 0.12;
      // 时长匹配：播放器（QQ/酷狗）上报了精确时长时，用它锁定“同一版本”——
      // 同名不同版时长不同，时长一致基本可确定是同一录音，歌词时间轴才能与播放精确对齐（QQ 同步的关键）
      const rep = Number(durationMs) || 0;
      const cd = Number(s.duration) || 0;
      if (rep > 0 && cd > 0) {
        const diff = Math.abs(cd - rep);
        if (diff <= 2000) score += 0.35;          // 时长几乎一致：极可能同一版本
        else if (diff <= 6000) score += 0.2;
        else if (diff <= 15000) score += 0.05;
        else score -= Math.min(0.4, diff / 120000); // 时长差太多：很可能不同版本，降权
      }
      const prev = pool.get(s.id);
      if (!prev || score > prev.score) pool.set(s.id, { s, score });
    }
  }
  const ranked = Array.from(pool.values())
    .filter((c) => c.score >= ONLINE_MIN_SIM)
    .sort((a, b) => b.score - a.score);
  let untimed = null;   // 兜底：确有歌词文本但无时间轴的最高分候选
  for (const cand of ranked.slice(0, 5)) {
    let full;
    try { full = await onlineLyricFull(cand.s.id); } catch (e) { continue; }
    const lrcText = full.lrc;
    if (!lrcText) continue;
    const meta = { title: cand.s.name || title, artist: (cand.s.artists || []).map((a) => a.name).join('/') || artist };
    const lines = parseLrc(lrcText);
    if (lines.length) {
      mergeTrackByTime(lines, full.tlyric, 'sub');
      mergeTrackByTime(lines, full.romalrc, 'roma');
      return { lines, title: meta.title, artist: meta.artist };
    }
    // 无时间轴但有文本：记首个（即最高分）作为估算兜底
    if (!untimed) untimed = { text: lrcText, score: cand.score, title: meta.title, artist: meta.artist };
  }
  if (untimed) return { untimedText: untimed.text, score: untimed.score, title: untimed.title, artist: untimed.artist };
  return null;
}

/* ---------------- QQ 音乐官方歌词源（c.y.qq.com） ----------------
 * QQ 播放器经 SMTC 不上报歌曲 id，本地缓存歌词又是加密库（qmlist64.db 非标准 SQLite、密钥私有）读不出，
 * 故改用 QQ 官方接口：按 歌名/歌手 搜索拿 songmid + interval(时长秒)，用播放器上报的精确时长在候选里
 * 锁定“同一版本”，再按 songmid 取官方明文 LRC（nobase64=1，无需解密 QRC）。与 QQ 播放同源、时间轴天然对齐。
 * 接口只读、匿名可用（UA + Referer + 基础 Cookie + 强制 IPv4；QQ CDN 对 IPv6 常直接 RST）。
 */
const QQ_HEADERS = {
  'User-Agent': UA,
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://y.qq.com/',
  Cookie: 'pgv_pvid=1; qqmusic_fromtag=66;'
};
const QQ_NET = { family: 4 };

async function qqSearch(keyword) {
  const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + encodeURIComponent(keyword) +
    '&format=json&p=1&n=8&cr=1&aggr=1&lossless=0&catZhida=1';
  const json = await httpGetJson(url, QQ_HEADERS, QQ_NET);
  return ((((json || {}).data || {}).song || {}).list) || [];
}
async function qqLyric(songmid) {
  const url = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + songmid +
    '&format=json&nobase64=1&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0';
  const json = await httpGetJson(url, Object.assign({}, QQ_HEADERS, { Referer: 'https://y.qq.com/portal/player.html' }), QQ_NET);
  return {
    lyric: htmlUnescape((json || {}).lyric || ''),   // nobase64=1 → 明文 LRC（含 HTML 实体，需反转义）
    trans: htmlUnescape((json || {}).trans || ''),   // 翻译轨（同样是 LRC 格式，同需反转义）
    roma: (json || {}).roma || '',                   // 音译轨（QRC 逐字格式，可能 base64——不能反转义）
  };
}

/* 为 QQ 主词挑网易云翻译/音译轨：不以歌名/歌手相似度定胜负（QQ 歌手名常带括号别名，
 * 如「初音未来 (初音ミク)」，会把网易云检索带偏到翻唱版——实测千本桜挑中 Poppin'Party Cover），
 * 而是抓前若干候选的 lyric/v1，用 QQ 主词时间轴与候选主词的重叠行数决胜：
 * 同版本时间轴几乎逐行重合，翻唱/不同母带自然筛掉；重叠率 <60% 说明曲库无同版，宁可不补也不挂错轨。 */
async function fetchNeteaseTracksFor(title, artist, refLines) {
  if (!title || !refLines || !refLines.length) return null;
  const queries = [];
  const ta = (String(title || '') + ' ' + String(artist || '')).trim();
  const t = String(title || '').trim();
  if (ta) queries.push(ta);
  if (t && t !== ta) queries.push(t);
  const seen = new Map();   // id -> 粗排分（歌名/歌手相似，只用于缩小抓取范围）
  for (const q of queries) {
    let songs;
    try { songs = await onlineSearch(q); } catch (e) { continue; }
    for (const s of (songs || [])) {
      let score = krc.similarity(title, s.name);
      if (artist && (s.artists || []).some((a) => krc.similarity(artist, a.name) >= 0.6)) score += 0.25;
      const prev = seen.get(s.id);
      if (!prev || score > prev) seen.set(s.id, score);
    }
  }
  const cands = Array.from(seen.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
  const scored = [];   // { tlyric, romalrc, hit }
  for (const id of cands) {
    let full;
    try { full = await onlineLyricFull(id); } catch (e) { continue; }
    if (!full.lrc || (!full.tlyric && !full.romalrc)) continue;
    const neLines = parseLrc(full.lrc);
    if (!neLines.length) continue;
    let hit = 0;
    for (const q of refLines) {
      for (const n of neLines) { if (Math.abs(n.time - q.time) <= 1.6) { hit++; break; } }
    }
    scored.push({ tlyric: full.tlyric, romalrc: full.romalrc, hit });
  }
  if (!scored.length) return null;
  // 同版本可能有多个条目（不同专辑收录），hit 并列时轨更全的优先
  // （实测千本桜：hit=46 的两个候选中一个无 romalrc、另一个 tlyric+romalrc 全有）。
  const maxHit = Math.max.apply(null, scored.map((c) => c.hit));
  const aligned = scored.filter((c) => c.hit >= Math.max(Math.ceil(refLines.length * 0.6), maxHit - 2));
  if (!aligned.length) return null;   // 重叠率门槛：不同母带时间轴整体漂移，挂上必错
  aligned.sort((a, b) =>
    ((b.romalrc ? 1 : 0) + (b.tlyric ? 1 : 0)) - ((a.romalrc ? 1 : 0) + (a.tlyric ? 1 : 0)));
  return aligned[0];
}

/* QRC 逐字轨 → 行级 LRC：行头 [startMs,durMs] 转 [mm:ss.xx]，行内剔除每个字的 (ts,dur) 标签。
 * 逐字效果暂缓不做，但行级音译（日语罗马音等）对跟唱足够用。 */
function qrcToLineLrc(text) {
  if (!text) return '';
  // 可能的 base64 包装：解出来应以 [ 或 <?xml 开头
  let s = String(text);
  if (s[0] !== '[' && /^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 16) {
    try {
      const d = Buffer.from(s, 'base64').toString('utf8');
      if (d.indexOf('[') >= 0) s = d;
    } catch (e) {}
  }
  const out = [];
  for (const raw of s.split(/\r\n|\n|\r/)) {
    const m = /^\[(\d+),(\d+)\](.*)$/.exec(raw.trim());
    if (!m) continue;
    const body = m[3].replace(/\(\d+,\d+\)/g, '').trim();
    if (!body) continue;
    const sec = parseInt(m[1], 10) / 1000;
    const mm = Math.floor(sec / 60), ss = (sec % 60).toFixed(2);
    out.push('[' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(5, '0') + ']' + body);
  }
  return out.join('\n');
}

// QQ 官方源择优：信任 QQ 搜索的相关性排序，再用 歌名/歌手相似 + 时长锁定版本 二次打分。
// 短歌名/繁简差异（如“红”↔“紅…羅言”）会让 similarity 偏低，故阈值比网易云源宽松，主要靠排序 + 时长。
const QQ_MIN_SCORE = 0;
async function pickQQSong(title, artist, durationMs) {
  const queries = [];
  const ta = (String(title || '') + ' ' + String(artist || '')).trim();
  const t = String(title || '').trim();
  if (ta) queries.push(ta);
  if (t && t !== ta) queries.push(t);

  const pool = new Map();   // songmid -> { s, score }
  for (const q of queries) {
    let list;
    try { list = await qqSearch(q); } catch (e) { continue; }
    for (const s of (list || [])) {
      const mid = s.songmid;
      if (!mid) continue;
      const name = s.songname || '';
      let score = krc.similarity(title, name) * 0.5;          // 歌名相似为基础
      if (artist) {
        const hit = (s.singer || []).some((a) => krc.similarity(artist, a.name) >= 0.5);
        score += hit ? 0.7 : 0;                               // 歌手精确命中=最强信号（压倒时长）；不命中不降权（繁简/翻唱仍可能同曲）
      } else {
        score += 0.2;                                         // 无歌手信息：给中性小分
      }
      if (/\blive\b|翻唱|翻自|\bcover\b|伴奏|instrumental|\bdj\b|remix|demo|童声|儿歌|合唱/i.test(name)) score -= 0.2;  // 非原版/翻唱降权
      const rep = Number(durationMs) || 0;
      const cd = (Number(s.interval) || 0) * 1000;            // QQ interval 单位秒
      // 时长仅作“同歌手多版本”的辅助 tiebreaker：切歌瞬间 SMTC 时长可能未稳定，权重不宜压过歌手命中
      if (rep > 0 && cd > 0) {
        const diff = Math.abs(cd - rep);
        if (diff <= 2000) score += 0.25;
        else if (diff <= 6000) score += 0.15;
        else if (diff <= 15000) score += 0.05;
        else score -= 0.15;
      }
      const prev = pool.get(mid);
      if (!prev || score > prev.score) pool.set(mid, { s, score });
    }
  }
  const ranked = Array.from(pool.values())
    .filter((c) => c.score >= QQ_MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  let untimed = null;
  for (const cand of ranked.slice(0, 5)) {
    let lyr;
    try { lyr = await qqLyric(cand.s.songmid); } catch (e) { continue; }
    if (!lyr || !lyr.lyric) continue;
    const text = lyr.lyric;
    const meta = { title: cand.s.songname || title, artist: (cand.s.singer || []).map((a) => a.name).join('/') || artist };
    const lines = parseLrc(text);
    if (lines.length) {
      mergeTrackByTime(lines, lyr.trans, 'sub');
      mergeTrackByTime(lines, qrcToLineLrc(lyr.roma), 'roma');
      // QQ 官方翻译/音译轨经常为空（实测大量歌曲 trans len=0）：
      // 回退网易云 lyric/v1 的 tlyric/romalrc。候选按「与 QQ 主词时间轴重叠行数」决胜
      // （歌名相似会把结果带偏到翻唱版），重叠率 <60% 不补——宁缺毋滥。
      if (!lines.some((l) => l.sub) || !lines.some((l) => l.roma)) {
        try {
          const tr = await fetchNeteaseTracksFor(meta.title || title, meta.artist || artist, lines);
          if (tr) {
            if (!lines.some((l) => l.sub)) mergeTrackByTime(lines, tr.tlyric, 'sub');
            if (!lines.some((l) => l.roma)) mergeTrackByTime(lines, tr.romalrc, 'roma');
          }
        } catch (e) {}
      }
      return { lines, title: meta.title, artist: meta.artist };
    }
    if (!untimed) untimed = { text, score: cand.score, title: meta.title, artist: meta.artist };
  }
  if (untimed) return { untimedText: untimed.text, score: untimed.score, title: untimed.title, artist: untimed.artist };
  return null;
}

/* ---------------- 本地歌词缓存（应用自建，非 QQ 加密库） ----------------
 * QQ 自带本地歌词是 SQLCipher 加密库（qmlist64.db 头 16 字节是随机 salt、密钥仅在进程内存）读不出，
 * 故自建缓存来落地“优先走本地”：首次在线取词后按 key 落盘 <cacheDir>/<sha1(key)>.json，
 * 之后同一首歌直接命中——秒开、可离线、零请求。resolve 里最优先查缓存。
 * 设计：单条一文件（按需只读需要的那一个）、tmp+rename 原子写、超上限按 mtime 淘汰最旧。
 * cacheDir 为空（如脱离 Electron 单测）时全部降级为 no-op，不影响在线取词。
 */
const CACHE_MAX = 2000;
// 缓存格式版本：翻译/音译轨合并等影响 lines 内容的修复上线后 bump，
// 旧条目自然失效（文件名不同即孤立，无需删除）。
// v3：QQ lyric/trans HTML 实体反转义 + QQ 无翻译时网易云兜底 + 翻译轨声明文案过滤。
const CACHE_VER = 'v3';
function createLyricsCache(dir) {
  const noop = { get: () => null, put: () => {}, del: () => {}, dir: null };
  if (!dir) return noop;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return noop; }
  const fileOf = (key) => path.join(dir, crypto.createHash('sha1').update(CACHE_VER + ':' + String(key)).digest('hex') + '.json');
  let puts = 0;
  function prune() {
    try {
      const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
      if (names.length <= CACHE_MAX) return;
      const items = names.map((n) => {
        const p = path.join(dir, n);
        let m = 0; try { m = fs.statSync(p).mtimeMs; } catch (e) {}
        return { p, m };
      }).sort((a, b) => b.m - a.m);
      for (const it of items.slice(CACHE_MAX)) { try { fs.unlinkSync(it.p); } catch (e) {} }
    } catch (e) {}
  }
  return {
    dir,
    get(key) {
      if (!key) return null;
      try {
        const f = fileOf(key);
        if (!fs.existsSync(f)) return null;
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (j && Array.isArray(j.lines) && j.lines.length) { j.cached = true; return j; }
      } catch (e) {}
      return null;
    },
    put(res) {
      if (!res || !res.key || !Array.isArray(res.lines) || !res.lines.length) return;
      try {
        const f = fileOf(res.key);
        const tmp = f + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({
          key: res.key, title: res.title || '', artist: res.artist || '',
          source: res.source || '', lines: res.lines, ts: Date.now()
        }), 'utf8');
        fs.renameSync(tmp, f);            // 原子替换，避免半截文件被读到
        if ((++puts % 50) === 0) prune();
      } catch (e) {}
    },
    del(key) {
      if (!key) return;
      try { const f = fileOf(key); if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    },
  };
}

/* ---------------- 服务主体 ---------------- */
function createLyricsService(onLines, cacheDir) {
  const cache = createLyricsCache(cacheDir);
  let currentKey = null;
  let resolving = false;
  let pendingEv = null;       // 解析进行中到来的“最新”事件：切歌/下一曲时不丢失
  let onlineEnabled = true;   // 在线歌词兜底开关（桌面总控可关）
  let manual = null;          // 用户手动指定歌词 { key, payload }；切歌或重新匹配时自动失效
  let sodaLyricProvider = null; // 汽水原生歌词快照（registry.getSodaLyric 注入）

  function emit(payload) { if (onLines) { try { onLines(payload); } catch (e) {} } }

  // 用户手动歌词（搜索选定版本/粘贴 LRC）：绑定当前歌曲 key，覆盖自动匹配结果并广播全端；
  // 无时间轴的纯文本按当前歌曲时长合成。切到别的歌（handle 检测 key 变化）自动放弃，恢复自动匹配。
  function setManual(ev, text) {
    if (!ev || !ev.ok) return { ok: false, error: 'no-playing' };
    const key = ev.nid ? ('nid:' + ev.nid) : (ev.hash || ((ev.title || '') + '|' + (ev.artist || '')));
    if (!key) return { ok: false, error: 'no-key' };
    let lines = parseLrc(text);
    if (!lines.length) lines = synthesizeTimeline(text, Number(ev.durationMs) || 0);
    if (!lines.length) return { ok: false, error: 'empty' };
    const payload = { key, title: ev.title || '', artist: ev.artist || '', source: 'manual', lines };
    manual = { key, payload };
    emit(payload);
    return { ok: true, count: lines.length };
  }
  function clearManual() { manual = null; }

  // 串行解析 + 接力：解析旧歌时若切到新歌，记住最新事件；旧歌解析完立即接力新歌，
  // 并丢弃过期的旧歌结果（修复“切歌/下一曲后无歌词、需手动同步”）。
  function handle(ev, noCache) {
    if (!ev || !ev.ok) return;
    const key = ev.nid ? ('nid:' + ev.nid) : (ev.hash || ((ev.title || '') + '|' + (ev.artist || '')));
    if (!key || key === currentKey) return;
    if (manual && manual.key !== key) manual = null;   // 切歌：手动词只对原歌曲生效，新歌恢复自动匹配
    if (resolving) { pendingEv = ev; return; }   // 正在解析：暂存最新事件，完成后接力
    currentKey = key;
    resolving = true;
    resolve(ev, noCache).then((res) => {
      resolving = false;
      // 有效结果回写本地缓存（即便因切歌被丢弃未广播，也存下供下次秒开/离线）
      if (res && !res.cached && Array.isArray(res.lines) && res.lines.length && res.source !== 'none') cache.put(res);
      if (pendingEv) { drain(); return; }         // 已有更新的歌：丢弃旧结果，直接接力
      // 手动词优先：用户已为这首歌指定歌词时，后台自动匹配结果不覆盖
      if (manual && res && res.key === manual.key) return;
      if (res) emit(res);
    }).catch(() => { resolving = false; drain(); });
  }
  function drain() {
    if (!pendingEv) return;
    const p = pendingEv; pendingEv = null; currentKey = null;
    handle(p);
  }

  async function resolve(ev, noCache) {
    const hash = ev.hash || '';
    const nid = ev.nid || '';   // 精确歌曲 id：网易云纯数字 / 汽水 'soda:'+mediaId
    const neteaseNid = /^\d+$/.test(nid) ? nid : '';   // 仅纯数字 id 可直取网易云官方词
    const title = ev.title || '';
    const artist = ev.artist || '';
    const key = nid ? ('nid:' + nid) : (hash || (title + '|' + artist));
    if (!title && !hash && !nid) return null;

    // -1) 本地缓存最优先（应用自建，非 QQ 加密库）：命中即秒开、可离线、零请求。
    //     forceRefresh（用户点“重新匹配”）时传 noCache 跳过，取到新词后覆盖旧缓存。
    if (!noCache) {
      const c = cache.get(key);
      if (c) return c;
    }

    // -0.5) 汽水原生歌词：CDP transport 直取 sharedState 的歌词原文（krc/lrc）+ 独立翻译轨，
    //       与播放天然同源同轴（最准）。音译平台没有 → 按歌名/歌手「借」酷狗 KRC 音译轨补全。
    if (ev.playerId === 'qishui' && sodaLyricProvider) {
      try {
        const snap = sodaLyricProvider();
        if (snap && snap.lyricContent) {
          // 校验是同一首歌：nid(soda:mediaId) 精确匹配，或标题一致
          const sameSong = (nid && nid === 'soda:' + snap.mediaId) ||
            (snap.title && title && krc.similarity(title, snap.title) >= 0.8);
          if (sameSong) {
            let parsed = null;
            if (snap.lyricType === 'krc') {
              try { parsed = krc.krcToLines(snap.lyricContent); } catch (e) {}
            }
            const lines = parsed && parsed.lines && parsed.lines.length
              ? parsed.lines : parseLrc(snap.lyricContent);
            if (lines.length) {
              mergeTrackByTime(lines, snap.translationLrc, 'sub');
              // 借音译：主词无 roma 时，用本地酷狗 KRC 的音译轨按时间就近补
              if (!lines.some((l) => l.roma)) {
                try {
                  const kg = krc.findKugouLyrics(snap.title || title, snap.artist || artist);
                  if (kg && kg.lines) mergeLinesTimeNearest(lines, kg.lines, 'roma');
                } catch (e) {}
              }
              return { key, title: snap.title || title, artist: snap.artist || artist, source: 'soda', lines };
            }
          }
        }
      } catch (e) {}
    }

    // 0) 网易云精确 id：直接取官方逐行词（最准，规避同名不同版/翻唱；时间轴天然与网易云对齐）
    if (neteaseNid && onlineEnabled) {
      try {
        const full = await onlineLyricFull(neteaseNid);
        if (full.lrc) {
          const lines = parseLrc(full.lrc);
          if (lines.length) {
            mergeTrackByTime(lines, full.tlyric, 'sub');
            mergeTrackByTime(lines, full.romalrc, 'roma');
            return { key, title, artist, source: 'online', lines };
          }
          const synth = synthesizeTimeline(full.lrc, Number(ev.durationMs) || 0);
          if (synth.length) return { key, title, artist, source: 'online', lines: synth };
        }
      } catch (e) {}
    }
    // 1) 酷狗 hash 精确
    if (hash) {
      try {
        const r = krc.findKugouLyricsByHash(hash);
        if (r && r.lines && r.lines.length) return { key, title: r.title || title, artist: r.artist || artist, source: 'kugou-hash', lines: r.lines };
      } catch (e) {}
    }
    // 2) 本地 krc 歌名/歌手
    if (title) {
      try {
        const r = krc.findKugouLyrics(title, artist);
        if (r && r.lines && r.lines.length) return { key, title: r.title || title, artist: r.artist || artist, source: 'kugou-local', lines: r.lines };
      } catch (e) {}
    }
    // 3) QQ 音乐官方源（可开关关闭）：无精确 id 时优先——QQ 曲库最全、明文 LRC 与播放同源，
    //    按 歌名/歌手 搜索 + 时长锁定版本，比用网易云源给 QQ 配词更贴合（时间轴对齐 QQ 播放的版本）。
    if (title && onlineEnabled && !neteaseNid && !hash) {
      try {
        const picked = await pickQQSong(title, artist, ev.durationMs);
        if (picked) {
          if (picked.lines && picked.lines.length) {
            return { key, title: picked.title || title, artist: picked.artist || artist, source: 'qq', lines: picked.lines };
          }
          if (picked.untimedText && picked.score >= 1.0 && Number(ev.durationMs) > 0) {
            const lines = synthesizeTimeline(picked.untimedText, Number(ev.durationMs));
            if (lines.length) return { key, title: picked.title || title, artist: picked.artist || artist, source: 'qq', lines };
          }
        }
      } catch (e) {}
    }
    // 4) 网易云在线兜底（可开关关闭）：歌名为主择优，防歌手不准带偏
    if (title && onlineEnabled) {
      try {
        const picked = await pickOnlineSong(title, artist, ev.durationMs);
        if (picked) {
          if (picked.lines && picked.lines.length) {
            return { key, title: picked.title || title, artist: picked.artist || artist, source: 'online', lines: picked.lines };
          }
          // 无时间轴纯文本词兜底：高置信（歌名精确且歌手吻合，score≥1.0）+已知时长时，均匀合成时间轴
          if (picked.untimedText && picked.score >= 1.0 && Number(ev.durationMs) > 0) {
            const lines = synthesizeTimeline(picked.untimedText, Number(ev.durationMs));
            if (lines.length) return { key, title: picked.title || title, artist: picked.artist || artist, source: 'online', lines };
          }
        }
      } catch (e) {}
    }
    return { key, title, artist, source: 'none', lines: [] };
  }

  return {
    // 收到统一播放事件时调用；仅在歌曲 key 变化时重新解析（切歌自动接力）
    handleEvent: handle,
    // 手动强制重新取词（例如用户点了"重新匹配"）
    // noCache=true：跳过缓存读、强制重新在线取词并覆盖旧缓存（用户点“重新匹配”）；
    // 默认不跳：仍优先用本地缓存（跟随恢复/启动路径，保证断网也能秒出已缓存的词）
    forceRefresh(ev, noCache) {
      manual = null;   // 用户主动重新匹配＝放弃手动词
      currentKey = null; pendingEv = null;
      handle(ev, noCache);
    },
    // 用户手动指定歌词（搜索选版本/粘贴）；返回 {ok,count} 或 {ok:false,error}
    setManual,
    clearManual,
    // 在线歌词兜底开关
    setOnlineEnabled(v) { onlineEnabled = !!v; },
    // 汽水歌词快照注入（main 里挂 registry.getSodaLyric）
    setSodaLyricProvider(fn) { sodaLyricProvider = typeof fn === 'function' ? fn : null; },
    parseLrc,
  };
}

module.exports = { createLyricsService, parseLrc, pickOnlineSong, pickQQSong, synthesizeTimeline };
