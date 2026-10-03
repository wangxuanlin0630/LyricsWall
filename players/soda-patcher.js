/* players/soda-patcher.js — 汽水音乐 Node inspector (9229) 激活器
 *
 * 汽水是 Electron 且有原生反调试：argv 加 --remote-debugging-port 会被它 ~2s 内自杀，
 * 网易云那套「杀进程+带参数重启」在此不通。改为复刻 Node 的 process._debugProcess(pid)：
 * 读命名映射 node-debug-handler-<pid> 里的激活函数地址 → CreateRemoteThread 让目标自己
 * 拉起 inspector。非破坏性（不改汽水内存/状态/argv），可反复调用、随时重试。
 * 具体 Win32 调用在 tools/enable-soda-inspector.ps1（Add-Type P/Invoke）。
 */
'use strict';

const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const TARGET_PROCESS = 'SodaMusic.exe';
const INSPECTOR_PORT = 9229;
const PS1 = path.join(__dirname, '..', 'tools', 'enable-soda-inspector.ps1');

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs || 15000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

// 找汽水**主进程**（Electron browser 进程）：命令行里没有 --type= 的那个 SodaMusic.exe。
// 渲染器/GPU/utility 子进程都带 --type=，Node inspector 只在主进程上。
async function findMainPid() {
  const ps = `(Get-CimInstance Win32_Process -Filter "Name='${TARGET_PROCESS}'") |` +
    ` Where-Object { $_.CommandLine -notmatch '--type=' } |` +
    ` Select-Object -First 1 -ExpandProperty ProcessId`;
  const r = await run('powershell', ['-NoProfile', '-Command', ps], 12000);
  if (!r.ok) return 0;
  const pid = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : 0;
}

function inspectorUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: INSPECTOR_PORT, path: '/json/list', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function activate(pid) {
  const r = await run('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-ProcId', String(pid)], 20000);
  return r.ok && /^OK:/m.test(r.stdout);
}

/* 确保 9229 可用：已开 → 直接 ok；未开 → 找主进程激活 → 轮询等就绪。
 * 返回 { ok, reason?, pid? }；失败 reason: not-running | no-mapping | activate-failed | port-timeout
 */
async function ensureInspector(opts) {
  const onStatus = (opts && opts.onStatus) || null;
  const say = (stage, detail) => { try { if (onStatus) onStatus(stage, detail); } catch (e) {} };

  if (await inspectorUp()) return { ok: true, already: true };

  say('checking');
  const pid = await findMainPid();
  if (!pid) { say('failed', '汽水音乐未运行'); return { ok: false, reason: 'not-running' }; }

  say('activating');
  if (!(await activate(pid))) {
    say('failed', '激活失败（汽水版本可能不兼容）');
    return { ok: false, reason: 'activate-failed', pid };
  }

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await inspectorUp()) { say('done'); return { ok: true, pid }; }
    await new Promise((r) => setTimeout(r, 150));
  }
  say('failed', '已激活但端口未就绪');
  return { ok: false, reason: 'port-timeout', pid };
}

module.exports = { ensureInspector, findMainPid, inspectorUp, INSPECTOR_PORT, TARGET_PROCESS };
