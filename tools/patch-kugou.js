/* 一次性补丁器：给酷狗的 libcef.dll 打开 CEF 远程调试端口 12233
 *
 * 原理（参考 PlayerCap, MIT）：CEF 89 x64 的 libcef.dll 在未设置调试端口时用哨兵
 * 0xAAAAAAAA。补丁把 9 处相关字节改成 12233(0x2FC9) 并 NOP 掉拦截/跳过调试端口的跳转，
 * 酷狗启动后就会一直开着 12233 端口，供我们用 CDP 读实时播放进度。
 *
 * 定位方式【特征扫描，不写死版本号/偏移】：按指令序列（相对跳转、哨兵字段通配）
 * 在文件中搜索 9 处补丁点。同一代码布局的任意构建（酷狗小版本更新导致偏移漂移）均可
 * 自动定位；32 位构建或代码布局不同时会明确报告"特征未找到"，绝不盲写。
 *
 * 安全设计：
 *   - 每处补丁点必须【唯一匹配】且当前字节形状可识别（原始/已补丁），否则拒绝写入
 *   - 自动检测 PE 机器类型：32 位构建（I386）直接判定不支持并说明原因
 *   - 首次写入前备份 libcef.dll -> libcef.dll.dtgc.bak（保留最原始副本）
 *   - 写入后重新校验，失败自动从备份回滚
 *
 * 用法（需管理员权限，且酷狗必须完全退出）：
 *   node tools\patch-kugou.js                     自动发现并打补丁
 *   node tools\patch-kugou.js "<libcef.dll路径>"   指定文件打补丁
 *   node tools\patch-kugou.js --restore           从备份还原（撤销补丁）
 *   node tools\patch-kugou.js --status            只查看状态，不写入
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 12233;
const PORT_BYTES = [0xC9, 0x2F, 0x00, 0x00];
const BAK_SUFFIX = '.dtgc.bak';
const NOP = 0x90;

/* ---------------- 模式工具：数字=固定字节，-1=单字节通配 ---------------- */
function f(s) { return s.split(' ').map(x => parseInt(x, 16)); } // 十六进制解析
function w(n) { return new Array(n).fill(-1); }
function cat(...parts) { return [].concat(...parts); }

/* 9 处补丁点分布在 3 个代码簇，按簇定义特征（含上下文指令，足够唯一）。
 * 洞（hole）= 补丁写入区；其字节在匹配时通配，状态单独判定。 */
const PAT_A1 = cat( // 簇A1：P1 主口哨兵初始化（x64）
  f('48 8d 74 24 60'), f('48 89 0e'), f('e8'), w(4), f('48 89 46 08'),
  f('48 89 f9 48 89 da 49 89 f0'), f('e8'), w(4), f('48 8d b4 24 2c 01 00 00'),
  f('c7 06'), w(4),                                   // P1 洞：mov dword[rsi], 哨兵/端口
  f('0f b6 43 17 84 c0 48 8b 13 48 0f 49 d3'), f('48 8d 8c 24 18 01 00 00'),
  f('48 89 11'), f('48 0f 48 43 08'), f('48 89 41 08'), f('48 89 f2')
);
const PAT_A2 = cat( // 簇A2：P4 call + P2 ja + P3 jz（拦截链）
  w(5),                                               // P4 洞：call rel32 / NOP×5
  f('81 3e fe ff 00 00'),                             // cmp dword[rsi], 0xfffe
  w(6),                                               // P2 洞：ja rel32 / NOP×6
  f('84 c0'),
  w(6),                                               // P3 洞：jz rel32 / NOP×6
  f('48 8d 8c 24 00 01 00 00 4c 89 61 10 0f 29 31'), f('e8'), w(4),
  f('83 bc 24 2c 01 00 00 00 75 12 48 8d 94 24 00 01 00 00 b9 ea 03 00 00'),
  f('e8'), w(4)
);
const PAT_B = cat( // 簇B：P5 子进程命令行端口
  f('80 7c 24 77 00 79 0a 48 8b 4c 24 60'), f('e8'), w(4), f('48 8d 4c 24 48'),
  f('4c 89 39'), f('e8'), w(4), f('48 8b ae'), w(4),
  w(6),                                               // P5 洞：mov edx,[ebp+disp] / mov edx,端口
  f('8d 82 00 fc ff ff 3d ff fb 00 00 77'), w(1),
  f('48 8d 5c 24 60 48 89 d9'), f('e8'), w(4)
);
const PAT_C1 = cat( // 簇C1：P6 jz(devtools) + P7 devtools 口哨兵
  f('48 31 e0'), f('48 89 84 24 80 00 00 00'), f('e8'), w(4), f('48 89 c6'),
  f('48 8d 1d'), w(4), f('48 89 c1 48 89 da'), f('e8'), w(4), f('84 c0'),
  w(6),                                               // P6 洞：jz rel32 / NOP×6
  f('4c 8d 7c 24 7c'),
  f('41 c7 07'), w(4),                                // P7 洞：mov dword[r15], 哨兵/端口
  f('48 b8'), w(8)                                    // mov rax, 0xAAAA…（64位哨兵，保留不动）
);
const PAT_C2 = cat( // 簇C2：P8 call + P9 cmovz
  f('0f b6 47 17 84 c0 48 8b 17 48 0f 49 d7 48 8d 4c 24 50 48 89 11'),
  f('48 0f 48 47 08 48 89 41 08 4c 89 fa'),
  w(5),                                               // P8 洞：call rel32 / NOP×5
  f('41 8b 1f 8d 8b 00 fc ff ff 31 d2 81 f9 ff fb 00 00 0f 43 da 84 c0'),
  w(3),                                               // P9 洞：cmovz ebx,ebx / NOP×3
  f('80 7f 17 00 79 0a 48 8b 4c 24 60'), f('e8'), w(4), f('66 85 db')
);
const SITES = [
  { name: 'P1 force port init',     pat: PAT_A1, holeOff: 39, holeLen: 6,
    isOrig: b => b[0] === 0xC7 && b[1] === 0x06 && b[2] === 0xAA && b[3] === 0xAA && b[4] === 0xAA && b[5] === 0xAA,
    isPatched: b => b[0] === 0xC7 && b[1] === 0x06 && b[2] === PORT_BYTES[0] && b[3] === PORT_BYTES[1] && b[4] === 0x00 && b[5] === 0x00,
    data: [0xC7, 0x06, ...PORT_BYTES] },
  { name: 'P4 NOP call',            pat: PAT_A2, holeOff: 0, holeLen: 5,
    isOrig: b => b[0] === 0xE8,
    isPatched: b => b.every(x => x === NOP),
    data: [NOP, NOP, NOP, NOP, NOP] },
  { name: 'P2 NOP ja(range)',       pat: PAT_A2, holeOff: 11, holeLen: 6,
    isOrig: b => b[0] === 0x0F && b[1] === 0x87,
    isPatched: b => b.every(x => x === NOP),
    data: [NOP, NOP, NOP, NOP, NOP, NOP] },
  { name: 'P3 NOP jz(parse ok)',    pat: PAT_A2, holeOff: 19, holeLen: 6,
    isOrig: b => b[0] === 0x0F && b[1] === 0x84,
    isPatched: b => b.every(x => x === NOP),
    data: [NOP, NOP, NOP, NOP, NOP, NOP] },
  { name: 'P5 child cmdline port',  pat: PAT_B, holeOff: 37, holeLen: 6,
    isOrig: b => b[0] === 0x8B && b[1] === 0x95,
    isPatched: b => b[0] === 0xBA && b[1] === PORT_BYTES[0] && b[2] === PORT_BYTES[1] && b[3] === 0x00 && b[4] === 0x00 && b[5] === NOP,
    data: [0xBA, ...PORT_BYTES, NOP] },
  { name: 'P6 NOP jz(devtools)',    pat: PAT_C1, holeOff: 39, holeLen: 6,
    isOrig: b => b[0] === 0x0F && b[1] === 0x84,
    isPatched: b => b.every(x => x === NOP),
    data: [NOP, NOP, NOP, NOP, NOP, NOP] },
  { name: 'P7 force port devtools', pat: PAT_C1, holeOff: 50, holeLen: 7,
    isOrig: b => b[0] === 0x41 && b[1] === 0xC7 && b[2] === 0x07 && b[3] === 0xAA && b[4] === 0xAA && b[5] === 0xAA && b[6] === 0xAA,
    isPatched: b => b[0] === 0x41 && b[1] === 0xC7 && b[2] === 0x07 && b[3] === PORT_BYTES[0] && b[4] === PORT_BYTES[1] && b[5] === 0x00 && b[6] === 0x00,
    data: [0x41, 0xC7, 0x07, ...PORT_BYTES] },
  { name: 'P8 NOP parse call',      pat: PAT_C2, holeOff: 33, holeLen: 5,
    isOrig: b => b[0] === 0xE8,
    isPatched: b => b.every(x => x === NOP),
    data: [NOP, NOP, NOP, NOP, NOP] },
  { name: 'P9 NOP cmovz',           pat: PAT_C2, holeOff: 60, holeLen: 3,
    isOrig: b => b[0] === 0x0F && b[1] === 0x44 && b[2] === 0xDA,
    isPatched: b => b.every(x => x === NOP),
    data: [NOP, NOP, NOP] },
];

/* ---------------- PE 机器类型（区分 x64 / x86 构建） ---------------- */
function peArch(buf) {
  try {
    if (buf.length < 0x100) return null;
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 6 > buf.length || buf[pe] !== 0x50 || buf[pe + 1] !== 0x45) return null;
    return buf.readUInt16LE(pe + 4); // 0x8664=x64, 0x14c=x86
  } catch (e) { return null; }
}
function archText(m) {
  if (m === 0x8664) return 'x64';
  if (m === 0x14c) return 'x86(32位)';
  return m == null ? '未知' : '0x' + m.toString(16);
}

/* ---------------- 特征扫描 ---------------- */
// 取模式里最长连续固定段作搜索锚点，命中后校验全部固定字节
function anchorOf(pat) {
  let bestLen = 0, bestStart = 0, run = 0;
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] >= 0) { run++; if (run > bestLen) { bestLen = run; bestStart = i - run + 1; } }
    else run = 0;
  }
  return { off: bestStart, buf: Buffer.from(pat.slice(bestStart, bestStart + bestLen)) };
}
function matchAt(buf, start, pat) {
  if (start < 0 || start + pat.length > buf.length) return false;
  for (let i = 0; i < pat.length; i++) if (pat[i] >= 0 && buf[start + i] !== pat[i]) return false;
  return true;
}
function findMatches(buf, pat) {
  const a = anchorOf(pat);
  const hits = [];
  let from = 0;
  for (;;) {
    const i = buf.indexOf(a.buf, from);
    if (i < 0) break;
    from = i + 1;
    const s = i - a.off;
    if (matchAt(buf, s, pat)) { hits.push(s); if (hits.length >= 4) break; } // >1 即歧义，多留几个备展示
  }
  return hits;
}

/* 逐点判定：ok(状态) | 'MISS'(特征未找到) | 'AMBIG'(多处匹配) | 'SHAPE'(唯一匹配但洞字节不可识别) */
function classifyBuffer(buf) {
  const arch = peArch(buf);
  if (arch !== 0x8664) {
    // 非 x64 构建：特征必然不存在，跳过扫描（省时且语义清晰）
    return { arch, sites: SITES.map(s => ({ site: s, state: 'MISS' })), overall: 'UNKNOWN' };
  }
  const sites = SITES.map((s) => {
    const hits = findMatches(buf, s.pat);
    if (hits.length === 0) return { site: s, state: 'MISS' };
    if (hits.length > 1) return { site: s, state: 'AMBIG', hits: hits.length };
    const hole = buf.slice(hits[0] + s.holeOff, hits[0] + s.holeOff + s.holeLen);
    if (s.isPatched(hole)) return { site: s, state: 'PATCHED', off: hits[0] + s.holeOff };
    if (s.isOrig(hole)) return { site: s, state: 'ORIGINAL', off: hits[0] + s.holeOff };
    return { site: s, state: 'SHAPE', off: hits[0] + s.holeOff };
  });
  const states = sites.map((r) => r.state);
  let overall;
  if (states.some((s) => s !== 'PATCHED' && s !== 'ORIGINAL')) overall = 'UNKNOWN';
  else if (states.every((s) => s === 'PATCHED')) overall = 'PATCHED';
  else if (states.every((s) => s === 'ORIGINAL')) overall = 'ORIGINAL';
  else overall = 'PARTIAL';
  return { arch, sites, overall };
}

/* ---------------- 文件级操作 ---------------- */
function classify(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return { state: 'NO_ACCESS', err: e.message }; }
  const r = classifyBuffer(buf);
  if (r.arch !== 0x8664) r.archNote = '该构建为 ' + archText(r.arch) + '，补丁仅支持 x64 版酷狗';
  r.state = r.overall;
  return r;
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

function printDetail(tag, r) {
  console.log('\n目标: ' + tag);
  if (r.state === 'NO_ACCESS') { console.log('  读取失败: ' + r.err); return; }
  if (r.archNote) console.log('  ⚠ ' + r.archNote);
  console.log('  机器类型: ' + archText(r.arch) + '   综合状态: ' + r.overall);
  for (const s of r.sites) {
    const off = s.off != null ? '@0x' + s.off.toString(16) : '';
    const why = s.state === 'MISS' ? '（特征未找到：版本布局不同）'
      : s.state === 'AMBIG' ? '（特征命中 ' + s.hits + ' 处，无法唯一定位）'
      : s.state === 'SHAPE' ? '（唯一匹配但洞字节不可识别：未知改动/其他补丁）' : '';
    console.log('    ' + s.site.name.padEnd(24) + s.state.padEnd(9) + off + why);
  }
}

function patchOne(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { console.log('\n目标: ' + file + '\n  读取失败: ' + e.message); return false; }
  const r = classifyBuffer(buf);
  printDetail(file, r);
  if (r.arch !== 0x8664) { console.log('  => 拒绝写入：' + r.archNote); return false; }
  if (r.overall === 'PATCHED') { console.log('  => 已打过补丁，跳过。'); return true; }
  if (r.overall !== 'ORIGINAL') {
    console.log('  => 拒绝写入：9 处补丁点未全部处于可识别的原始状态（见上表明细）。强行改会损坏 DLL。');
    return false;
  }
  let bak;
  try { bak = backup(file); } catch (e) {
    console.log('  => 备份失败（可能需要管理员权限）: ' + e.message); return false;
  }
  console.log('  已备份原始 DLL -> ' + bak);
  try {
    const fd = fs.openSync(file, 'r+');
    try {
      for (const s of r.sites) fs.writeSync(fd, Buffer.from(s.site.data), 0, s.site.data.length, s.off);
    } finally { fs.closeSync(fd); }
  } catch (e) {
    console.log('  => 写入失败（请以管理员身份运行，且确认酷狗已退出）: ' + e.message);
    try { fs.copyFileSync(bak, file); console.log('  已回滚。'); } catch (_) {}
    return false;
  }
  const after = classifyBuffer(fs.readFileSync(file));
  if (after.overall === 'PATCHED') { console.log('  => 补丁写入并校验成功 ✔ 端口将在酷狗下次启动时开启 (' + PORT + ')。'); return true; }
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
  for (const t of targets) {
    const r = classify(t);
    console.log(r.state.padEnd(10) + ' [' + archText(r.arch) + '] ' + t);
    if (r.sites) for (const s of r.sites) {
      const off = s.off != null ? '@0x' + s.off.toString(16) : '';
      console.log('           ' + s.site.name.padEnd(24) + s.state.padEnd(9) + off);
    }
  }
  process.exit(0);
}
if (mode === '--restore') {
  if (kugouRunning()) { console.log('检测到酷狗正在运行，请先完全退出酷狗再还原。'); process.exit(1); }
  for (const t of targets) restoreOne(t);
  process.exit(0);
}

console.log('发现 ' + targets.length + ' 个 libcef.dll：');
const results = targets.map(t => ({ t, r: classify(t) }));
for (const { t, r } of results) {
  console.log('  [' + r.state + '] [' + archText(r.arch) + '] ' + t);
  if (r.archNote) console.log('        ⚠ ' + r.archNote);
}
const patchable = results.filter(({ r }) => r.state === 'ORIGINAL');
if (!patchable.length) {
  console.log('\n没有可打补丁的目标（都已打过，或特征不匹配/32位构建）。明细：');
  for (const { t, r } of results) { if (r.sites) printDetail(t, r); }
  process.exit(0);
}

if (kugouRunning()) {
  console.log('\n✖ 检测到酷狗正在运行。打补丁前请【完全退出酷狗】（含托盘图标），然后重新运行本脚本。');
  process.exit(1);
}

console.log('\n即将对 ' + patchable.length + ' 个文件打补丁（会自动备份，可 --restore 还原）。');
let ok = 0;
for (const { t } of patchable) { if (patchOne(t)) ok++; }
console.log('\n完成：成功 ' + ok + ' / ' + patchable.length + '。');
if (ok > 0) console.log('下一步：启动酷狗播放歌曲，然后运行  node tools\\cdp-probe.js  验证能否读到实时进度。');
