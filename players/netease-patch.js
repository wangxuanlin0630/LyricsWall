/* players/netease-patch.js — 网易云调试参数 watchdog（自动重启带 CDP 端口）
 *
 * 移植自 PlayerCap（Go）：playercap/player/cloudmusic/watchdog/process.go
 * 职责：检测 cloudmusic.exe 是否已在运行且带 --remote-debugging-port=9222，
 *       没有则 kill 后重启（带调试 + 保活参数）。也修补注册表自启动键，
 *       让用户手动启动的网易云也自带调试端口。
 *
 * 与酷狗不同：网易云不需要 DLL 补丁，只需启动参数即可。
 */
'use strict';

const path = require('path');
const { execFile, spawn } = require('child_process');

const TARGET_PROCESS = 'cloudmusic.exe';
const KEEPALIVE_MARKER = '--disable-backgrounding-occluded-windows';

const LAUNCH_FLAGS = [
  '--remote-debugging-port=9222',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
];

function execFileP(cmd, args, opts) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, Object.assign({ encoding: 'utf-8', windowsHide: true, timeout: 15000 }, opts || {}),
        (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
    } catch (e) { resolve({ ok: false, stdout: '' }); }
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fileExists(p) { try { return require('fs').statSync(p).isFile(); } catch (e) { return false; } }

// 检测网易云是否在运行
async function isNeteaseRunning() {
  const r = await execFileP('tasklist', ['/FI', 'IMAGENAME eq ' + TARGET_PROCESS, '/NH']);
  if (!r.ok) return false;
  return r.stdout.indexOf(TARGET_PROCESS) >= 0;
}

// PowerShell 读 exe 版本号
async function readExeVersion(exePath) {
  const safe = String(exePath).replace(/'/g, "''");
  const ps = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;(Get-Item '" + safe + "').VersionInfo.FileVersion";
  const r = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (!r.ok) return '';
  return r.stdout.replace(/^\ufeff/, '').trim();
}

// 主版本 < 3 不支持 CDP（v2 的 CEF 不开 remote debugging）
function isUnsupportedVersion(version) {
  if (!version) return false; // 读不到 → 按 v3 走
  const majorStr = version.split('.')[0];
  const major = parseInt(majorStr, 10);
  if (!major || major < 1) return false;
  return major < 3;
}

// 注册表读网易云安装目录
async function regQueryNetease(valueName) {
  const r = await execFileP('reg', ['query', 'HKCU\\Software\\NetEase\\CloudMusic', '/v', valueName]);
  if (!r.ok) return '';
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+REG_\S+\s+(.+?)\s*$/);
    if (m && m[1].toLowerCase() === valueName.toLowerCase()) return m[2];
  }
  return '';
}

// 找网易云安装
async function findNeteaseInstall() {
  let exePath = '';
  const installDir = await regQueryNetease('InstallDir');
  if (installDir) {
    const cand = path.join(installDir, TARGET_PROCESS);
    if (fileExists(cand)) exePath = cand;
  }
  if (!exePath) {
    const r = await execFileP('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\cloudmusic.exe', '/ve']);
    if (r.ok) {
      const m = r.stdout.match(/REG_SZ\s+(.+?)\s*$/m);
      if (m && fileExists(m[1])) exePath = m[1];
    }
  }
  if (!exePath) {
    for (const base of ['C:\\Program Files\\NetEase\\CloudMusic', 'C:\\Program Files (x86)\\NetEase\\CloudMusic']) {
      const cand = path.join(base, TARGET_PROCESS);
      if (fileExists(cand)) { exePath = cand; break; }
    }
  }
  return exePath || null;
}

// kill 所有网易云进程并等退出
async function killNetease() {
  await execFileP('taskkill', ['/F', '/IM', TARGET_PROCESS]);
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if (!(await isNeteaseRunning())) return;
  }
}

// detached 启动网易云
function launchNetease(exePath) {
  try {
    const child = spawn(exePath, LAUNCH_FLAGS, { cwd: path.dirname(exePath), detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (e) { return false; }
}

// 等 CDP 端口就绪
async function waitForCDP(timeoutMs) {
  const http = require('http');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: 9222, path: '/json', timeout: 2000 }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            // 端口 200 不够——必须出现 orpheus:// 页面才算网易云的 CDP 就绪
            // （9222 可能被别的程序占用，如本应用自己的调试实例）
            try {
              const list = JSON.parse(body);
              resolve(Array.isArray(list) && list.some((t) => String(t.url || '').startsWith('orpheus://')));
            } catch (e) { resolve(false); }
          });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', () => reject(new Error('err')));
      });
      if (ok) return true;
    } catch (e) {}
    await sleep(2000);
  }
  return false;
}

// 注册表修补自启动键
async function patchRegistryAutoStart() {
  const r = await execFileP('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'cloudmusic']);
  if (!r.ok) return;
  let val = '';
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*cloudmusic\s+REG_SZ\s+(.+?)\s*$/);
    if (m) { val = m[1]; break; }
  }
  if (!val) return;
  let newVal = val;
  for (const f of LAUNCH_FLAGS) {
    if (!newVal.includes(f)) newVal += ' ' + f;
  }
  if (newVal === val) return;
  await execFileP('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'cloudmusic', '/t', 'REG_SZ', '/d', newVal, '/f']);
}

/* 主流程：ensureDebugMode
 * 返回 {ok, reason?, version?, restarted?}
 *   ok=true：端口已通或已重启成功
 *   reason：not-running | not-found | unsupported-version | port-timeout | kill-failed
 */
async function ensureDebugMode(opts) {
  const onStatus = (opts && opts.onStatus) || null;
  const say = (stage, detail) => { try { if (onStatus) onStatus(stage, detail); } catch (e) {} };

  if (!(await isNeteaseRunning())) {
    return { ok: false, reason: 'not-running' };
  }

  // 检查是否已带我们的参数（wmic 读命令行）
  const cmdlineR = await execFileP('wmic', ['process', 'where', "name='" + TARGET_PROCESS + "'", 'get', 'CommandLine', '/format:list']);
  let hasFlags = false;
  if (cmdlineR.ok) {
    hasFlags = cmdlineR.stdout.includes(KEEPALIVE_MARKER);
  }

  if (hasFlags) {
    const portOk = await waitForCDP(5000);
    if (portOk) return { ok: true };
    // 带参但端口不通，继续往下重启
  }

  const exePath = await findNeteaseInstall();
  if (!exePath) return { ok: false, reason: 'not-found' };

  const version = await readExeVersion(exePath);
  if (isUnsupportedVersion(version)) {
    return { ok: false, reason: 'unsupported-version', version };
  }

  say('restarting');
  if (await isNeteaseRunning()) await killNetease();
  say('relaunch');
  launchNetease(exePath);
  const portOk = await waitForCDP(60000);
  if (!portOk) return { ok: false, reason: 'port-timeout', version };
  say('done');
  return { ok: true, restarted: true, version };
}

module.exports = {
  isNeteaseRunning,
  findNeteaseInstall,
  readExeVersion,
  isUnsupportedVersion,
  ensureDebugMode,
  patchRegistryAutoStart,
  LAUNCH_FLAGS,
};
