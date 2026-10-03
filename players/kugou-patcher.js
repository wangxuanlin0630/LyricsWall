/* players/kugou-patcher.js — 酷狗 libcef.dll 自动修补（CDP 端口开启）
 *
 * 移植自 PlayerCap（Go）：playercap/player/kugou/watchdog/watchdog.go。
 * 原理：酷狗界面是 vendored CEF，默认不开 DevTools 端口。对 libcef.dll 的
 * 9 处已知偏移打一次性字节补丁后，酷狗会在 127.0.0.1:12233 常开 CDP 端口，
 * 供 kugou-cdp.js 读取播放进度。
 *
 * 双模式：
 *   1) 模块：require('./kugou-patcher') → findKuGouInstall / checkPatchStatus /
 *      isKuGouRunning / readExeVersion / ensurePatched
 *   2) 提权 helper：node kugou-patcher.js --kugou-patch-helper <libcefPath>
 *      （由 ensurePatched 经 PowerShell Start-Process -Verb RunAs 拉起，
 *      结果写 %TEMP%\lw_kugou_patch_result.txt 后退出）
 *
 * 仅用 Node 内置模块，无 npm 依赖。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile, spawn } = require('child_process');

const CDP_PORT = 12233;
const TARGET_PROCESS = 'KuGou.exe';
// 补丁逆向针对的酷狗版本（仅日志/诊断用；能不能打由字节指纹决定）
const KNOWN_VERSION = '20.1.22.27795';
// 提权 helper 的结果文件（主进程与 helper 进程同用户，%TEMP% 一致）
const RESULT_FILE = path.join(os.tmpdir(), 'lw_kugou_patch_result.txt');

/* ---------------- 补丁表（逐字节抄录自 watchdog.go 第 68-78 行，不得改动） ----------------
 * orig = 20.1.22.27795 / CEF 89.20.0 原版实测字节；data = 打补丁后的字节。
 * P1/P5/P7 写端口立即数（0xAAAAAAAA 是 CEF「端口未设」哨兵），
 * P2/P3/P6 NOP 掉条件跳转，P4/P8 NOP 掉 CALL，P9 NOP 掉 cmovz。 */
const LIBCEF_PATCHES = [
  { offset: 0x58C63EB, orig: [0xC7, 0x06, 0xAA, 0xAA, 0xAA, 0xAA], data: [0xC7, 0x06, 0xC9, 0x2F, 0x00, 0x00] }, // Patch1: force port=12233 init
  { offset: 0x58C6415, orig: [0xE8, 0x96, 0xA9, 0xE9, 0xFC], data: [0x90, 0x90, 0x90, 0x90, 0x90] },             // Patch4: NOP CALL sub_1827619B0
  { offset: 0x58C6420, orig: [0x0F, 0x87, 0x96, 0x01, 0x00, 0x00], data: [0x90, 0x90, 0x90, 0x90, 0x90, 0x90] }, // Patch2: NOP ja (port range check)
  { offset: 0x58C6428, orig: [0x0F, 0x84, 0x8E, 0x01, 0x00, 0x00], data: [0x90, 0x90, 0x90, 0x90, 0x90, 0x90] }, // Patch3: NOP jz (parse success check)
  { offset: 0x4BC180E, orig: [0x8B, 0x95, 0x7C, 0x01, 0x00, 0x00], data: [0xBA, 0xC9, 0x2F, 0x00, 0x00, 0x90] }, // Patch5: child cmdline port=12233
  { offset: 0x4BEDE41, orig: [0x0F, 0x84, 0x70, 0x01, 0x00, 0x00], data: [0x90, 0x90, 0x90, 0x90, 0x90, 0x90] }, // Patch6: NOP jz (DevTools startup skip)
  { offset: 0x4BEDE4C, orig: [0x41, 0xC7, 0x07, 0xAA, 0xAA, 0xAA, 0xAA], data: [0x41, 0xC7, 0x07, 0xC9, 0x2F, 0x00, 0x00] }, // Patch7: force port=12233 in DevTools fn
  { offset: 0x4BEDEB5, orig: [0xE8, 0xF6, 0x2E, 0xB7, 0xFD], data: [0x90, 0x90, 0x90, 0x90, 0x90] },             // Patch8: NOP parse CALL
  { offset: 0x4BEDED0, orig: [0x0F, 0x44, 0xDA], data: [0x90, 0x90, 0x90] },                                     // Patch9: NOP cmovz
];

/* ---------------- 小工具 ---------------- */

function execFileP(cmd, args, opts) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, Object.assign({ encoding: 'utf-8', windowsHide: true, timeout: 15000 }, opts || {}),
        (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
    } catch (e) { resolve({ ok: false, stdout: '' }); }
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }
function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

/* ---------------- CDP 端口探测 ---------------- */

function isCDPAvailable() {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: '/json', timeout: 2000 }, (res) => {
        res.resume();
        fin(res.statusCode === 200);
      });
      req.on('timeout', () => { req.destroy(); fin(false); });
      req.on('error', () => fin(false));
    } catch (e) { fin(false); }
  });
}

/* ---------------- 安装定位 ---------------- */

// 读注册表 HKCU\Software\KuGou 的某个字符串值；失败返回 ''
async function regQueryKuGou(valueName) {
  const r = await execFileP('reg', ['query', 'HKCU\\Software\\KuGou', '/v', valueName]);
  if (!r.ok) return '';
  // 输出形如：    KuGou8    REG_SZ    C:\...\KGMusic
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+REG_\S+\s+(.+?)\s*$/);
    if (m && m[1].toLowerCase() === valueName.toLowerCase()) return m[2];
  }
  return '';
}

// KuGou8 守卫：必须是指向存在的目录、且其下有 libcef.dll，才返回 libcef.dll 路径
//（KuGou8 已知会被改写成 KuGou.exe 文件路径，指文件即视为不可用）
function kugou8LibcefIfDir(dir) {
  if (!dir) return '';
  if (!dirExists(dir)) return '';
  const lc = path.join(dir, 'libcef.dll');
  return fileExists(lc) ? lc : '';
}

// PowerShell 读 exe 的 FileVersion（如 "20.1.22.27795"）；失败返回 ''
async function readExeVersion(exePath) {
  const safe = String(exePath).replace(/'/g, "''");
  const ps = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;(Get-Item '" + safe + "').VersionInfo.FileVersion";
  const r = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (!r.ok) return '';
  return r.stdout.replace(/^﻿/, '').trim();
}

// 版本号比较：a.b.c.d 按数值段比较（字典序在不同位数下不可靠）
function cmpVersionName(a, b) {
  const pa = String(a).split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

// 在 base 下选 KuGou.exe 实际加载的 libcef.dll：首选与 exe 版本同名的子目录，
// 否则取含 libcef.dll 的版本号最大子目录（避免选中升级残留的旧版本）
function findLibcefForExe(base, ver) {
  if (ver) {
    const lc = path.join(base, ver, 'libcef.dll');
    if (fileExists(lc)) return lc;
  }
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return ''; }
  let best = '', bestName = '';
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const lc = path.join(base, entry.name, 'libcef.dll');
    if (!fileExists(lc)) continue;
    if (entry.name === ver) return lc; // 精确匹配 exe 版本
    if (!bestName || cmpVersionName(entry.name, bestName) > 0) { best = lc; bestName = entry.name; }
  }
  return best;
}

// findKuGouInstall() → {exePath, libcefPath} | null
// 定位顺序：注册表 KuGou8（目录守卫）→ 注册表 AppPath 拼 KuGou.exe → 扫常见安装根。
// libcef.dll：KuGou8 目录优先，否则按 exe 版本找同名子目录，再否则取版本号最大者。
async function findKuGouInstall() {
  const kugou8 = await regQueryKuGou('KuGou8');
  const libcefFromKugou8 = kugou8LibcefIfDir(kugou8);

  // exe 定位
  let exePath = '';
  if (libcefFromKugou8) {
    const cand = path.join(kugou8, TARGET_PROCESS);
    if (fileExists(cand)) exePath = cand;
  }
  if (!exePath) {
    const appPath = await regQueryKuGou('AppPath');
    if (appPath) {
      const cand = path.join(appPath, TARGET_PROCESS);
      if (fileExists(cand)) exePath = cand;
    }
  }
  if (!exePath) {
    for (const base of ['C:\\Program Files\\KuGou\\KGMusic', 'C:\\Program Files (x86)\\KuGou\\KGMusic']) {
      const cand = path.join(base, TARGET_PROCESS);
      if (fileExists(cand)) { exePath = cand; break; }
    }
  }
  if (!exePath) return null;

  // libcef 定位：KuGou8 优先，否则按 exe 版本推导
  let libcefPath = libcefFromKugou8;
  if (!libcefPath) libcefPath = findLibcefForExe(path.dirname(exePath), await readExeVersion(exePath));
  if (!libcefPath) return null;
  return { exePath, libcefPath };
}

/* ---------------- patch 状态检查 ---------------- */

// checkPatchStatus(libcefPath) → {allPatched, canAutoFix}
// 9 处偏移逐字节比对：全是 data → allPatched；全落在 {orig,data} 内 → canAutoFix；
// 任一两者皆非 → canAutoFix=false（版本不认识，拒绝盲打）；读失败抛错。
async function checkPatchStatus(libcefPath) {
  const fh = await fs.promises.open(libcefPath, 'r');
  try {
    let allPatched = true;
    for (let i = 0; i < LIBCEF_PATCHES.length; i++) {
      const p = LIBCEF_PATCHES[i];
      const buf = Buffer.alloc(p.data.length); // len(orig)==len(data)
      const { bytesRead } = await fh.read(buf, 0, buf.length, p.offset);
      if (bytesRead !== buf.length) {
        throw new Error('read Patch' + (i + 1) + ' (offset=0x' + p.offset.toString(16) + '): 读取长度不足');
      }
      const isData = buf.equals(Buffer.from(p.data));
      const isOrig = buf.equals(Buffer.from(p.orig));
      if (!isData) allPatched = false;
      if (!isData && !isOrig) return { allPatched: false, canAutoFix: false }; // 版本指纹不匹配
    }
    return { allPatched, canAutoFix: true };
  } finally {
    await fh.close();
  }
}

/* ---------------- 进程管理 ---------------- */

// isKuGouRunning() → 是否有 KuGou.exe 进程存活
async function isKuGouRunning() {
  const r = await execFileP('tasklist', ['/FI', 'IMAGENAME eq ' + TARGET_PROCESS, '/NH']);
  if (!r.ok) return false;
  return r.stdout.indexOf(TARGET_PROCESS) >= 0;
}

// 终止所有酷狗进程并轮询等退出（最多 5s）
async function killKuGou() {
  await execFileP('taskkill', ['/F', '/IM', TARGET_PROCESS]);
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if (!(await isKuGouRunning())) return;
  }
}

// 从 exe 所在目录 detached 启动酷狗
function launchKuGou(exePath) {
  try {
    const child = spawn(exePath, [], { cwd: path.dirname(exePath), detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (e) { return false; }
}

/* ---------------- 提权 helper（--kugou-patch-helper） ---------------- */

function writePatchResult(content) {
  try { fs.writeFileSync(RESULT_FILE, content, { mode: 0o600 }); } catch (e) {}
}

// 只应由 patchWithBackup 调用：对 9 处偏移逐个写 data 字节并 fsync（无安全网）
async function patchDLLBytes(libcefPath) {
  const fh = await fs.promises.open(libcefPath, 'r+');
  try {
    for (let i = 0; i < LIBCEF_PATCHES.length; i++) {
      const p = LIBCEF_PATCHES[i];
      await fh.write(Buffer.from(p.data), 0, p.data.length, p.offset);
    }
    await fh.sync(); // 显式落盘，漏掉延迟刷盘失败会让「patch 成功」名不副实
  } finally {
    await fh.close();
  }
}

// 在提权进程内安全打补丁：落笔前复检 → 备份 → 写补丁 → 写后自校验，失败从备份回滚
async function patchWithBackup(libcefPath) {
  // 落笔前复检：主进程 check 与此刻之间隔着 UAC 弹窗，DLL 可能被自动更新器换掉
  const st = await checkPatchStatus(libcefPath);
  if (!st.canAutoFix) throw new Error('落笔前复检：libcef.dll 版本指纹不符，拒绝 patch');
  if (st.allPatched) return; // 已是 patched 态，无需再写

  const bak = libcefPath + '.lw.bak';
  await fs.promises.copyFile(libcefPath, bak); // 备份原文件

  const rollback = async () => {
    try { await fs.promises.copyFile(bak, libcefPath); await fs.promises.unlink(bak); return ''; }
    catch (e) { return bak; } // 回滚失败：保留备份供人工恢复
  };

  try {
    await patchDLLBytes(libcefPath);
  } catch (e) {
    const kept = await rollback();
    throw new Error('patch 写入失败（已尝试回滚）: ' + (e && e.message || e) + (kept ? '；备份保留在 ' + kept : ''));
  }
  // 写后自校验：9 处必须全部变为 data（抓「写没落盘/被杀软回滚」）
  let verified = false;
  try { verified = (await checkPatchStatus(libcefPath)).allPatched; } catch (e) { verified = false; }
  if (!verified) {
    const kept = await rollback();
    throw new Error('patch 后校验失败：字节未按预期变更（已回滚，可能被杀软拦截）' + (kept ? '；备份保留在 ' + kept : ''));
  }
  await fs.promises.unlink(bak).catch(() => {}); // 成功，删除备份
}

// helper CLI 入口：提权进程内执行 patchWithBackup，结果写结果文件后退出
async function runPatchHelper(libcefPath) {
  if (!libcefPath || !String(libcefPath).trim()) {
    writePatchResult('ERROR: 未提供 libcef.dll 路径');
    process.exit(1);
  }
  try {
    await patchWithBackup(libcefPath);
    writePatchResult('OK');
    process.exit(0);
  } catch (e) {
    writePatchResult('ERROR: ' + (e && e.message || String(e)));
    process.exit(1);
  }
}

// 主进程侧：经 PowerShell Start-Process -Verb RunAs 弹 UAC 拉起提权 helper，等结果
// → {ok:true} | {ok:false, reason:'patch-failed'|'elevation-denied', detail?}
function runElevatedHelper(libcefPath) {
  return new Promise((resolve) => {
    try { fs.unlinkSync(RESULT_FILE); } catch (e) {} // 删旧结果文件
    const q = (s) => String(s).replace(/'/g, "''"); // PowerShell 单引号转义
    const ps =
      "$env:ELECTRON_RUN_AS_NODE='1'; " +
      "Start-Process -FilePath '" + q(process.execPath) + "' " +
      "-ArgumentList '\\\"" + q(__filename) + "\\\" --kugou-patch-helper \\\"" + q(libcefPath) + "\\\"' " +
      "-Verb RunAs -Wait";
    const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const fin = (r) => { if (!settled) { settled = true; resolve(r); } };
    // 60s 超时：用户不响应 UAC / helper 卡死都按提权失败处理
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} fin({ ok: false, reason: 'elevation-denied', detail: 'helper 超时' }); }, 60000);
    proc.on('error', () => { clearTimeout(timer); fin({ ok: false, reason: 'elevation-denied' }); });
    proc.on('exit', () => {
      clearTimeout(timer);
      let content = '';
      try { content = fs.readFileSync(RESULT_FILE, 'utf-8').trim(); } catch (e) {}
      if (content === 'OK') fin({ ok: true });
      else if (content.indexOf('ERROR:') === 0) fin({ ok: false, reason: 'patch-failed', detail: content.slice(6).trim() });
      else fin({ ok: false, reason: 'elevation-denied' }); // 文件不存在：用户拒绝了 UAC
    });
  });
}

// 等 CDP 端口就绪：2s 轮询，90s 超时
async function waitForCDP(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCDPAvailable()) return true;
    await sleep(2000);
  }
  return false;
}

/* ---------------- 主流程：ensurePatched ---------------- */

// ensurePatched({onStatus}) → {ok, reason?, version?, libcefPath?, alreadyPatched?|patched?}
// 严格对齐 Go 版 EnsurePatched 的判定顺序；onStatus(stage, detail) 全程汇报状态。
async function ensurePatched(opts) {
  const onStatus = (opts && opts.onStatus) || null;
  const say = (stage, detail) => { try { if (onStatus) onStatus(stage, detail); } catch (e) {} };

  // 1. 端口已通 → 直接成功（快路径）
  if (await isCDPAvailable()) return { ok: true };

  // 2. 定位安装
  const inst = await findKuGouInstall();
  if (!inst) return { ok: false, reason: 'not-installed' };
  const { exePath, libcefPath } = inst;

  // 3. 负向黑名单：10.x 是不同 CEF 基线，确定性拒绝（版本号不作正向判据，能否打看字节指纹）
  const version = await readExeVersion(exePath);
  if (version.indexOf('10.') === 0) return { ok: false, reason: 'unsupported-major', version, libcefPath };

  // 4. 检查 patch 状态
  let st;
  try { st = await checkPatchStatus(libcefPath); }
  catch (e) { return { ok: false, reason: 'check-failed', version, libcefPath, detail: String(e && e.message || e) }; }
  if (!st.canAutoFix) return { ok: false, reason: 'unsupported-dll', version, libcefPath };
  if (st.allPatched) return { ok: true, alreadyPatched: true, version, libcefPath };

  // 5. 未打补丁：提权修补 → 复核 → 重启酷狗 → 等端口
  say('need-uac');
  if (await isKuGouRunning()) await killKuGou(); // 酷狗本来没跑则跳过 kill
  const r = await runElevatedHelper(libcefPath);
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail, version, libcefPath };

  // 主进程侧复核：9 处必须全 data（helper 报成功但字节没变 = 疑似被杀软回滚）
  try {
    const v = await checkPatchStatus(libcefPath);
    if (!v.allPatched) return { ok: false, reason: 'verify-failed', version, libcefPath };
  } catch (e) {
    return { ok: false, reason: 'verify-failed', version, libcefPath, detail: String(e && e.message || e) };
  }

  // patch 后总是启动酷狗（与 Go 版一致），再等端口就绪
  say('relaunch');
  launchKuGou(exePath);
  if (!(await waitForCDP(90000))) return { ok: false, reason: 'port-timeout', version, libcefPath };
  say('done');
  return { ok: true, patched: true, version, libcefPath };
}

/* ---------------- 入口分流 ---------------- */

module.exports = {
  findKuGouInstall,
  checkPatchStatus,
  isKuGouRunning,
  readExeVersion,
  ensurePatched,
  isCDPAvailable,
  KNOWN_VERSION,
  LIBCEF_PATCHES,
};

if (require.main === module) {
  // 提权 helper 模式：node kugou-patcher.js --kugou-patch-helper <libcefPath>
  const idx = process.argv.indexOf('--kugou-patch-helper');
  runPatchHelper(idx >= 0 ? process.argv[idx + 1] : '');
}
