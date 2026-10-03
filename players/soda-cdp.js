/* players/soda-cdp.js — 汽水音乐 CDP 适配器（对齐 PlayerCap sodamusic）
 *
 * 原理：汽水音乐是 Electron 且有反调试（argv 加 --remote-debugging-port 会自杀），
 *       不能走网易云「重启加参数」那条路。改用 soda-patcher.js 复刻 Node 的
 *       process._debugProcess(pid) 激活主进程 Node inspector（127.0.0.1:9229），
 *       然后连主进程 inspector，在主进程里 webContents.executeJavaScript 桥进
 *       rendererMain 主窗口，向字节 transport 服务请求 sharedState.get('player')
 *       拿全量播放态（进度/状态/歌名/歌手/封面 + 歌词原文与翻译轨）。
 *
 * 与网易云 CDP 的关键差异：
 *   - 端口 9222(renderer DevTools) → 9229(主进程 Node inspector)；端点 /json → /json/list。
 *   - 目标是主进程 Node context，没有 DOM；取渲染器数据必须 executeJavaScript 桥过去，
 *     故一律 awaitPromise:true、includeCommandLineAPI:true（Node inspector 经它暴露 require）。
 *   - 每次取数顺带 setBackgroundThrottling(false)：汽水最小化约 5 分钟后 Chromium 会把
 *     进度回调节流到 1/60Hz，seek/暂停最长 60s 才被发现（PlayerCap §7.7.2 实测）。
 */
'use strict';

const http = require('http');
const WebSocket = require('ws');

const PORT = 9229;
const POLL_MS = 300;
const RECONNECT_MS = 2500;
const EVAL_TIMEOUT_MS = 9000;   // 桥=主进程 evaluate + executeJavaScript + 内层 2500ms 兜底，须比单跳长

/* 内层探针（在汽水 rendererMain 窗口里跑）：
 * patch MessagePort.postMessage 抓 transportPort 的 channel.port1 →
 * 发 method.invoke 请求 sharedState.get('player') → 截 method.return 归一化返回。
 *
 * **必须保持纯 ASCII**：bridgeExpr 用 base64 内嵌它、页面里 atob 解回，atob 只认
 * Latin-1，任何中文都会乱码 → JS 解析失败 → inspector 直接掐断 WS（PlayerCap 实测）。
 * cleanup 必须先于任何可能抛出的语句就位，且每条返回路径都走它——否则监听器会永久
 * 挂在汽水的 port1 上，随轮询单向堆积（PlayerCap 踩过的坑，原样规避）。
 */
const INNER_PROBE_JS = `(function(){return new Promise(function(resolve){
var cleanup=function(){};
try{
var proto=MessagePort.prototype;var orig=proto.postMessage;var port=null;
proto.postMessage=function(){port=this;return orig.apply(this,arguments);};
try{window.transportPort.sendTransport({__sodaCap:1});}catch(e){}
proto.postMessage=orig;
if(!port){resolve({err:'no-port'});return;}
cleanup=function(){try{port.removeEventListener('message',onMsg);}catch(e){}};
var reqId='sodaget-'+Math.random().toString(36).slice(2)+Date.now();
var done=false;
var onMsg=function(e){
var d=e.data;
if(!d||d.type!=='method.return'||d.requestId!==reqId)return;
done=true;cleanup();
var r=d.return;
if(!r||r.type!=='success'){resolve({err:'ret'});return;}
var p=r.result||{};var md=p.mediaDetail||{};var pl=md.playable||{};var ly=md.lyrics||{};var al=pl.album||{};
var cover='';var cu=pl.cover_url;
if(typeof cu==='string'){cover=cu;}
else if(cu&&cu.uri&&cu.urls&&cu.urls.length){cover=cu.urls[0]+cu.uri+'~'+(cu.template_prefix||'')+'-crop-center:800:800.jpg';}
var artists=[];var pa=pl.artists||[];
for(var i=0;i<pa.length;i++){if(pa[i]&&pa[i].name)artists.push(pa[i].name);}
resolve({
ok:true,
isPlaying:!!p.isPlaying,isLoading:!!p.isLoading,
progressSeconds:p.progressSeconds,durationSeconds:p.durationSeconds,
mediaId:(p.mediaId!=null?String(p.mediaId):(pl.id!=null?String(pl.id):'')),
name:pl.name||'',album:(al.name||''),artists:artists,coverUrl:cover,
lyricType:ly.type||'',lyricContent:ly.content||'',
translationLrc:((ly.translations&&typeof ly.translations==='object'&&ly.translations.cn)?ly.translations.cn:'')
});
};
port.addEventListener('message',onMsg);
setTimeout(function(){if(!done){cleanup();resolve({err:'timeout'});}},2500);
try{window.transportPort.sendTransport({type:'method.invoke',fromWorkerId:'rendererMain',toServiceId:'sharedState',methodName:'get',requestId:reqId,arguments:['player'],callbacks:{}});}
catch(e){cleanup();resolve({err:'send:'+String(e&&e.message||e)});return;}
}catch(e){cleanup();resolve({err:'ex:'+String(e&&e.message||e)});}
});})()`;

/* 主进程侧表达式：找 rendererMain 主窗口 → executeJavaScript(内层探针) → JSON.stringify。
 * setBackgroundThrottling(false) 每次都重申：开关随 webContents 生命周期存在，汽水一旦
 * 重建主窗口就回到默认节流态；放在取数路径里天然自愈（只对真正读的那一个窗口生效）。
 * 这是唯一会改变汽水行为的调用，进程退出即失效、不写内存不碰 argv（PlayerCap §0.1 例外）。
 */
function bridgeExpr() {
  const b64 = Buffer.from(INNER_PROBE_JS, 'utf8').toString('base64');
  return "(async()=>{" +
    "const {webContents}=require('electron');" +
    "const all=webContents.getAllWebContents();" +
    "let target=null;" +
    "for(const wc of all){try{const u=wc.getURL()||'';if(u.indexOf('main.html')>=0){target=wc;break;}}catch(e){}}" +
    "if(!target){for(const wc of all){try{const u=wc.getURL()||'';if(u.indexOf('taskbar')<0&&u.indexOf('.html')>=0){target=wc;break;}}catch(e){}}}" +
    "if(!target)return JSON.stringify({err:'no-main-window'});" +
    "let bt=null;try{target.setBackgroundThrottling(false);bt=target.backgroundThrottling;}catch(e){}" +
    "try{const r=await target.executeJavaScript(atob(\"" + b64 + "\"),true);" +
    "if(r&&typeof r==='object')r.throttled=bt;return JSON.stringify(r);}" +
    "catch(e){return JSON.stringify({err:'exec:'+String(e&&e.message||e)});}" +
    "})()";
}

function createSodaCdpAdapter(onEvent, opts) {
  const onPortClosed = (opts && opts.onPortClosed) || null;
  let ws = null;
  let msgId = 0;
  let pending = new Map();
  let pollTimer = null;
  let reconnTimer = null;
  let inflight = false;
  let running = false;
  let lastAvail = null;
  let lastLyric = null;   // 最近一次带歌词的快照 {mediaId,lyricType,lyricContent,translationLrc,updatedMs}

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

  // 主进程 inspector 只有一个 node 目标（electron/js2c/browser_init）。取第一个 node 型。
  function pickTarget(list) {
    if (!Array.isArray(list) || !list.length) return null;
    for (const t of list) {
      if (t.type === 'node' && t.webSocketDebuggerUrl) return t;
    }
    return list[0] || null;
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
    let list;
    try {
      list = await httpGetJson('/json/list');
    } catch (e) {
      setAvail(false, 'port-closed');
      scheduleReconnect();
      return;
    }
    const target = pickTarget(list);
    if (!target || !target.webSocketDebuggerUrl) {
      setAvail(false, 'no-target');
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
        expression: bridgeExpr(),
        includeCommandLineAPI: true,   // Node inspector 经 Command Line API 暴露 require
        returnByValue: true,
        awaitPromise: true,
        timeout: 8000,
      });
      const val = r && r.result ? r.result.value : null;
      if (!val || typeof val !== 'string') {
        emit({ ok: false, source: 'cdp', reason: 'empty-eval', ts: Date.now() });
        return;
      }
      let data;
      try { data = JSON.parse(val); } catch (e) {
        emit({ ok: false, source: 'cdp', reason: 'bad-json', ts: Date.now() });
        return;
      }
      if (!data.ok) {
        emit({ ok: false, source: 'cdp', reason: data.err || 'extract-fail', ts: Date.now() });
        return;
      }

      const mediaId = String(data.mediaId || '');
      const title = String(data.name || '');
      // 无曲目（媒体详情为空）：视为 stopped
      if (!mediaId && !title) {
        lastLyric = null;
        emit({
          ok: true, source: 'cdp', playerId: 'qishui', status: 'stopped',
          positionMs: 0, durationMs: 0, title: '', artist: '', album: '',
          cover: '', hash: '', nid: '', updatedMs: Date.now(), rate: 1, ts: Date.now(),
        });
        return;
      }

      // 歌词快照：只在内容变化时更新（mediaId 或歌词文本变了才换），供歌词服务按 nid 取
      if (data.lyricContent) {
        if (!lastLyric || lastLyric.mediaId !== mediaId || lastLyric.lyricContent !== data.lyricContent) {
          lastLyric = {
            mediaId,
            lyricType: String(data.lyricType || ''),
            lyricContent: String(data.lyricContent || ''),
            translationLrc: String(data.translationLrc || ''),
            title,
            artist: (data.artists || []).join('/'),
            updatedMs: Date.now(),
          };
        }
      }

      emit({
        ok: true,
        source: 'cdp',
        playerId: 'qishui',
        status: data.isPlaying ? 'playing' : 'paused',
        positionMs: Math.round(Number(data.progressSeconds || 0) * 1000),
        durationMs: Math.round(Number(data.durationSeconds || 0) * 1000),
        title,
        artist: (data.artists || []).join('/'),
        album: String(data.album || ''),
        cover: String(data.coverUrl || ''),
        hash: '',
        nid: mediaId ? ('soda:' + mediaId) : '',
        updatedMs: Date.now(),
        rate: 1,
        ts: Date.now(),
      });
    } catch (e) {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        // ws 已断，close 事件会清理
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
      lastLyric = null;
    },
    // 歌词服务用：返回最近一次汽水歌词快照 {mediaId,lyricType,lyricContent,translationLrc,...} 或 null
    getLyric() { return lastLyric; },
  };
}

module.exports = { createSodaCdpAdapter };
