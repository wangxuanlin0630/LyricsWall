/* 一次性补丁器：给酷狗的 libcef.dll 打开 CEF 远程调试端口 12233
 *
 * 原理（参考 PlayerCap, MIT）：CEF 89.20.0 的 libcef.dll 里，端口未设时用哨兵
 * 0xAAAAAAAA。把 9 处相关字节改成 12233(0x2FC9) 并 NOP 掉拦截/跳过调试端口的跳转，
 * 酷狗启动后就会一直开着 12233 端口，供我们用 CDP 读实时播放进度。
 *
 * 安全设计：
 *   - 写之前校验 9 处字节必须【全部等于原始值 orig】，否则拒绝（防止改坏未知版本）
 *   - 首次写入前备份 libcef.dll -> libcef.dll.dtgc.bak（保留最原始副本）
 *   - 写入后重新校验，失败自动从备份回滚
 *
 * 用法（需管理员权限，且酷狗必须完全退出）：
 *   node tools\patch-kugou.js                     自动发现并打补丁
 *   node tools\patch-kugou.js "<libcef.dll路径>"   指定文件打补丁
 *   node tools\patch-kugou.js --restore           从备份还原（撤销补丁）
 *   node tools\patch-kugou.js --status            只查看状态，不写入
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 12233;
const PORT_BYTES = [0xC9, 0x2F, 0x00, 0x00]; // 12233 小端
const BAK_SUFFIX = '.dtgc.bak';

const PATCHES = [
  { name: 'P1 force port init',    off: 0x58C63EB, orig: [0xC7,0x06,0xAA,0xAA,0xAA,0xAA], data: [0xC7,0x06,...PORT_BYTES] },
  { name: 'P4 NOP call',           off: 0x58C6415, orig: [0xE8,0x96,0xA9,0xE9,0xFC],      data: [0x90,0x90,0x90,0x90,0x90] },
  { name: 'P2 NOP ja(range)',      off: 0x58C6420, orig: [0x0F,0x87,0x96,0x01,0x00,0x00], data: [0x90,0x90,0x90,0x90,0x90,0x90] },
  { name: 'P3 NOP jz(parse ok)',   off: 0x58C6428, orig: [0x0F,0x84,0x8E,0x01,0x00,0x00], data: [0x90,0x90,0x90,0x90,0x90,0x90] },
  { name: 'P5 child cmdline port', off: 0x4BC180E, orig: [0x8B,0x95,0x7C,0x01,0x00,0x00], data: [0xBA,...PORT_BYTES,0x90] },
  { name: 'P6 NOP jz(devtools)',   off: 0x4BEDE41, orig: [0x0F,0x84,0x70,0x01,0x00,0x00], data: [0x90,0x90,0x90,0x90,0x90,0x90] },
  { name: 'P7 force port devtools',off: 0x4BEDE4C, orig: [0x41,0xC7,0x07,0xAA,0xAA,0xAA,0xAA], data: [0x41,0xC7,0x07,...PORT_BYTES] },
  { name: 'P8 NOP parse call',     off: 0x4BEDEB5, orig: [0xE8,0xF6,0x2E,0xB7,0xFD],      data: [0x90,0x90,0x90,0x90,0x90] },
  { name: 'P9 NOP cmovz',          off: 0x4BEDED0, orig: [0x0F,0x44,0xDA],                data: [0x90,0x90,0x90] },
];

function readAt(fd, off, len) {
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, off);
  return [...b];
}
function classify(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return { state: 'NO_ACCESS', err: e.message }; }
  try {
    let orig = 0, data = 0, unknown = 0;
    for (const p of PATCHES) {
      const a = readAt(fd, p.off, p.orig.length);
      if (a.every((b, i) => b === p.orig[i])) orig++;
      else if (a.length === p.data.length && a.every((b, i) => b === p.data[i])) data++;
      else unknown++;
    }
    if (unknown > 0) return { state: 'UNKNOWN', orig, data, unknown };
    if (data === PATCHES.length) return { state: 'PATCHED', orig, data, unknown };
    if (orig === PATCHES.length) return { state: 'ORIGINAL', orig, data, unknown };
    return { state: 'PARTIAL', orig, data, unknown };
  } finally { fs.closeSync(fd); }
}

function kugouRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq KuGou.exe" /NH', { encoding: 'utf8' });
    return /KuGou\.exe/i.test(out);
  } catch (e) { return false; }
}

function discover() {
  const roots = [
    'D:\\LenovoSoftstore\\Install\\kugouyinyue',
    'C:\\Program Files (x86)\\KuGou',
    'C:\\Program Files\\KuGou',
    'D:\\KuGou', 'D:\\Program Files\\KuGou', 'D:\\Program Files (x86)\\KuGou',
  ];
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp, depth + 1);
      else if (e.name.toLowerCase() === 'libcef.dll') found.push(fp);
    }
  };
  for (const r of roots) { if (fs.existsSync(r)) walk(r, 0); }
  return found;
}

function backup(file) {
  const bak = file + BAK_SUFFIX;
  if (fs.existsSync(bak)) return bak; // 已有原始备份则不覆盖
  fs.copyFileSync(file, bak);
  return bak;
}

function applyPatch(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    for (const p of PATCHES) {
      fs.writeSync(fd, Buffer.from(p.data), 0, p.data.length, p.off);
    }
  } finally { fs.closeSync(fd); }
}

function patchOne(file) {
  console.log('\n目标: ' + file);
  const st = classify(file);
  console.log('  当前状态: ' + st.state + (st.err ? ' (' + st.err + ')' : ''));
  if (st.state === 'PATCHED') { console.log('  => 已打过补丁，跳过。'); return true; }
  if (st.state !== 'ORIGINAL') {
    console.log('  => 拒绝写入：字节指纹不是纯原始状态（可能是不同版本/已部分修改），强行改会损坏 DLL。');
    return false;
  }
  let bak;
  try { bak = backup(file); } catch (e) {
    console.log('  => 备份失败（可能需要管理员权限）: ' + e.message); return false;
  }
  console.log('  已备份原始 DLL -> ' + bak);
  try { applyPatch(file); } catch (e) {
    console.log('  => 写入失败（请以管理员身份运行，且确认酷狗已退出）: ' + e.message);
    try { fs.copyFileSync(bak, file); console.log('  已回滚。'); } catch (_) {}
    return false;
  }
  const after = classify(file);
  if (after.state === 'PATCHED') { console.log('  => 补丁写入并校验成功 ✔ 端口将在酷狗下次启动时开启 (' + PORT + ')。'); return true; }
  console.log('  => 校验未通过，回滚。');
  try { fs.copyFileSync(bak, file); } catch (_) {}
  return false;
}

function restoreOne(file) {
  const bak = file + BAK_SUFFIX;
  if (!fs.existsSync(bak)) { console.log('\n' + file + '\n  无备份，跳过还原。'); return; }
  try { fs.copyFileSync(bak, file); fs.unlinkSync(bak); console.log('\n已还原: ' + file); }
  catch (e) { console.log('\n还原失败（需管理员权限？）: ' + e.message); }
}

/* ---------------- main ---------------- */
const args = process.argv.slice(2);
const mode = args.find(a => a.startsWith('--')) || '';
const explicit = args.find(a => !a.startsWith('--'));

let targets;
if (explicit) targets = [explicit];
else targets = discover();

if (!targets.length) { console.log('未发现 libcef.dll，请用参数显式指定路径。'); process.exit(1); }

if (mode === '--status') {
  for (const t of targets) { const s = classify(t); console.log(s.state.padEnd(10) + ' ' + t); }
  process.exit(0);
}
if (mode === '--restore') {
  if (kugouRunning()) { console.log('检测到酷狗正在运行，请先完全退出酷狗再还原。'); process.exit(1); }
  for (const t of targets) restoreOne(t);
  process.exit(0);
}

console.log('发现 ' + targets.length + ' 个 libcef.dll：');
for (const t of targets) { const s = classify(t); console.log('  [' + s.state + '] ' + t); }
const patchable = targets.filter(t => classify(t).state === 'ORIGINAL');
if (!patchable.length) { console.log('\n没有可打补丁的目标（都已打过，或版本不匹配）。'); process.exit(0); }

if (kugouRunning()) {
  console.log('\n✖ 检测到酷狗正在运行。打补丁前请【完全退出酷狗】（含托盘图标），然后重新运行本脚本。');
  process.exit(1);
}

console.log('\n即将对 ' + patchable.length + ' 个文件打补丁（会自动备份，可 --restore 还原）。');
let ok = 0;
for (const t of patchable) { if (patchOne(t)) ok++; }
console.log('\n完成：成功 ' + ok + ' / ' + patchable.length + '。');
if (ok > 0) console.log('下一步：启动酷狗播放歌曲，然后运行  node tools\\cdp-probe.js  验证能否读到实时进度。');
