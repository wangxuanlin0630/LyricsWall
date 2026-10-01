const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');
const { createPlayerManager } = require('./players/registry');
const { createLyricsService } = require('./lyrics-service');
const { createWallServer } = require('./server/http-server');
const { createOutputWriter } = require('./server/output-writer');

let mainWindow = null;
let followActive = false;

/* ------------------- 全局异常兜底（F：记录不退出） ------------------- */
// 可写输出目录：开发期用项目 output/，打包后用 userData（asar 内不可写）
function getOutDir() {
  try {
    return app.isPackaged
      ? path.join(app.getPath('userData'), 'output')
      : path.join(__dirname, 'output');
  } catch (e) {
    return path.join(__dirname, 'output');
  }
}
function logCrash(tag, err) {
  try {
    const dir = getOutDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = '[' + new Date().toISOString() + '] ' + tag + ': ' +
      (err && err.stack ? err.stack : String(err)) + '\n';
    fs.appendFileSync(path.join(dir, 'crash.log'), line);
  } catch (e) { /* 忽略 */ }
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

/* ------------------- 布局/开关配置（持久化；桌面总控 → 广播驱动网页输出） ------------------- */
// 与 src/app.js 的 CONFIG_DEFAULTS 保持一致
const DEFAULT_CONFIG = {
  view: 'card',                                   // card | wall
  el_cover: true, el_title: true, el_artist: true, el_progress: true,
  el_times: true, el_wave: true, el_lyric: true, el_wall: true, el_glow: true,
  ft_follow: true, ft_output: true, ft_online: true, ft_beat: false, ft_lan: true,
  ft_player: 'auto',                              // 首选识别的播放器：auto | kugou | qq | netease | kuwo | ...
  ft_transparent: false,
  st_font: 6, st_rotate: 20, st_concurrent: 6, st_fadeIn: 0.9, st_hold: 6,
  st_color: '#ffffff', st_rainbow: true, st_glow: true,
  ty_family: 'system', ty_custom: '', ty_font_v: 0,
  lc_size: 100, lc_color: '#ffffff', lc_weight: 800, lc_spacing: 0, lc_shadow: true, lc_italic: false,
  pv_template: 'cyberRuins', pv_speed: 100, pv_size: 100, pv_motion: 100,
  pv_bgalpha: 100, pv_bpm: 120, pv_beat: 50, pv_fx_grain: true, pv_fx_scan: true, pv_fx_glitch: false,
  sh_anim: 'rotate', sh_speed: 100, sh_size: 100, sh_color: '#ffffff', sh_outline: true, sh_outline_color: '#000000', sh_outline_w: 4,
  box_size: 100, box_spacing: 0, box_color: '#101826', box_glow_color: '#78b4ff', box_glow: 90,
  box_alpha: 85, box_max: 5, box_stay: 4, box_in: 1, box_out: 1.2, box_rot: 45, box_spin: 15, box_echo: 3,
  bg_mode: 'cover', bg_custom_v: 0,
};
let layoutConfig = Object.assign({}, DEFAULT_CONFIG);

function configPath() {
  try {
    return app.isPackaged
      ? path.join(app.getPath('userData'), 'config.json')
      : path.join(__dirname, 'config.json');
  } catch (e) { return path.join(__dirname, 'config.json'); }
}
function loadConfig() {
  try {
    const p = configPath();
    if (fs.existsSync(p)) {
      const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
      layoutConfig = Object.assign({}, DEFAULT_CONFIG, obj || {});
      // 旧默认值迁移：板面改浅色后白字不可见、旋转上限 25→45（交叉构图）；仅命中旧默认值才改
      if (layoutConfig.box_color === '#ffffff') layoutConfig.box_color = '#101826';
      if (layoutConfig.box_rot === 25) layoutConfig.box_rot = 45;
      // 自定义背景不记忆：启动即释放，重开软件需重新选取图片
      if (layoutConfig.bg_mode === 'custom') { layoutConfig.bg_mode = 'cover'; layoutConfig.bg_custom_v = 0; }
    }
  } catch (e) { layoutConfig = Object.assign({}, DEFAULT_CONFIG); }
  return layoutConfig;
}
function saveConfig() {
  try {
    const p = configPath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(layoutConfig, null, 2), 'utf-8');
  } catch (e) { /* 忽略 */ }
}
// 主进程侧落地功能开关（在线歌词 / LAN 绑定）
function applyMainConfig(prev) {
  try { lyricsService.setOnlineEnabled(!!layoutConfig.ft_online); } catch (e) {}
  // 跟随总闸：关闭→桌面与网页/OBS 一起停止并清空输出；开启→用当前快照立即恢复
  if (prev && prev.ft_follow !== layoutConfig.ft_follow) applyFollowGate(!!layoutConfig.ft_follow);
  if (prev && prev.ft_lan !== layoutConfig.ft_lan) {
    try {
      wallServer.setHost(layoutConfig.ft_lan ? '0.0.0.0' : '127.0.0.1');
      wallServer.restart().then((p) => { serverPort = p; }).catch(() => {});
    } catch (e) {}
  }
  // 首选播放器：锁定只识别指定播放器（auto=多来源融合）
  if (!prev || prev.ft_player !== layoutConfig.ft_player) {
    try { playerManager.setPreferred(layoutConfig.ft_player || 'auto'); } catch (e) {}
  }
  // 字体变更：重新解析字体文件，供局域网网页/overlay 通过 @font-face 加载
  if (!prev || prev.ty_family !== layoutConfig.ty_family) {
    try { refreshFontFile().catch(() => {}); } catch (e) {}
  }
}

// 跟随总闸落地：关闭时向所有端广播“停止+空歌词”，开启时用当前快照立即恢复；
// 播放器探测始终常驻（snapshot 可用），仅门控对外广播，故重连能秒恢复。
function applyFollowGate(on) {
  if (on) {
    // 重新跟随＝回到自动：清除手动指定
    manualPin = null;
    try { wallServer.broadcastPin(null); } catch (e) {}
    if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('manual-pin', null); } catch (e) {} }
    try {
      const snap = playerManager.snapshot();
      if (snap) {
        lastUnified = snap;
        try { wallServer.broadcastState(snap); } catch (e) {}
        if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('nowplaying', snap); } catch (e) {} }
        try { lyricsService.forceRefresh(snap); } catch (e) {}   // 强制重解析并重广播歌词（同首歌也会重新推送）
      }
    } catch (e) {}
  } else {
    lastUnified = { ok: false, source: 'none', playerId: 'unknown', status: 'stopped', positionMs: 0, durationMs: 0, title: '', artist: '', ts: Date.now() };
    try { wallServer.broadcastState(lastUnified); } catch (e) {}
    if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('nowplaying', lastUnified); } catch (e) {} }
    try { broadcastLines({ key: '', title: '', artist: '', source: 'none', lines: [] }); } catch (e) {}
  }
}

/* ------------------- 核心服务：播放器融合 / 歌词 / 服务器 / 输出 ------------------- */
let lastUnified = null;   // 最近一次统一播放状态
let lastLines = null;     // 最近一次歌词 {key,title,artist,source,lines}
let manualPin = null;     // 手动指定的歌词 {idx,text}（手动优先级高于自动跟随，不受 ft_follow 门控）
let serverPort = 0;

const wallServer = createWallServer({ rootDir: __dirname });
wallServer.setStateProvider(() => lastUnified);
wallServer.setLinesProvider(() => lastLines);
wallServer.setConfigProvider(() => layoutConfig);
wallServer.setPinProvider(() => manualPin);

/* ------------------- 自定义背景图：选图→落盘 userData/backgrounds→HTTP 分发全端 ------------------- */
function bgDir() {
  try {
    return app.isPackaged
      ? path.join(app.getPath('userData'), 'backgrounds')
      : path.join(__dirname, 'output', 'backgrounds');
  } catch (e) { return path.join(__dirname, 'output', 'backgrounds'); }
}
/* ------------------- 本地歌词缓存目录：打包后 userData/lyrics-cache，开发期 output/lyrics-cache（asar 内不可写） ------------------- */
function lyricsCacheDir() {
  try {
    return app.isPackaged
      ? path.join(app.getPath('userData'), 'lyrics-cache')
      : path.join(__dirname, 'output', 'lyrics-cache');
  } catch (e) { return path.join(__dirname, 'output', 'lyrics-cache'); }
}
let bgCustomFile = null;
// 自定义背景不持久化：启动即删除上次落盘的图，重开软件需重新选取（与 loadConfig 里 bg_mode 复位配套）
(function clearBgCustom() {
  try {
    const dir = bgDir();
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (/^bg-custom\./i.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
    }
  } catch (e) {}
})();
wallServer.setBgProvider(() => (bgCustomFile ? { file: bgCustomFile } : null));

ipcMain.handle('bg:pick', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择背景图',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false };
    const src = r.filePaths[0];
    const dir = bgDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 清理旧图，统一命名 bg-custom.<ext>
    for (const f of fs.readdirSync(dir)) {
      if (/^bg-custom\./i.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
    }
    const ext = (path.extname(src) || '.png').toLowerCase();
    const dst = path.join(dir, 'bg-custom' + ext);
    fs.copyFileSync(src, dst);
    bgCustomFile = dst;
    const v = Date.now();
    Object.assign(layoutConfig, { bg_mode: 'custom', bg_custom_v: v });
    saveConfig();
    try { wallServer.broadcastConfig(layoutConfig); } catch (e) {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('config', layoutConfig); } catch (e) {}
    }
    return { ok: true, v };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

/* ------------------- 本机字体文件解析：字体名 → 磁盘文件，供局域网网页 @font-face 加载 ------------------- */
let currentFontFile = null;
// 预设键（非本机字体名）：这些不需要解析文件，网页端有内置回退
const FONT_PRESET_KEYS = ['system', 'yahei', 'simhei', 'simsun', 'kai', 'fangsong', 'lisu', 'youyuan', 'serif', 'mono', 'custom'];
function resolveFontFile(name) {
  return new Promise((resolve) => {
    if (!name) { resolve(null); return; }
    const safe = String(name).replace(/'/g, "''");
    // 从注册表 Fonts 键找字体家族名对应的文件名，再到系统/用户字体目录定位绝对路径
    const ps =
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
      "$n='" + safe + "';" +
      "$paths=@('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts','HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts');" +
      "$dirs=@((Join-Path $env:WINDIR 'Fonts'),(Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Fonts'));" +
      "$out='';" +
      "foreach($p in $paths){ if($out){break}; if(Test-Path $p){ $k=Get-ItemProperty $p; foreach($prop in $k.PSObject.Properties){ if($prop.Name -like ($n+'*')){ $v=$prop.Value; if($v){ if([System.IO.Path]::IsPathRooted($v)){ if(Test-Path $v){ $out=$v; break } } else { foreach($d in $dirs){ $fp=Join-Path $d $v; if(Test-Path $fp){ $out=$fp; break } } if($out){ break } } } } } } }" +
      "$out";
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) { resolve(null); return; }
          const f = String(stdout || '').replace(/^\ufeff/, '').trim();
          resolve(f || null);
        });
    } catch (e) { resolve(null); }
  });
}
wallServer.setFontProvider(() => (currentFontFile ? { file: currentFontFile } : null));
// 根据当前 ty_family 解析字体文件；本机字体才需解析，解析后 bump 版本号并广播（供网页缓存失效）
async function refreshFontFile() {
  const f = layoutConfig.ty_family;
  let file = null;
  if (f && FONT_PRESET_KEYS.indexOf(f) < 0) file = await resolveFontFile(f);
  currentFontFile = file;
  const v = Date.now();
  layoutConfig.ty_font_v = v;
  try { saveConfig(); } catch (e) {}
  try { wallServer.broadcastConfig(layoutConfig); } catch (e) {}
}

const outputWriter = createOutputWriter({ outDir: getOutDir() });

function broadcastLines(payload) {
  lastLines = payload;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('lyrics-lines', payload);
  }
  try { wallServer.broadcastLines(payload); } catch (e) {}
}

const lyricsService = createLyricsService((payload) => broadcastLines(payload), lyricsCacheDir());

const playerManager = createPlayerManager((ev) => {
  // 跟随总闸关闭：不更新快照、不向任何端广播（桌面与网页/OBS 一起停）
  if (!layoutConfig.ft_follow) return;
  lastUnified = ev;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('nowplaying', ev);
  }
  try { wallServer.broadcastState(ev); } catch (e) {}
  try { if (layoutConfig.ft_output) outputWriter.update(ev); } catch (e) {}
  try { lyricsService.handleEvent(ev); } catch (e) {}
});

function lanUrl() {
  let ip = '127.0.0.1';
  try {
    const ifaces = os.networkInterfaces();
    outer: for (const k of Object.keys(ifaces)) {
      for (const it of ifaces[k] || []) {
        if (it.family === 'IPv4' && !it.internal) { ip = it.address; break outer; }
      }
    }
  } catch (e) {}
  return 'http://' + ip + ':' + (serverPort || 8787) + '/';
}

function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();

  mainWindow = new BrowserWindow({
    width: Math.min(1040, workAreaSize.width),
    height: Math.min(700, workAreaSize.height),
    minWidth: 680,
    minHeight: 440,
    frame: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 歌词墙是视觉应用：后台/最小化时不节流 rAF 与动画，避免回前台堆词一起释放
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  loadConfig();
  try { refreshFontFile().catch(() => {}); } catch (e) {}
  wallServer.setHost(layoutConfig.ft_lan ? '0.0.0.0' : '127.0.0.1');
  try { lyricsService.setOnlineEnabled(!!layoutConfig.ft_online); } catch (e) {}
  createWindow();
  // 服务器与播放器探测常驻：网页/手机/OBS 随时可连，桌面跟随开关只影响本机墙
  wallServer.start().then((p) => { serverPort = p; }).catch(() => { serverPort = 0; });
  playerManager.start();
  try { playerManager.setPreferred(layoutConfig.ft_player || 'auto'); } catch (e) {}
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { playerManager.stop(); } catch (e) {}
  try { wallServer.stop(); } catch (e) {}
});

/* ------------------------- IPC: 窗口控制 ------------------------- */

ipcMain.handle('window:toggleFullscreen', () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
});

/* ---- 无边框窗口：自绘标题栏的最小化/最大化/关闭 ---- */
ipcMain.on('window:minimize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); });
ipcMain.on('window:maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.on('window:close', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); });

/* ------------------------- IPC: 本地文件 ------------------------- */

ipcMain.handle('dialog:openAudio', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择音乐文件',
    properties: ['openFile'],
    filters: [{ name: '音频', extensions: ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  return { path: filePath, name: path.basename(filePath) };
});

ipcMain.handle('dialog:openLrc', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择 LRC 歌词文件',
    properties: ['openFile'],
    filters: [{ name: '歌词', extensions: ['lrc', 'txt'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  try {
    const text = fs.readFileSync(res.filePaths[0], 'utf-8');
    return { path: res.filePaths[0], name: path.basename(res.filePaths[0]), text };
  } catch (e) {
    return { error: String(e) };
  }
});

/* ------------------------- IPC: 在线歌词（手动搜索面板用） ------------------------- */

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          Referer: 'https://music.163.com/',
          ...headers
        }
      },
      (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('响应解析失败'));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('请求超时')));
  });
}

ipcMain.handle('lyrics:search', async (_e, keyword) => {
  try {
    const url =
      'https://music.163.com/api/search/get/web?s=' +
      encodeURIComponent(keyword) +
      '&type=1&limit=10&offset=0';
    const json = await httpGetJson(url);
    const songs = (((json || {}).result || {}).songs) || [];
    return songs.map((s) => ({
      id: s.id,
      name: s.name,
      artist: (s.artists || []).map((a) => a.name).join(' / '),
      album: (s.album || {}).name || ''
    }));
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('lyrics:get', async (_e, id) => {
  try {
    const url = 'https://music.163.com/api/song/lyric?id=' + id + '&lv=1&kv=1&tv=-1';
    const json = await httpGetJson(url);
    const lrc = ((json || {}).lrc || {}).lyric || '';
    if (!lrc) return { error: '未找到歌词' };
    return { text: lrc };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
});

/* ------------------- IPC: 跟随开关 / 服务器信息 ------------------- */

ipcMain.on('follow:start', () => {
  followActive = true;
  try { playerManager.start(); } catch (e) {}
});

ipcMain.on('follow:stop', () => {
  followActive = false;
  // 播放器探测保持常驻（网页/OBS 仍需），仅本机墙退出跟随由渲染层处理
});

// 枚举当前可检测到的播放器 id（供桌面控制台“识别播放器”选择器标记活跃项）
ipcMain.handle('players:active', () => {
  try { return playerManager.getActivePlayers(); } catch (e) { return []; }
});

// 手动指定歌词（pin）：手动优先级高于自动；不受 ft_follow 门控，断开跟随后仍可手动驱动网页/OBS。
// 数据形状 {idx,text}（text 为主，供关跟随时 lines 为空也能显示）；传 null 取消回到自动。
ipcMain.on('manual:set', (_e, pin) => {
  manualPin = (pin && pin.text) ? { idx: pin.idx | 0, text: String(pin.text) } : null;
  try { wallServer.broadcastPin(manualPin); } catch (e) {}
  // 回推所有桌面窗口（多窗一致；渲染层 applyManualPin 幂等）
  if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('manual-pin', manualPin); } catch (e) {} }
});

ipcMain.handle('server:info', () => ({ port: serverPort || 0, url: lanUrl() }));

ipcMain.on('server:openBrowser', () => {
  try { shell.openExternal(lanUrl()); } catch (e) {}
});

// 手动强制重新取词（渲染层"重新匹配"按钮）：传 noCache=true 跳过本地缓存、取新词并覆盖旧缓存
ipcMain.on('lyrics:refresh', () => {
  try { lyricsService.forceRefresh(lastUnified, true); } catch (e) {}
});

// 网易云 seek 后手动对齐（渲染层点歌词行）：重设 nedb 锚点使进度跳到该句时间并继续跟随
ipcMain.on('progress:realign', (_e, positionMs) => {
  try { playerManager.realignNetease(Number(positionMs) || 0); } catch (e) {}
});

/* ------------------- IPC: 本机字体库枚举（Windows: System.Drawing.InstalledFontCollection） ------------------- */
let cachedFonts = null;
function querySystemFonts() {
  return new Promise((resolve) => {
    // UTF-8 输出以正确处理中文字体名（宋体/楷体/微软雅黑…）
    const ps =
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
      "Add-Type -AssemblyName System.Drawing;" +
      "(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }";
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) { resolve([]); return; }
          const list = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          resolve(list);
        });
    } catch (e) { resolve([]); }
  });
}
ipcMain.handle('fonts:list', async () => {
  if (cachedFonts && cachedFonts.length) return cachedFonts;
  const fonts = await querySystemFonts();
  if (fonts.length) cachedFonts = fonts;
  return fonts;
});

/* ------------------- IPC: 布局/开关配置（桌面总控 → 持久化 + 广播） ------------------- */
ipcMain.handle('config:get', () => layoutConfig);
ipcMain.handle('config:set', (_e, patch) => {
  const prev = Object.assign({}, layoutConfig);
  if (patch && typeof patch === 'object') Object.assign(layoutConfig, patch);
  saveConfig();
  applyMainConfig(prev);
  // 广播给网页/手机等所有 WS 客户端
  try { wallServer.broadcastConfig(layoutConfig); } catch (e) {}
  // 回推桌面（多窗口一致；applyConfig 幂等）
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('config', layoutConfig); } catch (e) {}
  }
  return layoutConfig;
});
