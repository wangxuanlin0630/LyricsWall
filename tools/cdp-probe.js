/* 只读探针：验证能否通过 CDP 从酷狗读到实时播放进度。
 * 不修改任何东西。前提：已用 patch-kugou.js 打好补丁，且酷狗正在播放歌曲。
 *
 * 用法： node tools\cdp-probe.js [采样次数，默认12]
 * 运行时你可以在酷狗里拖动进度条，观察 progress 是否实时跳变。
 */
const http = require('http');
const WebSocket = require('ws');

const PORT = 12233;
const SAMPLES = parseInt(process.argv[2] || '12', 10);

// 与 PlayerCap 相同的取值 JS：调用 external.SuperCall(864) 并用 Promise 等回调
const JS_GET_PLAY_INFO = `
new Promise(function(resolve) {
    var jname = "kgtmp_gpi_" + Date.now();
    window[jname] = function(data) {
        window[jname] = null;
        resolve(typeof data === "string" ? data : JSON.stringify(data));
    };
    try {
        external.SuperCall(864, JSON.stringify({callback: jname}));
    } catch(e) {
        resolve("");
    }
    setTimeout(function() { resolve(""); }, 3000);
})
`;

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/json', timeout: 4000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          // 兼容不同 CEF 版本：/json 可能返回数组，或 {targetInfos:[...]}
          const arr = Array.isArray(j) ? j : (Array.isArray(j.targetInfos) ? j.targetInfos : []);
          resolve(arr);
        } catch (e) { reject(new Error('解析 /json 失败: ' + e.message)); }
      });
    }).on('error', (e) => reject(new Error('连不上端口 ' + PORT + '（酷狗没打补丁/没启动？）: ' + e.code)));
  });
}

function pickTarget(pages) {
  for (const p of pages) {
    const u = p.url || '', t = p.title || '';
    if (u.includes('desktop-popup') || t.toLowerCase().includes('desktop')) return p;
  }
  return pages[0];
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    // 不发送 Origin 头，和 PlayerCap 的 Go 客户端行为一致
    const ws = new WebSocket(wsUrl, { headers: {} });
    let msgId = 1;
    const pending = new Map();
    ws.on('open', () => resolve({
      ws,
      send(method, params) {
        const id = msgId++;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
          setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); } }, 6000);
        });
      },
      close() { try { ws.close(); } catch (_) {} }
    }));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    });
    ws.on('error', (e) => reject(new Error('WS 错误: ' + e.message)));
  });
}

async function readPlayInfo(cdp) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: JS_GET_PLAY_INFO, returnByValue: true, awaitPromise: true
  });
  const val = r && r.result && r.result.value;
  if (!val) return null;
  try { return JSON.parse(val); } catch (_) { return null; }
}

(async () => {
  let pages;
  try { pages = await getTargets(); } catch (e) { console.log('✖ ' + e.message); process.exit(1); }
  if (!pages || !pages.length) { console.log('✖ 端口开着但没有可用页面目标，请确认酷狗已在播放歌曲。'); process.exit(1); }
  const target = pickTarget(pages);
  if (!target || !target.webSocketDebuggerUrl) { console.log('✖ 目标缺少 webSocketDebuggerUrl，无法连接。'); process.exit(1); }
  console.log('页面目标: ' + (target.title || '') + ' | ' + (target.url || ''));
  let cdp;
  try { cdp = await connectCdp(target.webSocketDebuggerUrl); } catch (e) { console.log('✖ 连接 CDP 失败: ' + e.message); process.exit(1); }
  await cdp.send('Runtime.enable').catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  console.log('开始采样（' + SAMPLES + ' 次，每秒 1 次）——现在可以去酷狗拖动进度条观察：\n');
  let last = -1;
  for (let i = 0; i < SAMPLES; i++) {
    let info = null;
    try { info = await readPlayInfo(cdp); } catch (e) { console.log('  读取失败: ' + e.message); }
    if (!info) { console.log('  [' + i + '] (无播放信息)'); }
    else {
      const prog = parseInt(info.progress || '0', 10);
      const dur = parseInt(info.duration || '0', 10);
      const jump = last >= 0 && Math.abs(prog - last) > 2500;
      console.log('  [' + String(i).padStart(2) + '] status=' + (info.play_status || '?').padEnd(8) +
        ' progress=' + String(prog).padStart(8) + 'ms (' + (prog / 1000).toFixed(1) + 's)' +
        ' duration=' + dur + 'ms  hash=' + (info.hash || '').slice(0, 12) +
        ' file=' + (info.filename || '') + (jump ? '   <<< 检测到跳动/拖动!' : ''));
      last = prog;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  cdp.close();
  console.log('\n采样结束。若上面 progress 随时间递增、拖动时跳变，则 CDP 实时进度可用 ✔');
  process.exit(0);
})();
