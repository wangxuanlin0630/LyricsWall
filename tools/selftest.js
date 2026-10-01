/* tools/selftest.js — 打包前/改动后自检（不启动 Electron）
 * 校验：模块可加载、krc 解码、本地服务器 HTTP/WS/overlay、output-writer 落盘。
 * 用法：node tools/selftest.js   （或 npm run selftest）
 * 全部通过 exit 0，任一失败 exit 1。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name, extra) { results.push({ ok: true, name, extra: extra || '' }); }
function fail(name, err) { results.push({ ok: false, name, extra: String(err && err.message ? err.message : err) }); }

function checkLoad(name, fn) {
  try { fn(); pass('load ' + name); } catch (e) { fail('load ' + name, e); }
}

function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ code: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + p)); });
    req.on('error', reject);
  });
}

async function main() {
  // 1) 模块加载
  let createWallServer, createOutputWriter, createLyricsService, createPlayerManager, krc;
  checkLoad('server/http-server', () => { createWallServer = require(path.join(ROOT, 'server', 'http-server')).createWallServer; });
  checkLoad('server/output-writer', () => { createOutputWriter = require(path.join(ROOT, 'server', 'output-writer')).createOutputWriter; });
  checkLoad('lyrics-service', () => { createLyricsService = require(path.join(ROOT, 'lyrics-service')).createLyricsService; });
  checkLoad('players/registry', () => { createPlayerManager = require(path.join(ROOT, 'players', 'registry')).createPlayerManager; });
  checkLoad('krc', () => { krc = require(path.join(ROOT, 'krc')); });

  // 2) 前端/网页资源存在
  for (const f of ['src/index.html', 'src/app.js', 'src/bridge.js', 'src/animator.js', 'src/lrc.js', 'src/styles.css', 'web/overlay.html', 'tools/nowplaying-watch.ps1']) {
    if (fs.existsSync(path.join(ROOT, f))) pass('file ' + f);
    else fail('file ' + f, 'missing');
  }

  // 3) krc 解码
  try {
    const dir = krc.getKugouLyricDir();
    if (dir) {
      const one = fs.readdirSync(dir).find((f) => /\.krc$/i.test(f));
      if (one) {
        const r = krc.findKugouLyricsByHash ? null : null;
        const text = krc.decodeKrc(fs.readFileSync(path.join(dir, one)));
        const { lrc } = krc.krcToLrc(text);
        if (lrc && lrc.trim()) pass('krc decode', one);
        else fail('krc decode', 'empty lrc');
      } else pass('krc decode', 'no krc file (skip)');
    } else pass('krc decode', 'no lyric dir (skip)');
  } catch (e) { fail('krc decode', e); }

  // 4) 服务器 HTTP + WS + overlay
  if (createWallServer) {
    const server = createWallServer({ rootDir: ROOT });
    server.setStateProvider(() => ({ ok: true, source: 'smtc', playerId: 'selftest', status: 'playing', positionMs: 12000, durationMs: 200000, title: '自检曲目', artist: 'SelfTest', cover: '', hash: '', updatedMs: Date.now(), rate: 1, ts: Date.now() }));
    server.setLinesProvider(() => ({ lines: [{ time: 0, text: '自检行', duration: 4 }] }));
    let port = 0;
    try {
      port = await server.start();
      pass('server start', 'port=' + port);
    } catch (e) { fail('server start', e); }
    if (port) {
      try {
        const idx = await httpGet(port, '/');
        if (idx.code === 200 && /<html/i.test(idx.body)) pass('GET /');
        else fail('GET /', 'code=' + idx.code);
      } catch (e) { fail('GET /', e); }
      try {
        const now = await httpGet(port, '/api/now');
        const j = JSON.parse(now.body);
        if (now.code === 200 && j.ok && j.title === '自检曲目') pass('GET /api/now');
        else fail('GET /api/now', 'bad payload');
      } catch (e) { fail('GET /api/now', e); }
      try {
        const ov = await httpGet(port, '/overlay');
        if (ov.code === 200 && /overlay/i.test(ov.body)) pass('GET /overlay');
        else fail('GET /overlay', 'code=' + ov.code);
      } catch (e) { fail('GET /overlay', e); }
      // WS
      await new Promise((resolve) => {
        const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
        const timer = setTimeout(() => { fail('WS /ws', 'timeout'); try { ws.close(); } catch (e) {} resolve(); }, 3000);
        ws.on('message', (raw) => {
          let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
          if (m.type === 'state' || m.type === 'hello') {
            clearTimeout(timer);
            pass('WS /ws', m.type);
            try { ws.close(); } catch (e) {}
            resolve();
          }
        });
        ws.on('error', (e) => { clearTimeout(timer); fail('WS /ws', e); resolve(); });
      });
    }
    try { server.stop(); } catch (e) {}
  }

  // 5) output-writer 落盘（临时目录，不污染项目）
  if (createOutputWriter) {
    const tmp = path.join(os.tmpdir(), 'dtgc-selftest-out');
    const w = createOutputWriter({ outDir: tmp });
    w.update({ ok: true, playerId: 'selftest', status: 'playing', title: '自检', artist: 'T', positionMs: 61000, durationMs: 200000 });
    setTimeout(() => {}, 0);
    // update 是节流的：首次立即写
    try {
      const txt = fs.readFileSync(path.join(tmp, 'nowplaying.txt'), 'utf-8');
      const json = JSON.parse(fs.readFileSync(path.join(tmp, 'nowplaying.json'), 'utf-8'));
      if (/自检/.test(txt) && json.title === '自检') pass('output-writer');
      else fail('output-writer', 'bad content');
    } catch (e) { fail('output-writer', e); }
  }

  // 汇总
  let bad = 0;
  for (const r of results) {
    if (!r.ok) bad++;
    console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  (' + r.extra + ')' : ''));
  }
  console.log('\nselftest: ' + (bad === 0 ? 'ALL PASS' : bad + ' FAILED'));
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error('selftest crash:', e); process.exit(1); });
