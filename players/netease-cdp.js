/* players/netease-cdp.js — 网易云 CDP 适配器
 *
 * 原理：网易云界面是 CEF，带 --remote-debugging-port=9222 后，
 *       连 127.0.0.1:9222，在 orpheus:// 页面注入 JS 读取 Redux store
 *       的 playingState 和 DOM 进度条，获得真实播放进度。
 *
 * 与 netease-db.js 对比：CDP 有实时进度 + seek 自动感知；
 *       nedb 只有起点锚点 + seek 无法自动感知。
 * 两者共存：CDP 连上时优先，断线回退 nedb。
 */
'use strict';

const http = require('http');
const WebSocket = require('ws');

const PORT = 9222;
const POLL_MS = 300;
const RECONNECT_MS = 2500;
const EVAL_TIMEOUT_MS = 2500;

const JS_GET_PLAY_INFO = `(() => {
  try {
    const root = document.querySelector('#root');
    if (!root) return 'null: no root';
    let fiber = null;
    const ownKeys = Object.getOwnPropertyNames(root);
    for (let i = 0; i < ownKeys.length; i++) {
      if (ownKeys[i].startsWith('__reactContainer')) { fiber = root[ownKeys[i]]; break; }
    }
    if (!fiber) return 'null: no react container';

    let result = {
      playingState: 0,
      curPlaying: null,
      domTimeSec: -1,
      domSongName: '',
      domArtist: '',
      domCoverUrl: ''
    };

    try {
      let th = document.querySelector('.curtime-thumb');
      if (th) {
        let parts = (th.innerText || th.textContent).split('/');
        if (parts.length > 0) {
          let timeParts = parts[0].trim().split(':');
          if (timeParts.length === 2) {
            result.domTimeSec = parseInt(timeParts[0]) * 60 + parseInt(timeParts[1]);
          }
        }
      }
    } catch(e) {}

    try {
      let bar = document.querySelector('.default-bar-wrapper');
      if (bar) {
        let titleEl = bar.querySelector('.main-title');
        if (titleEl) {
          let t = titleEl.querySelector('.title');
          result.domSongName = (t || titleEl).textContent.trim();
        }
        let authorEl = bar.querySelector('.author');
        if (authorEl) result.domArtist = authorEl.textContent.trim();
        let coverImg = bar.querySelector('.miniVinylWrapper img');
        if (coverImg && coverImg.src) {
          let u = coverImg.src;
          // 剥掉 CEF 内部缓存协议壳：orpheus://cache/?<真实https URL>
          // —— 外层渲染进程与 /api/cover 代理都加载不了 orpheus:// 自定义协议
          const cachePrefix = 'orpheus://cache/?';
          if (u.indexOf(cachePrefix) === 0) u = u.substring(cachePrefix.length);
          let idx = u.indexOf('thumbnail=');
          if (idx > -1) {
            let end = u.indexOf('&', idx);
            u = u.substring(0, idx) + 'thumbnail=300y300' + (end > -1 ? u.substring(end) : '');
          }
          // 非 http(s) 一律丢弃，让下方 track.album.picUrl 直连地址兜底
          if (/^https?:/i.test(u)) result.domCoverUrl = u;
        }
      }
    } catch(e) {}

    let storeFound = false;
    function walk(node, depth) {
      if (!node || depth > 80 || storeFound) return;
      if (node.memoizedProps && node.memoizedProps.store && typeof node.memoizedProps.store.getState === 'function') {
        try {
          const st = node.memoizedProps.store.getState();
          if (st['playing']) {
            const playing = st['playing'];
            result.playingState = playing.playingState;
            result.curPlaying = playing.curPlaying;
            storeFound = true;
            return;
          }
        } catch(e) {}
      }
      walk(node.child, depth + 1);
      if (!storeFound) walk(node.sibling, depth + 1);
    }
    walk(fiber, 0);

    if (!storeFound) return 'null: store not found';
    return JSON.stringify(result);
  } catch(e) {
    return 'Exception: ' + e.message;
  }
})()`;

function createNeteaseCdpAdapter(onEvent, opts) {
  const onPortClosed = (opts && opts.onPortClosed) || null;
  let ws = null;
  let msgId = 0;
  let pending = new Map();
  let pollTimer = null;
  let reconnTimer = null;
  let inflight = false;
  let running = false;
  let lastAvail = null;
  // 秒级进度防抖：DOM 只有整秒（.curtime-thumb "mm:ss"），若每帧都刷新 updatedMs，
  // 渲染端插值会每 300ms 被重置回整秒点 → 歌词系统性慢半拍（实测"网易云歌词有延迟"）。
  // 改为：秒值变化那一刻才记 updatedMs=此刻、position=新秒；秒值不变则保持旧 updatedMs，
  // 让客户端插值自然推进，直到下一秒 tick 校准——最坏误差=轮询间隔而非整秒。
  let lastSec = -1;
  let lastSecChangeMs = 0;

  function emit(ev) { if (onEvent) { try { onEvent(ev); } catch (e) {} } }

  function setAvail(ok, reason) {
    const key = ok ? 'ok' : ('no:' + reason);
    if (lastAvail === key) return;
    const prev = lastAvail;
    lastAvail = key;
    if (!ok) emit({ ok: false, reason });
    if (!ok && reason === 'port-closed' && prev !== 'no:port-closed') {
      try { if (onPortClosed) onPortClosed(); } catch (e) {}
    }
  }

  function httpGetJson(path) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad json')); }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    });
  }

  function pickTarget(pages) {
    if (!Array.isArray(pages) || !pages.length) return null;
    let target = null;
    for (const p of pages) {
      if (p.type === 'page' && String(p.url || '').startsWith('orpheus://') && !String(p.url).includes('notrack=true')) {
        target = p;
        if (String(p.url).includes('core') || String(p.url).includes('main')) break;
      }
    }
    if (!target) {
      for (const p of pages) {
        if (p.type === 'page' && String(p.url || '').startsWith('orpheus://')) { target = p; break; }
      }
    }
    // 严格化：不再 fallback 到任意 page——9222 若被别的程序占用（如本应用自己的调试实例），
    // fallback 会把表达式注入到错误目标，表现为"有端口没数据"，且永远不会触发守卫重启。
    return target;
  }
  // 端口有人应答但一个 orpheus 页面都没有 → 端口被别的程序占用
  function isWrongOwner(list) {
    return Array.isArray(list) && list.length > 0 &&
      !list.some((t) => t.type === 'page' && String(t.url || '').startsWith('orpheus://'));
  }

  function send(method, params) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('ws not open'));
      const id = ++msgId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('cdp timeout: ' + method));
      }, EVAL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  function onMessage(raw) {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || 'cdp error'));
      else p.resolve(m.result);
    }
  }

  async function connect() {
    let pages;
    try {
      pages = await httpGetJson('/json');
    } catch (e) {
      setAvail(false, 'port-closed');
      scheduleReconnect();
      return;
    }
    const target = pickTarget(pages);
    if (!target || !target.webSocketDebuggerUrl) {
      // 端口被占（无 orpheus 页面）：视同端口不可用，让守卫进程评估是否重启网易云
      if (isWrongOwner(pages)) {
        setAvail(false, 'port-closed');
      } else {
        setAvail(false, 'no-target');
      }
      scheduleReconnect();
      return;
    }
    setAvail(true);
    ws = new WebSocket(target.webSocketDebuggerUrl, { headers: {} });
    ws.on('open', async () => {
      try { await send('Runtime.enable', {}); } catch (e) {}
      startPoll();
    });
    ws.on('message', onMessage);
    ws.on('close', () => { cleanupWs(); scheduleReconnect(); });
    ws.on('error', () => {});
  }

  function cleanupWs() {
    if (ws) { try { ws.removeAllListeners(); ws.terminate(); } catch (e) {} ws = null; }
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    stopPoll();
  }

  function scheduleReconnect() {
    if (!running) return;
    if (reconnTimer) return;
    reconnTimer = setTimeout(() => {
      reconnTimer = null;
      // connect 是 async：内部任何未捕获异常都必须回到重连链，否则循环静默死掉
      if (running) Promise.resolve(connect()).catch(() => scheduleReconnect());
    }, RECONNECT_MS);
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(pollOnce, POLL_MS);
    pollOnce();
  }
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function pollOnce() {
    if (inflight || !ws || ws.readyState !== WebSocket.OPEN) return;
    inflight = true;
    try {
      const r = await send('Runtime.evaluate', {
        expression: JS_GET_PLAY_INFO,
        returnByValue: true,
      });
      const val = r && r.result ? r.result.value : null;
      if (!val || typeof val !== 'string') {
        emit({ ok: false, source: 'cdp', reason: 'empty-eval', ts: Date.now() });
        inflight = false;
        return;
      }
      if (val.startsWith('null:') || val.startsWith('Exception:')) {
        emit({ ok: false, source: 'cdp', reason: val, ts: Date.now() });
        inflight = false;
        return;
      }
      let data;
      try { data = JSON.parse(val); } catch (e) {
        emit({ ok: false, source: 'cdp', reason: 'bad-json', ts: Date.now() });
        inflight = false;
        return;
      }

      const playingState = Number(data.playingState || 0);
      const status = playingState === 2 ? 'playing' : (playingState === 1 ? 'paused' : 'stopped');

      let title = String(data.domSongName || '');
      let artist = String(data.domArtist || '');
      let cover = String(data.domCoverUrl || '');
      let nid = '';
      let durationMs = 0;

      if (data.curPlaying && data.curPlaying.track) {
        const track = data.curPlaying.track;
        if (!title) title = String(track.name || '');
        if (!artist) artist = (track.artists || []).map((a) => a.name).join(' / ');
        if (!cover) cover = String(track.album && track.album.picUrl || '');
        nid = String(data.curPlaying.id || '');
        durationMs = Number(track.duration || 0);
      }

      let positionMs = 0;
      const domTimeSec = Number(data.domTimeSec || -1);
      if (domTimeSec >= 0) {
        positionMs = Math.round(domTimeSec * 1000);
      }
      // 秒级防抖：只在秒值变化时刷新锚点（切歌/seek 时秒值必变，天然覆盖）
      const now = Date.now();
      let anchorMs = lastSecChangeMs;
      if (domTimeSec >= 0 && domTimeSec !== lastSec) {
        lastSec = domTimeSec;
        lastSecChangeMs = now;
        anchorMs = now;
      }
      if (domTimeSec < 0) { lastSec = -1; anchorMs = now; }   // 读不到进度：不防抖
      if (status !== 'playing') anchorMs = now;               // 非播放态：不依赖插值

      emit({
        ok: true,
        source: 'cdp',
        playerId: 'netease',
        status,
        positionMs,
        durationMs,
        title,
        artist,
        album: '',
        cover,
        hash: nid,
        nid,
        updatedMs: anchorMs || now,
        rate: 1,
        ts: Date.now(),
      });
    } catch (e) {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        // ws 已断，cleanup 会处理
      } else {
        emit({ ok: false, source: 'cdp', reason: String(e && e.message || e), ts: Date.now() });
      }
    } finally {
      inflight = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      connect();
    },
    stop() {
      running = false;
      cleanupWs();
      if (reconnTimer) { clearTimeout(reconnTimer); reconnTimer = null; }
    },
  };
}

module.exports = { createNeteaseCdpAdapter };
