/* server/http-server.js — 内置本地服务器（功能 5 API + 网页多端 + OBS 源）
 *
 * - 静态托管 src/（同一套 UI 跑在浏览器）与 web/（overlay 叠加页）。
 * - GET /api/now            当前播放 JSON
 * - GET /api/lyrics         按歌名/歌手取词
 * - GET /api/lyricsByHash   按酷狗 hash 取词
 * - GET /api/cover          当前封面（本地文件直读 / 远程 URL 代理）
 * - WS  /ws                 广播统一播放状态 + 歌词行，供网页/手机/OBS 多端同步
 *
 * 默认端口 8787，绑定 0.0.0.0（局域网可达）；端口被占自动 +1 重试若干次。
 * 全部只读输出，不接受任何会修改播放器/文件的请求。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const BASE_PORT = 8787;
const PORT_TRIES = 5;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.eot': 'application/vnd.ms-fontobject',
};

function createWallServer(opts = {}) {
  const rootDir = opts.rootDir || path.join(__dirname, '..');
  const srcDir = path.join(rootDir, 'src');
  const webDir = path.join(rootDir, 'web');

  let server = null;
  let wss = null;
  let port = BASE_PORT;
  let host = '0.0.0.0';            // LAN 开则 0.0.0.0，关则 127.0.0.1（setHost + restart 生效）
  let getState = () => null;         // 由 main 注入：返回统一播放快照
  let getLines = () => null;         // 由 main 注入：返回当前歌词 {lines,title,artist,source}
  let getConfig = () => null;        // 由 main 注入：返回布局/开关配置
  let getBg = () => null;            // 由 main 注入：返回自定义背景图 {file} 或 null
  let getFont = () => null;          // 由 main 注入：返回当前选中本机字体文件 {file} 或 null
  let getPin = () => null;           // 由 main 注入：返回手动指定的歌词 {idx,text} 或 null
  let lastState = null;
  let lastLines = null;
  let lastConfig = null;
  let lastPin = null;

  function clients() { return wss ? wss.clients : new Set(); }
  function send(obj) {
    const msg = JSON.stringify(obj);
    for (const c of clients()) {
      if (c.readyState === 1) { try { c.send(msg); } catch (e) {} }
    }
  }

  function safeJoin(base, urlPath) {
    const p = path.normalize(path.join(base, urlPath));
    if (!p.startsWith(base)) return null;   // 防路径穿越
    return p;
  }

  function serveFile(res, filePath, extraHeaders) {
    fs.readFile(filePath, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
      if (extraHeaders) Object.assign(headers, extraHeaders);
      res.writeHead(200, headers);
      res.end(buf);
    });
  }

  function serveCover(res, cover) {
    if (!cover) { res.writeHead(404); res.end('no cover'); return; }
    if (/^https?:\/\//i.test(cover)) {
      const mod = cover.startsWith('https') ? https : http;
      mod.get(cover, (up) => {
        res.writeHead(up.statusCode || 200, { 'Content-Type': up.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'no-cache' });
        up.pipe(res);
      }).on('error', () => { res.writeHead(502); res.end('cover proxy error'); });
      return;
    }
    serveFile(res, cover);
  }

  function handleRequest(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    try {
      if (p === '/' || p === '/index.html') { return serveFile(res, path.join(srcDir, 'index.html')); }
      if (p === '/overlay' || p === '/overlay.html') { return serveFile(res, path.join(webDir, 'overlay.html')); }

      if (p === '/api/now') {
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(getState() || { ok: false }));
        return;
      }
      if (p === '/api/lines') {
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(getLines() || { lines: [] }));
        return;
      }
      if (p === '/api/config') {
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(getConfig() || {}));
        return;
      }
      if (p === '/api/cover') {
        const st = getState();
        return serveCover(res, st && st.cover);
      }
      if (p === '/api/bg-custom') {
        const b = getBg();
        if (!b || !b.file || !fs.existsSync(b.file)) { res.writeHead(404); res.end('no bg'); return; }
        return serveFile(res, b.file);
      }
      if (p === '/api/font') {
        const f = getFont();
        if (!f || !f.file || !fs.existsSync(f.file)) {
          res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('no font'); return;
        }
        // @font-face 跨源加载需 CORS 头，否则局域网终端无法加载字体
        return serveFile(res, f.file, { 'Access-Control-Allow-Origin': '*' });
      }
      if (p === '/api/lyrics') {
        const title = u.searchParams.get('title') || '';
        const artist = u.searchParams.get('artist') || '';
        const krc = require('../krc');
        const r = krc.findKugouLyrics(title, artist);
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(r || { error: 'not found' }));
        return;
      }
      if (p === '/api/lyricsByHash') {
        const hash = u.searchParams.get('hash') || '';
        const krc = require('../krc');
        const r = krc.findKugouLyricsByHash(hash);
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(r || { error: 'not found' }));
        return;
      }

      // 静态：先 src/ 再 web/
      let fp = safeJoin(srcDir, p);
      if (fp && fs.existsSync(fp) && fs.statSync(fp).isFile()) return serveFile(res, fp);
      fp = safeJoin(webDir, p);
      if (fp && fs.existsSync(fp) && fs.statSync(fp).isFile()) return serveFile(res, fp);

      res.writeHead(404); res.end('not found');
    } catch (e) {
      res.writeHead(500); res.end('server error');
    }
  }

  function tryListen(tryPort, triesLeft, resolve, reject) {
    const srv = http.createServer(handleRequest);
    srv.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && triesLeft > 0) {
        tryListen(tryPort + 1, triesLeft - 1, resolve, reject);
      } else {
        reject(err);
      }
    });
    srv.listen(tryPort, host, () => {
      server = srv;
      port = tryPort;
      // WS 升级
      wss = new WebSocketServer({ noServer: true });
      srv.on('upgrade', (req, socket, head) => {
        const up = new URL(req.url, 'http://localhost');
        if (up.pathname !== '/ws') { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      });
      wss.on('connection', (ws) => {
        // 新连接立即推送当前状态、歌词与配置
        try { ws.send(JSON.stringify({ type: 'state', data: getState() || { ok: false } })); } catch (e) {}
        try { ws.send(JSON.stringify({ type: 'lines', data: getLines() || { lines: [] } })); } catch (e) {}
        try { ws.send(JSON.stringify({ type: 'config', data: getConfig() || {} })); } catch (e) {}
        try { ws.send(JSON.stringify({ type: 'pin', data: getPin() || null })); } catch (e) {}
        try { ws.send(JSON.stringify({ type: 'hello', port })); } catch (e) {}
      });
      resolve(port);
    });
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        tryListen(BASE_PORT, PORT_TRIES - 1, resolve, reject);
      });
    },
    stop() {
      try { if (wss) wss.close(); } catch (e) {}
      try { if (server) server.close(); } catch (e) {}
      server = null; wss = null;
    },
    port() { return port; },
    setStateProvider(fn) { getState = fn || (() => null); },
    setLinesProvider(fn) { getLines = fn || (() => null); },
    setConfigProvider(fn) { getConfig = fn || (() => null); },
    setBgProvider(fn) { getBg = fn || (() => null); },
    setFontProvider(fn) { getFont = fn || (() => null); },
    setPinProvider(fn) { getPin = fn || (() => null); },
    // LAN 开关：改变绑定地址（需配合 restart 生效）
    setHost(h) { host = (h === '127.0.0.1') ? '127.0.0.1' : '0.0.0.0'; },
    // 重新监听（切换 host 后调用）；返回新端口
    restart() {
      this.stop();
      return this.start();
    },
    // main 调用：广播统一播放状态
    broadcastState(state) {
      lastState = state;
      send({ type: 'state', data: state });
    },
    // main 调用：广播歌词行
    broadcastLines(payload) {
      lastLines = payload;
      send({ type: 'lines', data: payload });
    },
    // main 调用：广播布局/开关配置
    broadcastConfig(cfg) {
      lastConfig = cfg;
      send({ type: 'config', data: cfg });
    },
    // main 调用：广播手动指定歌词（pin），手动优先级高于自动跟随
    broadcastPin(pin) {
      lastPin = pin;
      send({ type: 'pin', data: pin });
    },
    snapshot() { return lastState; },
  };
}

module.exports = { createWallServer, BASE_PORT };
