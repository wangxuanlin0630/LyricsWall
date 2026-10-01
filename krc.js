/* 酷狗 .krc 本地歌词读取
 * KRC = 4字节头 + XOR(16字节密钥) + zlib压缩的 UTF-8 文本
 * 文本内含 [起始ms,持续ms] 逐行时间轴与 <字起始,字长,0> 逐字标签
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const KRC_KEY = [0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69];

function decodeKrc(buf) {
  const data = buf.slice(4); // 跳过头 4 字节（"krc1"）
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ KRC_KEY[i % 16];
  }
  return zlib.inflateSync(out).toString('utf-8').replace(/\0+$/g, '');
}

// 把 KRC 文本转成标准 LRC（去掉逐字标签），并提取标题/歌手
function krcToLrc(text) {
  const rows = String(text || '').split(/\r\n|\n|\r/);
  const out = [];
  let title = '';
  let artist = '';
  for (const raw of rows) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^\[ti:(.*)\]$/i))) { title = m[1].trim(); continue; }
    if ((m = line.match(/^\[ar:(.*)\]$/i))) { artist = m[1].trim(); continue; }
    m = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (m) {
      const startMs = parseInt(m[1], 10);
      const t = m[3].replace(/<[^>]*>/g, '').trim();
      if (!t) continue;
      const mm = String(Math.floor(startMs / 60000)).padStart(2, '0');
      const ss = ((startMs % 60000) / 1000).toFixed(2).padStart(5, '0');
      out.push(`[${mm}:${ss}]${t}`);
    }
  }
  return { lrc: out.join('\n'), title, artist };
}

// 从 KuGou.ini 读取 LyricPath，并给出若干默认候选目录
function getKugouLyricDir() {
  const candidates = [];
  const appdata = process.env.APPDATA;
  if (appdata) {
    const ini = path.join(appdata, 'KuGou8', 'KuGou.ini');
    try {
      if (fs.existsSync(ini)) {
        const content = fs.readFileSync(ini, 'utf-8');
        const m = content.match(/^\s*LyricPath\s*=\s*(.+?)\s*$/mi);
        if (m && m[1]) candidates.push(m[1].replace(/[\\/]+$/, ''));
      }
    } catch (e) { /* ignore */ }
  }
  candidates.push('D:\\KuGou\\Lyric');
  if (appdata) candidates.push(path.join(appdata, 'KuGou8', 'Lyric'));
  const local = process.env.LOCALAPPDATA;
  if (local) candidates.push(path.join(local, 'KuGou8', 'Lyric'));

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch (e) { /* ignore */ }
  }
  return null;
}

// 归一化用于模糊匹配：去空格、去括号副标题、只保留中英文数字
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s/g, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}

// 归一化歌名相似度 0~1：完全相同=1；一方包含另一方按长度比；否则按字符多重集交集比例。
// 用于在线/本地取词择优与防误配（避免"文件名恰好含这几个字"张冠李戴）。
function similarity(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const s = x.length <= y.length ? x : y;
  const l = x.length <= y.length ? y : x;
  if (l.indexOf(s) >= 0) return s.length / l.length;
  const cnt = {};
  for (const ch of l) cnt[ch] = (cnt[ch] || 0) + 1;
  let common = 0;
  for (const ch of s) { if (cnt[ch] > 0) { cnt[ch]--; common++; } }
  return common / l.length;
}

/* 根据歌名/歌手在酷狗本地缓存中查找并解码歌词
 * 返回 { text(标准LRC), title, artist, file } 或 null
 */
function findKugouLyrics(title, artist) {
  const dir = getKugouLyricDir();
  if (!dir) return null;

  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /\.krc$/i.test(f));
  } catch (e) {
    return null;
  }
  if (!files.length) return null;

  // 按修改时间倒序：正在播放的歌通常是最近访问的
  const withTime = files
    .map((f) => {
      const fp = path.join(dir, f);
      let mt = 0;
      try { mt = fs.statSync(fp).mtimeMs; } catch (e) {}
      return { f, fp, mt };
    })
    .sort((a, b) => b.mt - a.mt);

  const nTitle = norm(title);
  const nArtist = norm(artist);
  if (!nTitle || nTitle.length < 2) return null;   // 歌名过短极易误配，直接不猜

  for (const { f, fp } of withTime) {
    const nb = norm(f.replace(/\.krc$/i, ''));
    const titleOk = nb.includes(nTitle);
    const artistOk = !nArtist || nb.includes(nArtist);
    if (!(titleOk && artistOk)) continue;
    try {
      const text = decodeKrc(fs.readFileSync(fp));
      const { lrc, title: t2, artist: a2 } = krcToLrc(text);
      if (lrc && lrc.trim()) {
        // 二次校验：解码出的内部标题须与请求歌名足够相似，避免文件名子串误配到另一首歌
        if (similarity(t2 || title, title) < 0.45) continue;
        return { text: lrc, title: t2 || title, artist: a2 || artist, file: f };
      }
    } catch (e) {
      // 解码失败则继续找下一个候选
    }
  }
  return null;
}

/* 根据酷狗歌曲 hash 在本地缓存中精确查找并解码歌词
 * KRC 文件名内嵌 hash：形如 "歌手 - 歌名-{hash}-{id}-00000000.krc"
 * 返回 { text(标准LRC), title, artist, file } 或 null
 */
function findKugouLyricsByHash(hash) {
  const h = String(hash || '').trim().toLowerCase();
  if (!h) return null;
  const dir = getKugouLyricDir();
  if (!dir) return null;

  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /\.krc$/i.test(f) && f.toLowerCase().includes(h));
  } catch (e) {
    return null;
  }
  if (!files.length) return null;

  for (const f of files) {
    const fp = path.join(dir, f);
    try {
      const text = decodeKrc(fs.readFileSync(fp));
      const { lrc, title, artist } = krcToLrc(text);
      if (lrc && lrc.trim()) {
        return { text: lrc, title, artist, file: f };
      }
    } catch (e) {
      // 解码失败则继续下一个候选
    }
  }
  return null;
}

module.exports = { decodeKrc, krcToLrc, getKugouLyricDir, findKugouLyrics, findKugouLyricsByHash, norm, similarity };
