/* 只读校验：检查目标 libcef.dll 在 9 个补丁偏移处的字节，
 * 是否等于「未打补丁(orig)」或「已打补丁(data)」。不做任何写入。
 * 偏移/字节来自 PlayerCap(MIT) 对 CEF 89.20.0 libcef.dll 的逆向。
 */
const fs = require('fs');

const PATCHES = [
  { name: 'P1 force port init',   off: 0x58C63EB, orig: [0xC7,0x06,0xAA,0xAA,0xAA,0xAA], data: [0xC7,0x06,0xC9,0x2F,0x00,0x00] },
  { name: 'P4 NOP call',          off: 0x58C6415, orig: [0xE8,0x96,0xA9,0xE9,0xFC],       data: [0x90,0x90,0x90,0x90,0x90] },
  { name: 'P2 NOP ja(range)',     off: 0x58C6420, orig: [0x0F,0x87,0x96,0x01,0x00,0x00],  data: [0x90,0x90,0x90,0x90,0x90,0x90] },
  { name: 'P3 NOP jz(parse ok)',  off: 0x58C6428, orig: [0x0F,0x84,0x8E,0x01,0x00,0x00],  data: [0x90,0x90,0x90,0x90,0x90,0x90] },
  { name: 'P5 child cmdline port',off: 0x4BC180E, orig: [0x8B,0x95,0x7C,0x01,0x00,0x00],  data: [0xBA,0xC9,0x2F,0x00,0x00,0x90] },
  { name: 'P6 NOP jz(devtools)',  off: 0x4BEDE41, orig: [0x0F,0x84,0x70,0x01,0x00,0x00],  data: [0x90,0x90,0x90,0x90,0x90,0x90] },
  { name: 'P7 force port devtools',off:0x4BEDE4C, orig: [0x41,0xC7,0x07,0xAA,0xAA,0xAA,0xAA], data: [0x41,0xC7,0x07,0xC9,0x2F,0x00,0x00] },
  { name: 'P8 NOP parse call',    off: 0x4BEDEB5, orig: [0xE8,0xF6,0x2E,0xB7,0xFD],       data: [0x90,0x90,0x90,0x90,0x90] },
  { name: 'P9 NOP cmovz',         off: 0x4BEDED0, orig: [0x0F,0x44,0xDA],                 data: [0x90,0x90,0x90] },
];

const target = process.argv[2];
if (!target || !fs.existsSync(target)) { console.log('NO_FILE: ' + target); process.exit(0); }

const fd = fs.openSync(target, 'r');
const stat = fs.fstatSync(fd);
console.log('FILE: ' + target);
console.log('SIZE: ' + (stat.size / 1048576).toFixed(1) + ' MB');

let orig = 0, patched = 0, unknown = 0;
for (const p of PATCHES) {
  const buf = Buffer.alloc(p.orig.length);
  fs.readSync(fd, buf, 0, p.orig.length, p.off);
  const actual = [...buf];
  const eqOrig = actual.every((b, i) => b === p.orig[i]);
  const eqData = actual.length === p.data.length && actual.every((b, i) => b === p.data[i]);
  let verdict;
  if (eqOrig) { verdict = 'ORIG(可打补丁)'; orig++; }
  else if (eqData) { verdict = 'DATA(已打补丁)'; patched++; }
  else { verdict = 'UNKNOWN(不匹配-危险)'; unknown++; }
  console.log('  ' + p.name.padEnd(24) + ' @0x' + p.off.toString(16) + '  actual=' + actual.map(b => b.toString(16).padStart(2, '0')).join(' ') + '  => ' + verdict);
}
fs.closeSync(fd);
console.log('SUMMARY: orig=' + orig + ' patched=' + patched + ' unknown=' + unknown + ' total=' + PATCHES.length);
if (unknown === 0 && patched === 0) console.log('RESULT: SAFE_TO_PATCH (全部 9 处为原始字节，可安全打补丁)');
else if (unknown === 0 && orig === 0) console.log('RESULT: ALREADY_PATCHED (已全部打过补丁)');
else if (unknown === 0) console.log('RESULT: PARTIALLY_PATCHED (部分已打，可补齐)');
else console.log('RESULT: DO_NOT_PATCH (有 ' + unknown + ' 处不匹配，版本不同，打补丁会有变砖风险)');
