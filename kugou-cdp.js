/**
 * kugou-cdp.js — 酷狗实时播放进度读取器（主进程常驻模块）
 *
 * 原理（与 tools/cdp-probe.js 同源，已实测验证）：
 *   酷狗界面是 CEF/Chromium 内核。对 libcef.dll 打一次性补丁后，酷狗会在
 *   127.0.0.1:12233 常开 DevTools 调试端口。本模块连上该端口，在酷狗
 *   desktop-popup 页面里调用 external.SuperCall(864)，读取真实播放信息：
 *     progress  —— 单位 100 纳秒（1 秒 = 1e7），实测每秒递增 ~1e7
 *     duration  —— 单位毫秒
 *     play_status / hash / filename / cover
 *
 * 本模块【只读】：只调用 SuperCall(864) 查询，不向酷狗页面注入任何修改、
 * 不触发导航、不写任何酷狗文件。端口未开（未打补丁/酷狗未启动）时静默
 * 降级为 unavailable，由上层回退到 SMTC 估算，不影响原有功能。
 */
'use strict';

const http = require('http');
const WebSocket = require('ws');

const PORT = 12233;
const POLL_MS = 300;          // 轮询间隔；两次轮询之间由上层线性插值
const RECONNECT_MS = 2500;    // 断线重连间隔
const EVAL_TIMEOUT_MS = 2500; // 单次 evaluate 超时

// 与探针一致的取播放信息脚本（Promise 包装 SuperCall(864)）
const JS_GET_PLAY_INFO = `
new Promise(function(resolve) {
    var jname = "kgtmp_gpi_" + Date.now();
    window[jname] = function(data) {
        window[jname] = null;
        resolve(typeof data === "string" ? data : JSON.stringify(data));
    };
    try { external.SuperCall(864, JSON.stringify({callback: jname})); }
    catch(e) { resolve(""); }
    setTimeout(function() { resolve(""); }, 3000);
})
`;

// "Artist - Title" → {artist,title}
function splitFilename(filename) {
  const s = String(filename || '').trim();
  const i = s.indexOf(' - ');
  if (i > 0) return { artist: s.slice(0, i).trim(), title: s.slice(i + 3).trim() };
  return { artist: '', title: s };
}

function createKugouCdp(onEvent, opts) {
  const onPortClosed = (opts && opts.onPortClosed) || null;
  let ws = null;
  let msgId = 0;
  let pending = new Map();       // id -> {resolve,reject,timer}
  let pollTimer = null;
  let reconnTimer = null;
  let inflight = false;
  let running = false;
  let lastAvail = null;          // 上次上报的可用性，避免重复刷屏

  function emit(ev) { if (onEvent) { try { onEvent(ev); } catch (e) {} } }

  function setAvail(ok, reason) {
    const key = ok ? 'ok' : ('no:' + reason);
    if (lastAvail === key) return;
    const prev = lastAvail;
    lastAvail = key;
    if (!ok) emit({ ok: false, reason });
    // 端口关闭回调：只在「可用→不可用」跳变或首次判定时触发一次（不随每轮重连重复）
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
    return (
      pages.find((p) => p.type === 'page' && /desktop-popup/.test(p.url || '')) ||
      pages.find((p) => p.type === 'page' && /desktop/i.test(p.title || '')) ||
      pages.find((p) => p.type === 'page') ||
      pages[0]
    );
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
      setAvail(false, 'port-closed'); // 端口未开：未打补丁或酷狗未启动
      scheduleReconnect();
      return;
    }
    const target = pickTarget(pages);
    if (!target || !target.webSocketDebuggerUrl) {
      setAvail(false, 'no-target');
      scheduleReconnect();
      return;
    }
    setAvail(true);
    ws = new WebSocket(target.webSocketDebuggerUrl, { headers: {} }); // 不发 Origin
    ws.on('open', async () => {
      try { await send('Runtime.enable', {}); } catch (e) {}
      startPoll();
    });
    ws.on('message', onMessage);
    ws.on('close', () => { cleanupWs(); scheduleReconnect(); });
    ws.on('error', () => { /* close 会跟进 */ });
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
      if (running) connect();
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
        awaitPromise: true,
      });
      const val = r && r.result ? r.result.value : null;
      if (!val) {
        emit({ ok: true, source: 'cdp', status: 'nosong', ts: Date.now() });
        return;
      }
      let info;
      try { info = JSON.parse(val); } catch (e) { return; }
      if (!info || typeof info !== 'object') return;

      // 单位换算（实测）：progress 为 100ns → ms 除 1e4；duration 已是 ms
      const progressMs = Math.round(Number(info.progress || 0) / 1e4);
      const durationMs = Math.round(Number(info.duration || 0));
      const st = String(info.play_status || '');
      const status = st === 'playing' ? 'playing' : st === 'paused' ? 'paused' : 'stopped';
      const { artist, title } = splitFilename(info.filename);

      emit({
        ok: true,
        source: 'cdp',
        status,
        progressMs,
        durationMs,
        hash: String(info.hash || ''),
        title,
        artist,
        cover: String(info.cover || ''),
        ts: Date.now(),
      });
    } catch (e) {
      // 单次失败忽略，下次轮询重试；持续失败由 ws close 触发重连
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
      if (reconnTimer) { clearTimeout(reconnTimer); reconnTimer = null; }
      stopPoll();
      cleanupWs();
      lastAvail = null;
    },
  };
}

module.exports = { createKugouCdp, PORT };
