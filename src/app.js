/* 动态歌词墙 · 渲染层主控
 * 传输走 src/bridge.js 的 window.wallAPI（Electron=IPC / 浏览器=WebSocket）。
 * 播放状态消费主进程融合后的"统一事件"；歌词行消费主进程广播的 lines（多端同一份）。
 */
(function () {
  'use strict';

  const stage = document.getElementById('stage');
  const audio = document.getElementById('audio');
  const animator = new LyricsAnimator(stage);
  const wallAPI = window.wallAPI;
  const isElectron = wallAPI.isElectron;

  // 无边框窗口：标记桌面端（显示自绘标题栏），并接线窗口控制
  if (isElectron) {
    document.body.classList.add('electron');
    const tbMin = document.getElementById('tbMin');
    const tbMax = document.getElementById('tbMax');
    const tbClose = document.getElementById('tbClose');
    const tb = document.getElementById('titlebar');
    if (tbMin) tbMin.onclick = () => wallAPI.winMinimize();
    if (tbMax) tbMax.onclick = () => wallAPI.winMaximize();
    if (tbClose) tbClose.onclick = () => wallAPI.winClose();
    if (tb) tb.addEventListener('dblclick', (e) => {
      if (e.target.closest && e.target.closest('.tb-controls')) return;
      wallAPI.winMaximize();
    });
  }

  /* ---------------- 更新提示：主进程发现新版本后推送横幅（控制台开启时可见） ---------------- */
  (function () {
    const eapi = window.electronAPI;
    if (!eapi || !eapi.onUpdateAvailable) return;
    let bar = null;
    function show(d) {
      try {
        if (!bar) {
          bar = document.createElement('div');
          bar.id = 'updateBanner';
          bar.innerHTML = '<span class="ub-text"></span><span class="ub-btns">' +
            '<button class="ub-go" type="button">去下载</button>' +
            '<button class="ub-x" type="button" title="关闭提示">✕</button></span>';
          document.body.appendChild(bar);
          bar.querySelector('.ub-go').onclick = () => { try { eapi.openExternal(bar.dataset.url); } catch (e) {} };
          bar.querySelector('.ub-x').onclick = () => bar.classList.add('ub-hide');
        }
        bar.dataset.url = d.url || '';
        bar.querySelector('.ub-text').textContent = '发现新版本 ' + d.latest + '（当前 ' + d.current + '）';
        bar.classList.remove('ub-hide');
      } catch (e) {}
    }
    eapi.onUpdateAvailable(show);
  })();

  const RAINBOW = ['#ffffff', '#7fd4ff', '#ff9ecb', '#ffe28a', '#a0ffb0', '#c9a6ff'];

  /* ---------------- 配置（与 main.js DEFAULT_CONFIG 对齐）：所有元素/功能可开关 ---------------- */
  const CONFIG_DEFAULTS = {
    view: 'card',                                   // card | wall
    el_cover: true, el_title: true, el_artist: true, el_progress: true,
    el_times: true, el_wave: true, el_lyric: true, el_wall: true, el_glow: true,
    ft_follow: true, ft_output: true, ft_online: true, ft_beat: false, ft_lan: true,
    ft_player: 'auto',                            // 首选识别的播放器：auto | kugou | qq | netease | ...
    ft_transparent: false,                        // 透明背景输出（OBS/叠加）
    st_font: 6, st_rotate: 20, st_concurrent: 6, st_fadeIn: 0.9, st_hold: 6,
    st_color: '#ffffff', st_rainbow: true, st_glow: true,
    ty_family: 'system', ty_custom: '', ty_font_v: 0,
    lc_size: 100, lc_color: '#ffffff', lc_weight: 800, lc_spacing: 0, lc_shadow: true, lc_italic: false,
    pv_template: 'cyberRuins', pv_speed: 100, pv_size: 100, pv_motion: 100,
    pv_bgalpha: 100, pv_bpm: 120, pv_beat: 50, pv_fx_grain: true, pv_fx_scan: true, pv_fx_glitch: false,
    sh_anim: 'rotate', sh_speed: 100, sh_size: 100, sh_color: '#ffffff', sh_outline: true, sh_outline_color: '#000000', sh_outline_w: 4,
    box_size: 100, box_spacing: 0, box_color: '#101826', box_glow_color: '#78b4ff', box_glow: 90,
    box_alpha: 85, box_max: 5, box_stay: 4, box_in: 1, box_out: 1.2, box_rot: 45, box_spin: 15, box_echo: 3,
    bg_mode: 'cover', bg_custom_v: 0,             // 背景：封面光晕/纯黑/预设渐变/自定义图
  };
  // 字体预设（Windows 常见中文字体 + 通用族）；custom 时用 ty_custom 自定义 font-family
  const FONT_PRESETS = {
    system: '"Segoe UI","Microsoft YaHei",system-ui,-apple-system,sans-serif',
    yahei: '"Microsoft YaHei",sans-serif',
    simhei: 'SimHei,"Microsoft YaHei",sans-serif',
    simsun: 'SimSun,"宋体",serif',
    kai: 'KaiTi,"楷体",STKaiti,serif',
    fangsong: 'FangSong,"仿宋",STFangsong,serif',
    lisu: 'LiSu,"隶书",serif',
    youyuan: 'YouYuan,"幼圆",sans-serif',
    serif: 'Georgia,"Times New Roman",serif',
    mono: '"Cascadia Code",Consolas,"Courier New",monospace',
    custom: '',
  };
  const FONT_OPTIONS = [
    ['system', '系统默认'], ['yahei', '微软雅黑'], ['simhei', '黑体'], ['simsun', '宋体'],
    ['kai', '楷体'], ['fangsong', '仿宋'], ['lisu', '隶书'], ['youyuan', '幼圆'],
    ['serif', '衬线 Serif'], ['mono', '等宽 Mono'], ['custom', '自定义…'],
  ];
  // PV 模板选项（与 pv-templates.js 注册表对应）
  const PV_TEMPLATE_OPTIONS = [
    ['cyberRuins', '赛博废墟'], ['blueBold', '蓝色冲击'], ['geometric', '几何黄'],
    ['rainCity', '矩阵雨城'], ['staggered', '错落文字'], ['girlyClouds', '少女云朵'],
    ['haruhikage', '春日影'], ['classic', '经典金属'],
  ];
  const EL_KEYS = ['el_cover', 'el_title', 'el_artist', 'el_progress', 'el_times', 'el_wave', 'el_lyric', 'el_wall', 'el_glow'];
  const CONFIG_SCHEMA = [
    { group: '显示模式', icon: 'i-layout', items: [
      { key: 'view', type: 'seg', label: '视图', desc: '卡片＝iOS 卡+居中歌词；漂浮墙＝碎片满屏；PV＝逐字撒开；歌综＝底部描边大字幕；3D方块＝长方体歌词块空间漂浮', options: [['card', '卡片'], ['wall', '漂浮墙'], ['pv', 'PV 字效'], ['show', '歌综字幕'], ['box', '3D方块']] },
    ] },
    { group: '显示元素', icon: 'i-eye', items: [
      { key: 'el_cover', type: 'toggle', label: '封面', desc: '播放器封面图' },
      { key: 'el_title', type: 'toggle', label: '歌名', desc: '歌曲标题' },
      { key: 'el_artist', type: 'toggle', label: '歌手', desc: '歌手 / 作者' },
      { key: 'el_progress', type: 'toggle', label: '进度条', desc: '播放进度条' },
      { key: 'el_times', type: 'toggle', label: '时间', desc: '已播 / 剩余时间' },
      { key: 'el_wave', type: 'toggle', label: '波形', desc: '播放律动波形条' },
      { key: 'el_lyric', type: 'toggle', label: '居中大歌词', desc: '中央滚动/ PV 歌词区' },
      { key: 'el_wall', type: 'toggle', label: '漂浮碎片', desc: '漂浮墙模式碎片' },
      { key: 'el_glow', type: 'toggle', label: '背景光晕', desc: '封面环境光' },
    ] },
    { group: '背景', icon: 'i-image', items: [
      { key: 'bg_mode', type: 'seg', label: '背景模式', desc: '封面光晕 / 纯色 / 预设渐变 / 自定义图片；Alpha 透明开启时强制全透', options: [['cover', '封面光晕'], ['black', '纯黑'], ['g1', '星夜蓝'], ['g2', '极光紫'], ['g3', '暮色橙'], ['g4', '深海青'], ['custom', '自定义图']] },
      { key: 'bg_pick', type: 'action', label: '自定义背景图', desc: '选择本地图片，自动同步到网页/手机/OBS 输出', btn: '选择图片' },
    ] },
    { group: '功能', icon: 'i-settings', items: [
      { key: 'ft_follow', type: 'toggle', label: '跟随播放器', desc: '总开关：自动同步系统正在播放的歌曲；关闭后桌面与网页/OBS 一起停止输出，重新开启后一起继续' },
      { key: 'ft_player', type: 'player', label: '识别播放器', desc: '锁定只跟随指定播放器（它没在播放则显示无播放，不回退到其它）；绿点=当前系统检测到', options: [
        ['auto', '自动'], ['kugou', '酷狗音乐'], ['netease', '网易云音乐'], ['qq', 'QQ音乐']
      ] },
      { key: 'ft_output', type: 'toggle', label: '写文件输出', desc: '把播放状态写入 output/ 供外部读取' },
      { key: 'ft_online', type: 'toggle', label: '在线歌词兜底', desc: '本地无词时联网搜索' },
      { key: 'ft_beat', type: 'toggle', label: '音频律动(本地)', desc: '本地音频频谱律动' },
      { key: 'ft_lan', type: 'toggle', label: '局域网访问', desc: '允许手机/其他设备连接' },
      { key: 'ft_transparent', type: 'toggle', label: '透明背景(Alpha)', desc: '输出透明阿尔法通道（浏览器 / OBS）' },
    ] },
    { group: '漂浮墙样式', icon: 'i-palette', items: [
      { key: 'st_font', type: 'range', label: '字号', min: 2, max: 12, step: 0.5 },
      { key: 'st_rotate', type: 'range', label: '旋转', min: 0, max: 45, step: 1 },
      { key: 'st_concurrent', type: 'range', label: '同屏数', min: 1, max: 12, step: 1 },
      { key: 'st_fadeIn', type: 'range', label: '飞入(s)', min: 0.2, max: 3, step: 0.1 },
      { key: 'st_hold', type: 'range', label: '停留(s)', min: 1, max: 12, step: 0.5 },
      { key: 'st_color', type: 'color', label: '颜色' },
      { key: 'st_rainbow', type: 'toggle', label: '多彩', desc: '多色循环' },
      { key: 'st_glow', type: 'toggle', label: '发光', desc: '碎片发光' },
    ] },
    { group: '字体', icon: 'i-type', items: [
      { key: 'ty_family', type: 'select', label: '字体', desc: '全局字体：预设或本机已安装字体（各模式共用）', options: FONT_OPTIONS, fontList: true },
      { key: 'ty_custom', type: 'text', label: '自定义字体', placeholder: 'font-family，如 "HarmonyOS Sans SC", sans-serif' },
    ] },
    { group: '居中歌词', icon: 'i-align-center', items: [
      { key: 'lc_size', type: 'range', label: '字号%', min: 60, max: 200, step: 5 },
      { key: 'lc_color', type: 'color', label: '颜色' },
      { key: 'lc_weight', type: 'range', label: '字重', min: 300, max: 900, step: 100 },
      { key: 'lc_spacing', type: 'range', label: '字间距', min: -2, max: 16, step: 0.5 },
      { key: 'lc_shadow', type: 'toggle', label: '发光阴影', desc: '当前行外发光' },
      { key: 'lc_italic', type: 'toggle', label: '斜体' },
    ] },
    { group: 'PV 字效', icon: 'i-video', items: [
      { key: 'pv_template', type: 'select', label: 'PV 模板', desc: '日式 PV 字效模板（PixiJS WebGL 渲染）', options: PV_TEMPLATE_OPTIONS },
      { key: 'pv_speed', type: 'range', label: '动画速度%', desc: '50–300，100＝原速', min: 50, max: 300, step: 10 },
      { key: 'pv_size', type: 'range', label: '字号%', min: 60, max: 200, step: 5 },
      { key: 'pv_motion', type: 'range', label: '运动幅度%', desc: '漂浮/抖动强度，0＝静止', min: 0, max: 200, step: 10 },
      { key: 'pv_bgalpha', type: 'range', label: '背景不透明度%', desc: '模板底色浓度；透明输出时忽略', min: 0, max: 100, step: 5 },
      { key: 'pv_bpm', type: 'range', label: 'BPM', desc: '合成节拍速度', min: 60, max: 200, step: 1 },
      { key: 'pv_beat', type: 'range', label: '节拍反应%', desc: '文字随节拍脉冲强度', min: 0, max: 100, step: 5 },
      { key: 'pv_fx_grain', type: 'toggle', label: '胶片颗粒' },
      { key: 'pv_fx_scan', type: 'toggle', label: '扫描线' },
      { key: 'pv_fx_glitch', type: 'toggle', label: '故障抖动' },
    ] },
    { group: '3D 长方体', icon: 'i-cube', items: [
      { key: 'box_size', type: 'range', label: '字号%', desc: '文字与长方体整体大小', min: 50, max: 200, step: 5 },
      { key: 'box_spacing', type: 'range', label: '字间距', min: -2, max: 30, step: 1 },
      { key: 'box_color', type: 'color', label: '文字颜色', desc: '浅色板面上的字色，建议深色' },
      { key: 'box_glow_color', type: 'color', label: '板面色/发光', desc: '板面取该色混白的浅色调，光晕同色' },
      { key: 'box_glow', type: 'range', label: '发光强度%', desc: '60–120，emissiveIntensity', min: 30, max: 150, step: 5 },
      { key: 'box_alpha', type: 'range', label: '透明度%', desc: '长方体材质不透明度，默认 85', min: 30, max: 100, step: 5 },
      { key: 'box_max', type: 'range', label: '同屏最大数', desc: '2–8，超出时最旧整簇提前离场', min: 2, max: 8, step: 1 },
      { key: 'box_echo', type: 'range', label: '每句重复数', desc: '同句歌词多块板条回声簇漂浮（视频同款），1＝单块', min: 1, max: 5, step: 1 },
      { key: 'box_stay', type: 'range', label: '停留(s)', desc: '默认 4 秒后淡出飘散', min: 1, max: 20, step: 0.5 },
      { key: 'box_in', type: 'range', label: '入场(s)', min: 0.2, max: 3, step: 0.1 },
      { key: 'box_out', type: 'range', label: '出场(s)', min: 0.2, max: 3, step: 0.1 },
      { key: 'box_rot', type: 'range', label: '随机旋转上限°', desc: '各轴 ±角度，默认 45（交叉构图）', min: 0, max: 90, step: 1 },
      { key: 'box_spin', type: 'range', label: '自转速度°/min', desc: '停留时缓慢自转，默认 15', min: 0, max: 60, step: 1 },
    ] },
    { group: '歌综字幕', icon: 'i-subtitle', items: [
      { key: 'sh_anim', type: 'seg', label: '进出场动画', desc: '轮换＝每句自动换一种', options: [['rotate', '轮换'], ['fly', '飞入飞出'], ['fade', '淡入淡出'], ['pop', '弹入缩出'], ['slide', '滑入滑出']] },
      { key: 'sh_speed', type: 'range', label: '动画速度%', desc: '100＝原速，越大越快', min: 50, max: 200, step: 10 },
      { key: 'sh_size', type: 'range', label: '字号%', min: 60, max: 200, step: 5 },
      { key: 'sh_color', type: 'color', label: '字幕颜色' },
      { key: 'sh_outline', type: 'toggle', label: '描边', desc: '关闭后只保留投影' },
      { key: 'sh_outline_color', type: 'color', label: '描边颜色' },
      { key: 'sh_outline_w', type: 'range', label: '描边粗细', min: 0, max: 12, step: 1 },
    ] },
  ];
  let config = Object.assign({}, CONFIG_DEFAULTS);
  const consoleControls = {};
  let playerChipMap = null;        // ft_player 选择器的 chip 映射（供活跃绿点标记）
  let playerPollStarted = false;   // 活跃播放器轮询仅启动一次

  let lines = [];
  let pointer = 0;
  let beatEnabled = false;
  let followMode = false;
  let pvMode = false;
  let showMode = false;
  let boxMode = false;

  // 跟随模式统一时间轴（来自主进程融合事件）
  const follow = {
    key: '', offset: 0, lostCount: 0,
    status: 'stopped',            // playing / paused / stopped
    source: 'none',               // cdp / smtc / none
    playerId: 'unknown',
    positionMs: 0, durationMs: 0,
    updatedMs: 0, rate: 1,
    cover: '', title: '', artist: '',
    prevPos: -1, prevUpdated: 0,
    // 无真实进度时的墙钟估算时钟
    base: 0, segStart: 0
  };

  let audioCtx = null, analyser = null, freqData = null, mediaSrc = null;
  let lastBeatTime = 0, energyHistory = [];

  /* ---------------- DOM ---------------- */
  const el = {
    cover: document.getElementById('cover'),
    trackName: document.getElementById('trackName'),
    artistName: document.getElementById('artistName'),
    lrcBadge: document.getElementById('lrcBadge'),
    statusBadge: document.getElementById('statusBadge'),
    syncStatus: document.getElementById('syncStatus'),
    syncHint: document.getElementById('syncHint'),
    serverUrl: document.getElementById('serverUrl'),
    btnPlay: document.getElementById('btnPlay'),
    btnFullscreen: document.getElementById('btnFullscreen'),
    btnOpenAudio: document.getElementById('btnOpenAudio'),
    btnOpenLrc: document.getElementById('btnOpenLrc'),
    btnFollow: document.getElementById('btnFollow'),
    btnOpenWeb: document.getElementById('btnOpenWeb'),
    btnRefreshLyrics: document.getElementById('btnRefreshLyrics'),
    btnPrevMode: document.getElementById('btnPrevMode'),
    sideNav: document.getElementById('sideNav'),
    panelArea: document.getElementById('panelArea'),
    previewPane: document.getElementById('previewPane'),
    seek: document.getElementById('seek'),
    volume: document.getElementById('volume'),
    curTime: document.getElementById('curTime'),
    durTime: document.getElementById('durTime'),
    previewList: document.getElementById('previewList'),
    searchInput: document.getElementById('searchInput'),
    btnSearch: document.getElementById('btnSearch'),
    searchResults: document.getElementById('searchResults'),
    pasteArea: document.getElementById('pasteArea'),
    btnApplyPaste: document.getElementById('btnApplyPaste'),
    btnPreview: document.getElementById('btnPreview'),
    btnCopyLrc: document.getElementById('btnCopyLrc'),
    btnAutoLrc: document.getElementById('btnAutoLrc'),
    pvSource: document.getElementById('pvSource'),
    btnOffsetUp: document.getElementById('btnOffsetUp'),
    btnOffsetDown: document.getElementById('btnOffsetDown'),
    btnRealign: document.getElementById('btnRealign'),
    offsetVal: document.getElementById('offsetVal'),
    bgGlow: document.getElementById('bgGlow'),
    lyricCenter: document.getElementById('lyricCenter'),
    lyricScroll: document.getElementById('lyricScroll'),
    pvStage: document.getElementById('pvStage'),
    showStage: document.getElementById('showStage'),
    bgCustom: document.getElementById('bgCustom'),
    npCover: document.getElementById('npCover'),
    npTitleScroller: document.getElementById('npTitleScroller'),
    npArtist: document.getElementById('npArtist'),
    npCur: document.getElementById('npCur'),
    npRem: document.getElementById('npRem'),
    npFill: document.getElementById('npFill')
  };

  /* ---------------- 工具 ---------------- */
  function fmt(sec) {
    if (!isFinite(sec)) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function toFileUrl(p) {
    return encodeURI('file:///' + p.replace(/\\/g, '/'));
  }
  function hasPos() {
    return follow.durationMs > 0 && follow.updatedMs > 0;
  }

  /* ---------------- 歌词应用 ---------------- */
  // 手动/本地/粘贴：解析 LRC 文本
  function applyLrc(text, sourceName) {
    lastRawLrc = text || '';
    const parsed = LRC.parse(text);
    setLines(parsed.lines, sourceName);
  }
  // 主进程广播：直接给 lines 数组
  function applyLines(arr, sourceName) {
    setLines(Array.isArray(arr) ? arr : [], sourceName);
  }
  function setLines(newLines, sourceName) {
    lines = newLines || [];
    pointer = 0;
    animator.clear();
    // 新歌/新词：清除手动指定回到自动（仅桌面总控发起，广播到各端同步）
    if (isElectron && manualPin) setManualPin(null);
    if (followMode) {
      const t = currentTime();
      while (pointer < lines.length && lines[pointer].time < t) pointer++;
    }
    if (lines.length) {
      el.lrcBadge.textContent = sourceName || ('已加载 ' + lines.length + ' 句');
      el.lrcBadge.classList.add('ok');
      if (el.pvSource) el.pvSource.textContent = (sourceName || '已加载歌词') + ' · ' + lines.length + ' 句';
    } else {
      el.lrcBadge.textContent = '无歌词';
      el.lrcBadge.classList.remove('ok');
      if (el.pvSource) el.pvSource.textContent = '未加载歌词';
    }
    renderPreviewList();
    renderCenterList();
    highlightCenter(currentLineIndex(currentTime()), true);
    feedBoxLyrics(true);   // 3D 方块引擎同步新歌词并清场
  }

  /* ---------------- 歌词预览面板 ---------------- */
  let previewRows = [];
  let previewCurIdx = -1;
  function renderPreviewList() {
    el.previewList.innerHTML = '';
    previewRows = [];
    previewCurIdx = -1;
    const frag = document.createDocumentFragment();
    lines.forEach((ln, i) => {
      const div = document.createElement('div');
      div.className = 'pv-row';
      div.dataset.idx = i;
      const span = document.createElement('span');
      span.className = 'pv-text';
      span.textContent = ln.text;
      // 对齐按钮：网易云 seek 后点当前正在唱的这句，把进度锚点对齐到该句时间（点行文本仍是 pin 手动指定）
      const btn = document.createElement('button');
      btn.className = 'pv-align';
      btn.type = 'button';
      btn.title = '对齐到这句（网易云拖动进度条后，点当前正在唱的句子）';
      btn.textContent = '⏱';
      btn.onclick = (e) => { e.stopPropagation(); alignToLine(i); };
      div.appendChild(span);
      div.appendChild(btn);
      div.onclick = () => onPreviewClick(i);
      frag.appendChild(div);
      previewRows.push(div);
    });
    el.previewList.appendChild(frag);
  }
  function onPreviewClick(i) {
    const ln = lines[i];
    if (!ln) return;
    // 手动指定/取消指定这句歌词（手动优先级高于自动跟随）；再次点击已选中的行＝取消回到自动
    if (manualPin && manualPin.idx === i) setManualPin(null);
    else setManualPin({ idx: i, text: ln.text });
  }
  // 手动对齐：把当前播放位置对齐到这句歌词的时间。主要解决网易云 seek——网易云不回报拖动后的位置，
  // 用户点当前正在唱的句子即可重设锚点（主进程 nedb.realign），之后进度从这句继续 1:1 跟随。
  function alignToLine(i) {
    const ln = lines[i];
    if (!ln) return;
    if (manualPin) setManualPin(null);          // 取消手动常驻，回到自动跟随让对齐生效
    follow.offset = 0; try { updateOffsetLabel(); } catch (e) {}   // 清零微调，使这句精确落在当前位置
    try { wallAPI.realignProgress(Math.round(ln.time * 1000)); } catch (e) {}
    flashRow(i);
  }
  function flashRow(i) {
    const row = previewRows[i];
    if (!row) return;
    row.classList.remove('aligned');
    void row.offsetWidth;                        // 强制重排以便重复触发动画
    row.classList.add('aligned');
    setTimeout(() => { try { row.classList.remove('aligned'); } catch (e) {} }, 800);
  }
  function highlightPreview(idx, force) {
    if (idx === previewCurIdx && !force) return;
    if (previewCurIdx >= 0 && previewRows[previewCurIdx]) previewRows[previewCurIdx].classList.remove('cur');
    previewCurIdx = idx;
    const row = previewRows[idx];
    if (row) {
      row.classList.add('cur');
      // 自动滚动居中
      const box = el.previewList;
      const target = row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2;
      box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  }
  function currentLineIndex(t) {
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= t) idx = i; else break;
    }
    return idx;
  }

  /* ---------------- 手动指定歌词（pin）：手动优先级 > 自动跟随 ----------------
   * 桌面点选列表行设定/取消；主进程广播到所有端（桌面多窗 + 网页 + OBS overlay）。
   * pin 以 text 为主，故关闭跟随（lines 为空）时网页仍能显示手动指定的那句。 */
  let manualPin = null;   // {idx,text} 或 null
  function setManualPin(pin) {
    manualPin = (pin && pin.text) ? { idx: pin.idx | 0, text: String(pin.text) } : null;
    if (isElectron) { try { wallAPI.setManualPin(manualPin); } catch (e) {} }
    applyManualPin();
  }
  // 3D 方块：pin 时只喂这一句（时间固定 0，停留态常驻不退出）；取消时重喂完整歌词
  function primeBoxPin() {
    if (!(window.BoxEngine && BoxEngine.isActive())) return;
    if (manualPin) {
      BoxEngine.reset();
      BoxEngine.setLyrics([{ time: 0, text: manualPin.text }]);
      BoxEngine.setTime(0);
    } else {
      feedBoxLyrics(true);
    }
  }
  function applyManualPin() {
    for (let i = 0; i < previewRows.length; i++) {
      previewRows[i].classList.toggle('pinned', !!(manualPin && manualPin.idx === i));
    }
    document.body.classList.toggle('manual-pin', !!manualPin);
    if (manualPin) {
      if (viewMode === 'box') primeBoxPin();
      else if (viewMode === 'wall') { animator.clear(); pointer = lines.length; if (manualPin.text) animator.spawn(manualPin.text, 6); }
      else highlightCenter(manualPin.idx, true);   // card/pv/show
    } else {
      if (viewMode === 'box') primeBoxPin();
      else if (viewMode === 'wall') { pointer = 0; skipTo(currentTime()); }
      else highlightCenter(currentLineIndex(currentTime()), true);
    }
  }

  /* ---------------- 音频加载（本地模式） ---------------- */
  async function openAudio() {
    if (isElectron) {
      const res = await wallAPI.openAudio();
      if (!res) return;
      audio.src = toFileUrl(res.path);
      el.trackName.textContent = res.name;
      autoMatchLyrics(res.name.replace(/\.[^.]+$/, ''));
      audio.play().catch(() => {});
    } else {
      pickFile('audio/*', (file) => {
        audio.src = URL.createObjectURL(file);
        el.trackName.textContent = file.name;
        autoMatchLyrics(file.name.replace(/\.[^.]+$/, ''));
        audio.play().catch(() => {});
      });
    }
  }
  async function openLrcFile() {
    if (isElectron) {
      const res = await wallAPI.openLrc();
      if (!res || res.error) return;
      applyLrc(res.text, res.name);
    } else {
      pickFile('.lrc,.txt,text/plain', (file) => {
        const r = new FileReader();
        r.onload = () => applyLrc(r.result, file.name);
        r.readAsText(file);
      });
    }
  }
  function pickFile(accept, cb) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => { if (input.files[0]) cb(input.files[0]); };
    input.click();
  }

  // 本地模式自动匹配在线歌词
  async function autoMatchLyrics(keyword) {
    if (!isElectron) return;
    const trySearch = async (kw) => {
      const songs = await wallAPI.searchLyrics(kw);
      return Array.isArray(songs) ? songs : [];
    };
    let songs = await trySearch(keyword);
    if (!songs.length) {
      const cleaned = keyword.replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, ' ').trim();
      if (cleaned && cleaned !== keyword) songs = await trySearch(cleaned);
    }
    if (!songs.length) return;
    const lyric = await wallAPI.getLyrics(songs[0].id);
    if (lyric && lyric.text) applyLrc(lyric.text, '在线：' + songs[0].name);
  }

  // 手动歌词原文（复制用）；自动匹配广播到达时清空，回退为按 lines 生成 LRC
  let lastRawLrc = '';
  const MANUAL_ERR_TEXT = {
    'no-playing': '未检测到正在播放的歌曲，请先在「跟随」页开启跟随',
    'empty': '没解析到歌词行：纯文本需要播放器提供歌曲时长才能分配时间轴',
    'no-key': '当前歌曲信息不全，无法绑定',
  };
  function manualErrText(err) { return MANUAL_ERR_TEXT[err] || ('应用失败：' + (err || '未知错误')); }

  // 跟随模式：手动歌词交主进程（广播全端、自动匹配不覆盖、切歌自动失效）；本地模式：直接解析应用
  async function applyManualLyric(text) {
    if (followMode && isElectron) {
      const r = await wallAPI.setManualLyrics(text);
      return (r && r.ok) ? { ok: true, count: r.count } : { ok: false, error: manualErrText(r && r.error) };
    }
    const parsed = LRC.parse(text);
    if (!parsed.lines.length) return { ok: false, error: '本地播放模式请粘贴带 [mm:ss] 时间轴的 LRC' };
    applyLrc(text, '手动歌词');
    return { ok: true, count: parsed.lines.length };
  }

  async function doSearch() {
    const kw = el.searchInput.value.trim();
    if (!kw) return;
    if (!isElectron) { el.searchResults.innerHTML = '<div class="hint">网页端不支持在线搜索，请在桌面端操作。</div>'; return; }
    el.searchResults.innerHTML = '<div class="hint">搜索中…</div>';
    const songs = await wallAPI.searchLyrics(kw);
    if (!Array.isArray(songs)) {
      el.searchResults.innerHTML = '<div class="hint">搜索失败：' + (songs.error || '未知错误') + '</div>';
      return;
    }
    if (!songs.length) { el.searchResults.innerHTML = '<div class="hint">没有找到结果</div>'; return; }
    el.searchResults.innerHTML = '';
    for (const s of songs) {
      const item = document.createElement('div');
      item.className = 'result-item';
      item.innerHTML = '<div class="t"></div><div class="s"></div>';
      item.querySelector('.t').textContent = s.name;
      const subEl = item.querySelector('.s');
      const subText = (s.artist || '') + (s.album ? ' · ' + s.album : '');
      subEl.textContent = subText;
      item.onclick = async () => {
        if (item.dataset.busy === '1') return;
        item.dataset.busy = '1';
        item.classList.add('picked');
        subEl.textContent = '加载歌词中…';
        const lyric = await wallAPI.getLyrics(s.id);
        if (lyric && lyric.text) {
          const r = await applyManualLyric(lyric.text);
          if (r.ok) {
            lastRawLrc = lyric.text;
            subEl.textContent = '✓ 已应用 · ' + subText;
            switchLyricsTab('preview');   // 立刻在预览标签展示完整歌词（可点选/复制）
          } else {
            subEl.textContent = r.error + '（点此重试）';
            item.classList.remove('picked');
          }
        } else {
          subEl.textContent = (lyric.error || '获取失败') + '（点此重试）';
          item.classList.remove('picked');
        }
        item.dataset.busy = '';
      };
      el.searchResults.appendChild(item);
    }
  }

  /* ---------------- 播放控制（本地模式） ---------------- */
  function togglePlay() {
    if (followMode) return;
    if (!audio.src) { openAudio(); return; }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }
  el.seek.addEventListener('input', () => {
    if (followMode) return;
    if (!isFinite(audio.duration)) return;
    audio.currentTime = (el.seek.value / 1000) * audio.duration;
  });
  audio.addEventListener('seeked', () => resyncPointer());
  audio.addEventListener('play', () => { el.btnPlay.classList.add('is-playing'); });
  audio.addEventListener('pause', () => { el.btnPlay.classList.remove('is-playing'); });

  function resyncPointer() {
    const t = audio.currentTime;
    animator.clear();
    pointer = 0;
    while (pointer < lines.length && lines[pointer].time < t) pointer++;
  }

  /* ---------------- 同步循环 ---------------- */
  function internalTime() {
    let t = follow.base;
    if (follow.status === 'playing' && follow.segStart) t += (Date.now() - follow.segStart) / 1000;
    return t;
  }
  function followTime() {
    if (hasPos()) {
      let ms = follow.positionMs;
      if (follow.status === 'playing' && follow.updatedMs) {
        ms += Math.max(0, Date.now() - follow.updatedMs) * (follow.rate || 1);
      }
      return ms / 1000;
    }
    return internalTime();
  }
  function currentTime() {
    if (followMode) return followTime() + follow.offset;
    return audio.currentTime;
  }
  function resyncTo(t) {
    animator.clear();
    pointer = 0;
    while (pointer < lines.length && lines[pointer].time < t) pointer++;
  }
  function skipTo(t) {
    while (pointer < lines.length && lines[pointer].time < t) pointer++;
  }

  let lastLoopT = -1;
  function loop() {
    if (followMode) {
      const tc = currentTime();
      el.curTime.textContent = fmt(tc);
      const dur = follow.durationMs > 0
        ? follow.durationMs / 1000
        : (lines.length ? lines[lines.length - 1].time : 0);
      el.durTime.textContent = fmt(dur);
      if (dur > 0) el.seek.value = Math.min(1000, Math.round((tc / dur) * 1000));
      // 预览面板高亮（手动指定时冻结自动高亮）
      if (!manualPin) highlightPreview(currentLineIndex(tc), false);
    } else if (!audio.paused && isFinite(audio.duration)) {
      el.curTime.textContent = fmt(audio.currentTime);
      el.seek.value = Math.round((audio.currentTime / audio.duration) * 1000);
      if (!manualPin) highlightPreview(currentLineIndex(audio.currentTime), false);
    }
    el.seek.style.setProperty('--pct', (el.seek.value / 10) + '%');
    updateNpProgress();

    const t = currentTime();
    const stalled = lastLoopT >= 0 && (t - lastLoopT) > 0.8;
    lastLoopT = t;
    // 手动指定时不按时间轴自动飘词（墙视图只显示手动那句）
    if (!manualPin) {
      if (!stalled) {
        while (pointer < lines.length && lines[pointer].time <= t) {
          const line = lines[pointer];
          if (line.text) animator.spawn(line.text, line.duration);
          pointer++;
        }
      } else {
        skipTo(t);
      }
    }

    if (beatEnabled && analyser && !followMode) detectBeat();
    updateWave(performance.now());
    // 3D 方块视图：每帧喂播放时间驱动生成/离场；手动指定时固定喂 0 让那句常驻
    if (viewMode === 'box' && window.BoxEngine && BoxEngine.isActive()) BoxEngine.setTime(manualPin ? 0 : currentTime());
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastLoopT = currentTime();
      skipTo(lastLoopT);
    }
  });

  /* ---------------- 统一播放状态（跟随） ---------------- */
  wallAPI.onNowPlaying((d) => {
    if (!followMode || !d) return;

    if (d.ok && d.title) {
      follow.lostCount = 0;
      const prevStatus = follow.status;
      follow.status = d.status || 'stopped';
      follow.source = d.source || 'smtc';
      follow.playerId = d.playerId || 'unknown';

      // 墙钟估算时钟维护（无真实进度时用）
      if (follow.status === 'playing' && prevStatus !== 'playing') follow.segStart = Date.now();
      else if (follow.status !== 'playing' && prevStatus === 'playing') {
        if (follow.segStart) { follow.base += (Date.now() - follow.segStart) / 1000; follow.segStart = 0; }
      }

      follow.positionMs = d.positionMs || 0;
      follow.durationMs = d.durationMs || 0;
      follow.updatedMs = d.updatedMs || 0;
      follow.rate = d.rate > 0 ? d.rate : 1;
      follow.cover = d.cover || '';
      follow.title = d.title || '';
      follow.artist = d.artist || '';

      // 歌曲切换
      const key = d.hash || ((d.title || '') + '|' + (d.artist || ''));
      const songChanged = key !== follow.key;
      if (songChanged) {
        follow.key = key;
        follow.offset = 0;
        follow.base = 0;
        follow.segStart = (follow.status === 'playing') ? Date.now() : 0;
        follow.prevPos = -1; follow.prevUpdated = 0;
        updateOffsetLabel();
        el.trackName.textContent = d.title + (d.artist ? ' - ' + d.artist : '');
        el.artistName.textContent = d.artist || '';
        el.lrcBadge.textContent = '匹配歌词中…';
        el.lrcBadge.classList.remove('ok');
        resyncTo(0);
        // 歌词由主进程 lyrics-service 广播（onLines），这里不重复取词
      }

      setCover(follow.cover);
      updateStatusBadge();
      updateSyncStatus();
      setNpTitle(follow.title);
      if (el.npArtist) el.npArtist.textContent = follow.artist || '';
      document.body.classList.toggle('np-playing', follow.status === 'playing');

      // 拖动/跳变检测
      if (hasPos() && !songChanged && follow.prevPos >= 0 && follow.updatedMs > 0 && follow.prevUpdated > 0) {
        const expected = follow.prevPos + Math.max(0, follow.updatedMs - follow.prevUpdated) * follow.rate;
        if (Math.abs(follow.positionMs - expected) > 1200) {
          resyncTo(follow.positionMs / 1000 + follow.offset);
        }
      }
      if (hasPos()) { follow.prevPos = follow.positionMs; follow.prevUpdated = follow.updatedMs; }
    } else if (!d.ok) {
      follow.lostCount = (follow.lostCount || 0) + 1;
      if (follow.status === 'playing' && follow.segStart) {
        follow.base += (Date.now() - follow.segStart) / 1000;
        follow.segStart = 0;
      }
      follow.status = 'stopped';
      follow.prevPos = -1; follow.prevUpdated = 0;
      updateStatusBadge();
      document.body.classList.toggle('np-playing', false);
      if (follow.lostCount >= 4 && follow.key !== '__lost__') {
        follow.key = '__lost__';
        el.trackName.textContent = '未检测到播放器 · 请确认播放器正在播放';
        el.artistName.textContent = '';
        setCover('');
      }
    }
  });

  // 主进程广播手动指定（pin）：多窗/网页/OBS 同步
  wallAPI.onManualPin((pin) => {
    manualPin = (pin && pin.text) ? { idx: pin.idx | 0, text: String(pin.text) } : null;
    applyManualPin();
  });

  // 主进程广播歌词行（多端同一份）
  wallAPI.onLines((payload) => {
    if (!payload) return;
    // 自动匹配的词到来时清掉手动原文（复制改由当前行生成）；手动词的广播保留原文
    if (payload.source !== 'manual') lastRawLrc = '';
    const srcLabel =
      payload.source === 'manual' ? '手动歌词' :
      payload.source === 'kugou-hash' ? '酷狗本地(精确)' :
      payload.source === 'kugou-local' ? '酷狗本地' :
      payload.source === 'online' ? '在线' : '歌词';
    applyLines(payload.lines, payload.lines && payload.lines.length ? srcLabel : '未匹配到歌词');
  });

  function setCover(cover) {
    if (!cover) {
      el.cover.classList.add('hidden'); el.cover.removeAttribute('src'); el.cover.dataset.cur = '';
      if (el.bgGlow) { el.bgGlow.style.backgroundImage = ''; el.bgGlow.classList.remove('on'); }
      setNpCover('');
      return;
    }
    let src;
    // 网页端统一走 /api/cover：带封面源作版本参数，否则换歌后 URL 不变、
    // dataset.cur 短路 + 浏览器缓存会让封面与光晕停留在上一首
    if (!isElectron) src = '/api/cover?v=' + encodeURIComponent(String(cover));
    else if (/^https?:/i.test(cover)) src = cover;
    else src = toFileUrl(cover);
    if (el.cover.dataset.cur !== src) {
      el.cover.dataset.cur = src;
      el.cover.src = src;
      // 封面驱动环境光晕（CSS 背景，不读像素，无跨域问题）
      if (el.bgGlow) { el.bgGlow.style.backgroundImage = 'url("' + src + '")'; el.bgGlow.classList.add('on'); }
    }
    el.cover.classList.remove('hidden');
    setNpCover(src);
  }
  // 封面取色：best-effort 提取强调色，跨域污染或失败则保留默认色
  function extractAccent(img) {
    try {
      const s = 40, c = document.createElement('canvas');
      c.width = s; c.height = s;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, s, s);
      const d = ctx.getImageData(0, 0, s, s).data;
      let best = null, bestScore = -1;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a < 200) continue;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const bright = mx / 255;
        if (bright < 0.18 || bright > 0.96) continue;
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        const score = sat * 1.25 + bright * 0.35;
        if (score > bestScore) { bestScore = score; best = [r, g, b]; }
      }
      if (best) {
        const r = best[0], g = best[1], b = best[2];
        document.documentElement.style.setProperty('--accent', 'rgb(' + r + ',' + g + ',' + b + ')');
        const r2 = Math.min(255, Math.round(r * 0.55 + 120));
        const g2 = Math.min(255, Math.round(g * 0.55 + 92));
        const b2 = Math.min(255, Math.round(b * 0.65 + 130));
        document.documentElement.style.setProperty('--accent-2', 'rgb(' + r2 + ',' + g2 + ',' + b2 + ')');
      }
    } catch (e) { /* 画布被跨域污染：保留默认强调色 */ }
  }
  el.cover.addEventListener('load', () => { extractAccent(el.cover); });
  function updateStatusBadge() {
    const map = { playing: '播放中', paused: '已暂停', stopped: '已停止' };
    el.statusBadge.textContent = followMode ? (map[follow.status] || '已停止') : '本地';
    el.statusBadge.classList.toggle('play', follow.status === 'playing');
  }
  function updateSyncStatus() {
    if (!followMode) {
      el.syncStatus.classList.add('hidden');
      el.syncHint.classList.remove('show');
      return;
    }
    el.syncStatus.classList.remove('hidden');
    if (follow.source === 'cdp') {
      el.syncStatus.textContent = '● 精确同步（酷狗直连）';
      el.syncStatus.className = 'badge ok';
      el.syncHint.classList.remove('show');
    } else if (follow.source === 'smtc' && hasPos()) {
      el.syncStatus.textContent = '● 精确同步（' + (follow.playerId || 'SMTC') + '）';
      el.syncStatus.className = 'badge ok';
      el.syncHint.classList.remove('show');
    } else {
      el.syncStatus.textContent = '● 估算同步';
      el.syncStatus.className = 'badge warn';
      el.syncHint.textContent = '当前播放器未上报实时进度，拖动进度条后可能错位。若为酷狗，可用 tools/patch-kugou.js 开启直连获得零漂移。';
      el.syncHint.classList.add('show');
    }
  }

  /* ---------------- 节拍律动（本地模式可选） ---------------- */
  function ensureAudioGraph() {
    if (audioCtx) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      mediaSrc = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      mediaSrc.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch (e) { /* 已连接过则忽略 */ }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  function detectBeat() {
    analyser.getByteFrequencyData(freqData);
    let sum = 0;
    const n = 16;
    for (let i = 0; i < n; i++) sum += freqData[i];
    const energy = sum / n;
    energyHistory.push(energy);
    if (energyHistory.length > 45) energyHistory.shift();
    const avg = energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length;
    const now = performance.now();
    if (energy > avg * 1.35 && energy > 30 && now - lastBeatTime > 220) {
      lastBeatTime = now;
      animator.pulse(Math.min(2, energy / avg));
      if (window.PVEngine && PVEngine.isActive()) PVEngine.pulse(Math.min(1, energy / avg / 2));
    }
  }

  /* ---------------- 卡片波形：多条频谱柱，本地取真实分析器 / 跟随与网页用合成律动 ---------------- */
  const WAVE_BARS = 14;
  const waveCur = new Float32Array(WAVE_BARS);
  const wavePhase = new Float32Array(WAVE_BARS);
  let waveEls = [];
  let waveT = 0, waveLast = 0;
  function initWave() {
    const host = document.getElementById('npWave');
    if (!host) return;
    host.innerHTML = '';
    waveEls = [];
    for (let i = 0; i < WAVE_BARS; i++) {
      const b = document.createElement('i');
      host.appendChild(b);
      waveEls.push(b);
      wavePhase[i] = Math.random() * Math.PI * 2;
      waveCur[i] = 0.12;
    }
  }
  function updateWave(now) {
    if (!waveEls.length) return;
    const dt = Math.min(0.05, (now - waveLast) / 1000 || 0.016);
    waveLast = now; waveT += dt;
    const playing = followMode ? follow.status === 'playing' : (!audio.paused && !!audio.src);
    // 本地播放时按需建分析图（不依赖 ft_beat 开关），拿真实频谱
    if (playing && !followMode && !analyser) { try { ensureAudioGraph(); } catch (e) {} }
    let useSpec = playing && !followMode && !!analyser && !!freqData;
    if (useSpec) { try { analyser.getByteFrequencyData(freqData); } catch (e) { useSpec = false; } }
    for (let i = 0; i < WAVE_BARS; i++) {
      let tgt;
      if (!playing) {
        tgt = 0.10 + 0.05 * Math.sin(waveT * 1.4 + i * 0.7);          // 暂停：低幅呼吸柱
      } else if (useSpec) {
        // 对数分频带：左低右高，取带内均值归一
        const n = freqData.length;
        const f0 = Math.floor(2 + Math.pow(n * 0.72, i / WAVE_BARS));
        const f1 = Math.max(f0 + 1, Math.floor(2 + Math.pow(n * 0.72, (i + 1) / WAVE_BARS)));
        let s = 0; for (let k = f0; k < f1 && k < n; k++) s += freqData[k];
        tgt = 0.12 + Math.min(1, (s / Math.max(1, f1 - f0)) / 190) * 0.95;
      } else {
        // 合成律动：多层正弦 + 逐柱相位，近似频谱起伏
        const g = 0.55 + 0.45 * Math.sin(waveT * 2.1 + i * 0.35);
        const v = Math.abs(Math.sin(waveT * (1.6 + (i % 5) * 0.55) + wavePhase[i]));
        tgt = 0.14 + 0.86 * v * g;
      }
      waveCur[i] += (tgt - waveCur[i]) * (playing ? 0.35 : 0.12);
      const hs = Math.round(Math.min(1, Math.max(0.06, waveCur[i])) * 100) + '%';
      if (waveEls[i].style.height !== hs) waveEls[i].style.height = hs;
    }
  }
  initWave();

  /* ---------------- 全屏 & 空闲隐藏 ---------------- */
  function toggleFullscreen() { wallAPI.toggleFullscreen(); }

  let idleTimer = null;
  function resetIdle() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!audio.paused || (followMode && follow.status === 'playing')) return;
      document.body.classList.add('idle');
    }, 3000);
  }
  ['mousemove', 'mousedown', 'keydown', 'touchstart'].forEach((evt) =>
    window.addEventListener(evt, resetIdle)
  );
  resetIdle();

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'F11' || e.key === 'f') { e.preventDefault(); toggleFullscreen(); }
    else if (e.key === 'Escape') {
      if (isElectron) closePanel();   // 退出控制台→大预览
    }
  });

  /* ---------------- 面板 & 设置 ---------------- */
  el.btnPlay.onclick = togglePlay;
  el.btnFullscreen.onclick = toggleFullscreen;
  el.btnOpenAudio.onclick = openAudio;
  el.btnOpenLrc.onclick = openLrcFile;
  el.btnSearch.onclick = doSearch;
  el.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  el.btnApplyPaste.onclick = async () => {
    const text = el.pasteArea.value.trim();
    if (!text) { flashBtn(el.btnApplyPaste, '请先粘贴歌词', 1500); return; }
    const r = await applyManualLyric(text);
    if (!r.ok) { flashBtn(el.btnApplyPaste, r.error, 2200); return; }
    lastRawLrc = el.pasteArea.value;
    switchLyricsTab('preview');
  };
  el.btnPreview.onclick = () => animator.spawn('动态歌词墙 ✦ 预览效果', 4);
  el.btnOpenWeb.onclick = () => wallAPI.openInBrowser();
  el.btnRefreshLyrics.onclick = () => {
    if (isElectron && window.electronAPI.refreshLyrics) {
      window.electronAPI.refreshLyrics();
      el.lrcBadge.textContent = '匹配歌词中…';
      el.lrcBadge.classList.remove('ok');
    }
  };

  // 复制歌词：优先最近一次原文（搜索/粘贴/本地文件），否则由当前行生成标准 LRC
  function fmtLrcStamp(t) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    const cs = Math.round((t - Math.floor(t)) * 100);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
  }
  function buildLrcText() {
    if (lastRawLrc && lastRawLrc.trim()) return lastRawLrc;
    return lines.map((ln) => '[' + fmtLrcStamp(ln.time) + ']' + ln.text).join('\n');
  }
  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      ta.remove(); return ok;
    } catch (e) { return false; }
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }
  function flashBtn(btn, msg, ms) {
    if (!btn) return;
    const old = btn.dataset.oldText || btn.textContent;
    if (!btn.dataset.oldText) btn.dataset.oldText = old;
    btn.textContent = msg;
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => { btn.textContent = btn.dataset.oldText; btn.classList.remove('ok-flash'); }, ms || 1500);
  }
  if (el.btnCopyLrc) el.btnCopyLrc.onclick = async () => {
    const text = buildLrcText();
    if (!text.trim()) { flashBtn(el.btnCopyLrc, '暂无歌词', 1300); return; }
    const ok = await copyText(text);
    el.btnCopyLrc.classList.toggle('ok-flash', ok);
    flashBtn(el.btnCopyLrc, ok ? '已复制 ' + lines.length + ' 行' : '复制失败', 1500);
  };
  if (el.btnAutoLrc) el.btnAutoLrc.onclick = () => {
    if (!(isElectron && followMode && window.electronAPI.refreshLyrics)) { flashBtn(el.btnAutoLrc, '仅跟随播放时可用', 1500); return; }
    window.electronAPI.refreshLyrics();
    el.lrcBadge.textContent = '匹配歌词中…';
    el.lrcBadge.classList.remove('ok');
    flashBtn(el.btnAutoLrc, '正在恢复自动匹配…', 1500);
  };

  /* 侧导航 + 面板切换：点击导航 → 打开面板并切小窗预览；再点同项 → 关闭面板回大预览 */
  let curPanel = null;
  function showPanel(name) {
    if (!name || name === curPanel) { closePanel(); return; }
    curPanel = name;
    el.panelArea.classList.remove('hidden');
    document.body.classList.remove('prev-large');
    document.body.classList.add('prev-mini');
    document.querySelectorAll('#sideNav .sn-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.nav === name));
    document.querySelectorAll('.panel-page').forEach(p =>
      p.classList.toggle('active', p.dataset.page === name));
    restoreMiniPos();
    if (viewMode === 'card' || viewMode === 'pv') highlightCenter(centerCur, true);
  }
  function closePanel() {
    curPanel = null;
    el.panelArea.classList.add('hidden');
    document.body.classList.remove('prev-mini');
    document.body.classList.add('prev-large');
    document.querySelectorAll('#sideNav .sn-btn').forEach(b => b.classList.remove('active'));
    clearInlineMiniPos();   // 大预览铺满，清掉小窗拖拽留下的内联定位
  }
  document.querySelectorAll('#sideNav .sn-btn[data-nav]').forEach(b => {
    b.onclick = () => showPanel(b.dataset.nav);
  });
  if (el.btnPrevMode) {
    el.btnPrevMode.onclick = () => {
      if (curPanel) { closePanel(); return; }
      document.body.classList.toggle('prev-mini');
      document.body.classList.toggle('prev-large');
      if (document.body.classList.contains('prev-mini')) restoreMiniPos();
      else clearInlineMiniPos();
    };
  }

  /* 小窗预览拖拽：纯页面内坐标改 previewPane 定位（不涉及窗口移动/DPI）；位置记忆 + 双击复位 */
  const MINI_POS_KEY = 'lw_mini_pos_v1';
  function placeMini(x, y, save) {
    const pane = el.previewPane, bar = document.getElementById('miniDragBar');
    if (!pane) return;
    const area = document.getElementById('workArea').getBoundingClientRect();
    const w = pane.offsetWidth, h = pane.offsetHeight;
    x = Math.min(Math.max(0, x), Math.max(0, area.width - w));
    y = Math.min(Math.max(0, y), Math.max(0, area.height - h));
    pane.style.left = x + 'px'; pane.style.top = y + 'px';
    pane.style.right = 'auto'; pane.style.bottom = 'auto';
    if (bar) { bar.style.left = x + 'px'; bar.style.top = (y + 6) + 'px'; bar.style.right = 'auto'; }
    if (save) { try { localStorage.setItem(MINI_POS_KEY, JSON.stringify({ x, y })); } catch (e) {} }
  }
  function clearInlineMiniPos() {
    const pane = el.previewPane, bar = document.getElementById('miniDragBar');
    if (!pane) return;
    pane.style.left = ''; pane.style.top = ''; pane.style.right = ''; pane.style.bottom = '';
    if (bar) { bar.style.left = ''; bar.style.top = ''; bar.style.right = ''; }
  }
  function restoreMiniPos() {
    if (!document.body.classList.contains('prev-mini')) return;
    try {
      const p = JSON.parse(localStorage.getItem(MINI_POS_KEY) || 'null');
      if (p && typeof p.x === 'number' && typeof p.y === 'number') placeMini(p.x, p.y, false);
    } catch (e) {}
  }
  (function setupMiniDrag() {
    const bar = document.getElementById('miniDragBar');
    if (!bar || !el.previewPane) return;
    let drag = null;
    const workArea = () => document.getElementById('workArea').getBoundingClientRect();
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const r = el.previewPane.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.classList.add('dragging');
    });
    // move/up 挂 window：不依赖 pointer capture，合成事件与触屏都能稳定冒泡
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const a = workArea();
      placeMini(e.clientX - a.left - drag.dx, e.clientY - a.top - drag.dy, false);
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      bar.classList.remove('dragging');
      const r = el.previewPane.getBoundingClientRect(), a = workArea();
      placeMini(r.left - a.left, r.top - a.top, true);
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    bar.addEventListener('dblclick', () => {
      try { localStorage.removeItem(MINI_POS_KEY); } catch (e) {}
      clearInlineMiniPos();
    });
    window.addEventListener('resize', () => {
      if (!drag && document.body.classList.contains('prev-mini') && el.previewPane.style.left) {
        const r = el.previewPane.getBoundingClientRect(), a = workArea();
        placeMini(r.left - a.left, r.top - a.top, true);
      }
    });
  })();

  /* 歌词面板标签切换（仅作用于歌词面板内），代码内选择版本/粘贴应用后也可调它跳到预览 */
  function switchLyricsTab(name) {
    const page = document.querySelector('#panelArea [data-page="lyrics"]');
    if (!page) return;
    page.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    page.querySelectorAll('.tab-body').forEach(b => {
      const on = b.dataset.body === name;
      b.classList.toggle('hidden', !on);
      b.classList.toggle('active', on);
    });
  }
  document.querySelectorAll('#panelArea [data-page="lyrics"] .tab').forEach(tab => {
    tab.onclick = () => switchLyricsTab(tab.dataset.tab);
  });

  /* ---------------- 跟随 & 偏移 ---------------- */
  function setFollowLabel(t) { const l = el.btnFollow.querySelector('.lbl'); if (l) l.textContent = t; }
  function updateOffsetLabel() { el.offsetVal.textContent = follow.offset.toFixed(1) + 's'; }
  function setFollow(on) {
    on = !!on;
    el.btnFollow.classList.toggle('active', on);
    if (followMode === on) return;
    followMode = on;
    if (on) {
      audio.pause();
      follow.key = ''; follow.base = 0; follow.segStart = 0;
      follow.offset = 0; follow.status = 'stopped';
      follow.positionMs = 0; follow.durationMs = 0; follow.updatedMs = 0;
      follow.prevPos = -1; follow.prevUpdated = 0;
      updateOffsetLabel();
      setFollowLabel('跟随中');
      el.trackName.textContent = '等待检测播放器…';
      el.artistName.textContent = '';
      el.lrcBadge.textContent = '跟随模式';
      el.lrcBadge.classList.remove('ok');
      setCover('');
      updateStatusBadge();
      updateSyncStatus();
      wallAPI.startFollow();
    } else {
      wallAPI.stopFollow();
      setFollowLabel('跟随播放器');
      animator.clear(); pointer = 0;
      el.trackName.textContent = '未加载音乐';
      el.artistName.textContent = '';
      el.lrcBadge.textContent = '无歌词';
      setCover('');
      updateStatusBadge();
      updateSyncStatus();
    }
  }
  el.btnFollow.onclick = () => {
    if (!isElectron) return;                 // 网页端恒为跟随展示
    patchConfig('ft_follow', !followMode);   // 走配置：同步到网页 + 持久化
  };
  el.btnOffsetUp.onclick = () => { follow.offset += 1; updateOffsetLabel(); };
  el.btnOffsetDown.onclick = () => { follow.offset -= 1; updateOffsetLabel(); };
  el.btnRealign.onclick = () => {
    follow.base = 0;
    follow.segStart = (follow.status === 'playing') ? Date.now() : 0;
    follow.offset = 0;
    follow.prevPos = -1; follow.prevUpdated = 0;
    resyncTo(0);
    updateOffsetLabel();
  };

  document.querySelectorAll('.close').forEach((b) => {
    if (b.id === 'tbClose') return;                 // 标题栏关闭钮 = 关窗口（winClose），绝不能被这里覆盖
    b.onclick = () => { if (b.dataset.close) document.getElementById(b.dataset.close).classList.add('hidden'); };
  });
  // 歌词面板外的 tab 绑定已移除，由面板路由统一控制

  /* ---------------- 配置应用：样式 → 动画器 / 律动 ---------------- */
  function applyStyle(cfg) {
    animator.setOptions({
      minFont: cfg.st_font * 0.5, maxFont: cfg.st_font,
      minRotate: cfg.st_rotate * 0.3, maxRotate: cfg.st_rotate,
      maxConcurrent: cfg.st_concurrent,
      fadeIn: cfg.st_fadeIn,
      maxHold: cfg.st_hold, minHold: Math.min(2.2, cfg.st_hold),
      colors: cfg.st_rainbow ? RAINBOW : [cfg.st_color],
      glow: cfg.st_glow,
    });
    beatEnabled = !!cfg.ft_beat;
    if (beatEnabled && !followMode) ensureAudioGraph();
  }

  /* ---------------- 字体与样式：写入 CSS 变量（作用于卡片 + 居中大歌词 + 漂浮碎片） ---------------- */
  // 网页/局域网端：本机未装该字体，注入 @font-face 从 /api/font 远程加载字体文件
  let wallFontUrl = '';
  function ensureWallFont(ver) {
    const url = '/api/font?v=' + (ver || 0);
    if (wallFontUrl === url) return;
    wallFontUrl = url;
    let st = document.getElementById('wallFontFace');
    if (!st) { st = document.createElement('style'); st.id = 'wallFontFace'; document.head.appendChild(st); }
    st.textContent = "@font-face{font-family:'__wallfont';src:url('" + url + "');font-display:swap;}";
  }
  function fontFamily() {
    const f = config.ty_family;
    if (f === 'custom') return (config.ty_custom || '').trim() || FONT_PRESETS.system;
    // 预设键（system/yahei/...）→ 映射到字体栈；否则视为本机已安装字体名（控制台读取系统字体库）
    if (f && Object.prototype.hasOwnProperty.call(FONT_PRESETS, f)) return FONT_PRESETS[f] || FONT_PRESETS.system;
    if (f) {
      const name = String(f).replace(/["']/g, '');
      // 网页端（含局域网手机/其他电脑/OBS）本机没有该字体，走 @font-face 远程加载
      if (!isElectron) { ensureWallFont(config.ty_font_v); return "'__wallfont','" + name + "'," + FONT_PRESETS.system; }
      return '"' + name + '",' + FONT_PRESETS.system;
    }
    return FONT_PRESETS.system;
  }
  /* 旧版配置迁移：全局 ty_* 样式键拆分为各模式独立键（一次性，用 _mig_lc 标记） */
  function migrateLegacyTy(cfg) {
    if (!cfg || typeof cfg !== 'object' || cfg._mig_lc || cfg.lc_size !== undefined) return cfg;
    const MAP = { ty_size: 'lc_size', ty_color: 'lc_color', ty_weight: 'lc_weight', ty_spacing: 'lc_spacing', ty_shadow: 'lc_shadow', ty_italic: 'lc_italic' };
    const patch = { _mig_lc: true };
    Object.keys(MAP).forEach((old) => { if (cfg[old] !== undefined) patch[MAP[old]] = cfg[old]; });
    if (isElectron) { try { wallAPI.setConfig(patch); } catch (e) {} }
    return Object.assign(cfg, patch);
  }

  function applyTypography() {
    const rs = document.documentElement.style;
    rs.setProperty('--np-font', fontFamily());
    // 居中歌词（卡片视图）专属样式
    rs.setProperty('--lc-size', String((config.lc_size || 100) / 100));
    rs.setProperty('--lc-color', config.lc_color || '#ffffff');
    rs.setProperty('--lc-weight', String(config.lc_weight || 800));
    rs.setProperty('--lc-spacing', (config.lc_spacing || 0) + 'px');
    document.body.classList.toggle('lc-italic', !!config.lc_italic);
    document.body.classList.toggle('lc-shadow', config.lc_shadow !== false);
    // PV 字效：CSS 兜底变量（WebGL 不可用时 classic 用）+ 引擎参数下发
    rs.setProperty('--pv-size', String((config.pv_size || 100) / 100));
    rs.setProperty('--pv-speed', String((config.pv_speed || 100) / 100));
    rs.setProperty('--pv-color', config.lc_color || '#ffffff');
    applyPVParams();
    // 歌综字幕专属样式
    document.body.classList.toggle('sh-rotate', (config.sh_anim || 'rotate') === 'rotate');
    document.body.classList.toggle('sh-no-outline', config.sh_outline === false);
    rs.setProperty('--sh-speed', String((config.sh_speed || 100) / 100));
    rs.setProperty('--sh-size', String((config.sh_size || 100) / 100));
    rs.setProperty('--sh-color', config.sh_color || '#ffffff');
    rs.setProperty('--sh-outline', config.sh_outline_color || '#000000');
    rs.setProperty('--sh-outline-w', (config.sh_outline_w == null ? 4 : config.sh_outline_w) + 'px');
  }

  /* ---------------- PV 字效：PixiJS 引擎优先，WebGL 不可用时回退 CSS 逐字撒开 ---------------- */
  let pvCurText = null;
  let lastPVText = '';
  let pvEngineFailed = false;
  let lastPVFontKey = null;

  // 引擎参数下发（speed/motion/bgAlpha/bpm/beat/size/fx），仅在引擎就绪时生效
  function applyPVParams() {
    if (!window.PVEngine || !PVEngine.isActive()) return;
    PVEngine.setParams({
      speed: (config.pv_speed || 100) / 100,
      motion: (config.pv_motion == null ? 100 : config.pv_motion) / 100,
      bgAlpha: (config.pv_bgalpha == null ? 100 : config.pv_bgalpha) / 100,
      bpm: config.pv_bpm || 120,
      beat: (config.pv_beat == null ? 50 : config.pv_beat) / 100,
      size: (config.pv_size || 100) / 100,
      fx: { grain: !!config.pv_fx_grain, scan: !!config.pv_fx_scan, glitch: !!config.pv_fx_glitch }
    });
    PVEngine.setTemplate(config.pv_template || 'cyberRuins');
    // 字体变化 → 通知引擎重排
    const fk = fontFamily();
    if (fk !== lastPVFontKey) { lastPVFontKey = fk; PVEngine.setFont(fontFamily); }
  }

  function ensurePVEngine() {
    if (!window.PVEngine || pvEngineFailed) return;
    if (PVEngine.isActive()) {
      // 引擎已在（之前被暂停）：恢复并刷新状态，不重建，避免同 canvas 重复 init 失败
      PVEngine.setPaused(false);
      applyPVParams();
      clearPVLine();
      pvCurText = null;
      if (lastPVText) PVEngine.setText(lastPVText);
      return;
    }
    const canvas = document.getElementById('pvCanvas');
    if (!canvas) return;
    PVEngine.create({
      canvas,
      getFont: fontFamily,
      onFallback: () => { pvEngineFailed = true; pvCurText = null; renderPV(lastPVText); }
    }).then((ok) => {
      if (!ok || !PVEngine.isActive()) return;
      lastPVFontKey = fontFamily();
      PVEngine.setTransparent(!!config.ft_transparent);
      applyPVParams();
      clearPVLine();   // 引擎就绪后清掉初始化期间遗留的 CSS 兜底行，避免与 WebGL 画面重叠
      pvCurText = null;
      if (lastPVText) PVEngine.setText(lastPVText);
    }).catch(() => { pvEngineFailed = true; pvCurText = null; renderPV(lastPVText); });
  }

  function destroyPVEngine() {
    if (window.PVEngine && PVEngine.isActive()) { try { PVEngine.destroy(); } catch (e) {} }
  }

  // 离开 PV 视图只暂停（停 ticker）保留 WebGL 上下文；切回时复用，
  // 若销毁重建会因同 canvas 上下文失效而失败、永久回退老版 CSS 字
  function pausePVEngine() {
    if (window.PVEngine && PVEngine.isActive()) { try { PVEngine.setPaused(true); } catch (e) {} }
  }

  /* ---------------- 3D 长方体歌词块：Three.js + GSAP 引擎，生命周期同 PV（暂停不销毁） ---------------- */
  let boxEngineFailed = false;

  function applyBoxParams() {
    if (!window.BoxEngine || !BoxEngine.isActive()) return;
    BoxEngine.setParams({
      size: (config.box_size || 100) / 100,
      spacing: config.box_spacing || 0,
      color: config.box_color || '#ffffff',
      glowColor: config.box_glow_color || '#78b4ff',
      glow: (config.box_glow || 90) / 100,
      alpha: (config.box_alpha || 85) / 100,
      max: config.box_max || 5,
      stay: config.box_stay || 4,
      in: config.box_in || 1,
      out: config.box_out || 1.2,
      rot: config.box_rot != null ? config.box_rot : 45,
      spin: config.box_spin != null ? config.box_spin : 15,
      echo: config.box_echo != null ? config.box_echo : 3,
    });
  }

  function ensureBoxEngine() {
    if (!window.BoxEngine || boxEngineFailed) return;
    if (BoxEngine.isActive()) {
      // 引擎已在（之前被暂停）：恢复并刷新状态，不重建，避免同 canvas 重复创建失败
      BoxEngine.setPaused(false);
      applyBoxParams();
      feedBoxLyrics(true);
      return;
    }
    const canvas = document.getElementById('boxCanvas');
    if (!canvas) return;
    BoxEngine.create({
      canvas,
      getFont: fontFamily,
      onFallback: () => { boxEngineFailed = true; }
    }).then((ok) => {
      if (!ok || !BoxEngine.isActive()) return;
      BoxEngine.setTransparent(!!config.ft_transparent);
      applyBoxParams();
      feedBoxLyrics(true);
    }).catch(() => { boxEngineFailed = true; });
  }

  function pauseBoxEngine() {
    if (window.BoxEngine && BoxEngine.isActive()) { try { BoxEngine.setPaused(true); } catch (e) {} }
  }

  // 把当前歌词行喂给引擎；force=重新下发（切歌/引擎刚就绪）
  function feedBoxLyrics(force) {
    if (!window.BoxEngine || !BoxEngine.isActive()) return;
    BoxEngine.setLyrics(lines.map((l) => ({ time: l.time, text: l.text })));
    if (force) BoxEngine.setTime(currentTime());
  }

  function clearPVLine() {
    if (!el.pvStage) return;
    const l = el.pvStage.querySelector('.pv-line'); if (l) l.remove();
  }

  function renderPV(text) {
    if (!el.pvStage) return;
    const t = text || '';
    lastPVText = t;
    // WebGL 引擎优先
    if (window.PVEngine && PVEngine.isActive() && !pvEngineFailed) {
      clearPVLine();
      PVEngine.setText(t);
      pvCurText = t;
      return;
    }
    // CSS classic 兜底（保留 #pvCanvas 节点，只增删 .pv-line）
    if (t === pvCurText) return;
    pvCurText = t;
    clearPVLine();
    if (!t) return;
    const line = document.createElement('div');
    line.className = 'pv-line';
    Array.from(t).forEach((ch, i) => {
      if (ch === ' ') { const sp = document.createElement('span'); sp.className = 'pv-space'; line.appendChild(sp); return; }
      const s = document.createElement('span');
      s.className = 'pv-char';
      s.textContent = ch;
      s.style.setProperty('--rot', (Math.random() * 56 - 28).toFixed(1) + 'deg');
      s.style.setProperty('--tx', (Math.random() * 0.5 - 0.25).toFixed(2) + 'em');
      s.style.setProperty('--ty', (Math.random() * 0.9 - 0.45).toFixed(2) + 'em');
      s.style.setProperty('--sc', (0.85 + Math.random() * 0.4).toFixed(2));
      s.style.setProperty('--d', (i * 0.07).toFixed(2) + 's');
      line.appendChild(s);
    });
    el.pvStage.appendChild(line);
  }

  /* ---------------- 桌面控制台：数据驱动构建所有开关 ---------------- */
  // 读取本机字体库填充"字体"下拉（桌面：主进程枚举；网页：Local Font Access API）
  let sysFontsPromise = null;
  function loadSystemFonts(group, sel, key) {
    if (!wallAPI || !wallAPI.listFonts) { group.label = '本机字体库（不可用）'; return; }
    if (!sysFontsPromise) sysFontsPromise = Promise.resolve(wallAPI.listFonts()).catch(() => []);
    sysFontsPromise.then((families) => {
      const list = Array.isArray(families) ? families.filter(Boolean) : [];
      if (!list.length) { group.label = '本机字体库（不可用）'; return; }
      group.innerHTML = '';
      group.label = '本机字体库（' + list.length + '）';
      const frag = document.createDocumentFragment();
      list.forEach((name) => {
        const o = document.createElement('option');
        o.value = name; o.textContent = name;
        o.style.fontFamily = '"' + String(name).replace(/"/g, '') + '"';  // 选项以该字体预览
        frag.appendChild(o);
      });
      group.appendChild(frag);
      if (config[key]) { try { sel.value = config[key]; } catch (e) {} }  // 恢复当前选中
    });
  }
  function txtBlock(it) {
    const t = document.createElement('div'); t.className = 'cs-card-txt';
    const ti = document.createElement('div'); ti.className = 'cs-card-title'; ti.textContent = it.label;
    t.appendChild(ti);
    if (it.desc) { const d = document.createElement('div'); d.className = 'cs-card-desc'; d.textContent = it.desc; t.appendChild(d); }
    return t;
  }
  function refreshActivePlayers() {
    if (!playerChipMap || !isElectron) return;
    wallAPI.getActivePlayers().then((ids) => {
      const set = {}; (ids || []).forEach((id) => { set[id] = true; });
      Object.keys(playerChipMap).forEach((pid) => {
        if (pid === 'auto') return;
        playerChipMap[pid].classList.toggle('detected', !!set[pid]);
      });
    }).catch(() => {});
  }
  function buildControl(it) {
    const card = document.createElement('div');
    if (it.type === 'toggle') {
      card.className = 'cs-card';
      card.appendChild(txtBlock(it));
      const sw = document.createElement('label'); sw.className = 'switch';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!config[it.key];
      const sl = document.createElement('span'); sl.className = 'slider';
      sw.appendChild(cb); sw.appendChild(sl);
      cb.addEventListener('change', () => patchConfig(it.key, cb.checked));
      card.appendChild(sw);
      consoleControls[it.key] = (v) => { cb.checked = !!v; };
    } else if (it.type === 'range') {
      card.className = 'cs-card';
      card.appendChild(txtBlock(it));
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = it.min; inp.max = it.max; inp.step = it.step; inp.value = config[it.key];
      const val = document.createElement('span'); val.className = 'cs-val'; val.textContent = config[it.key];
      inp.addEventListener('input', () => { val.textContent = inp.value; patchConfig(it.key, parseFloat(inp.value)); });
      card.appendChild(inp); card.appendChild(val);
      consoleControls[it.key] = (v) => { inp.value = v; val.textContent = v; };
    } else if (it.type === 'color') {
      card.className = 'cs-card';
      card.appendChild(txtBlock(it));
      const inp = document.createElement('input'); inp.type = 'color'; inp.value = config[it.key];
      inp.addEventListener('input', () => patchConfig(it.key, inp.value));
      card.appendChild(inp);
      consoleControls[it.key] = (v) => { try { inp.value = v; } catch (e) {} };
    } else if (it.type === 'select') {
      card.className = 'cs-card';
      card.appendChild(txtBlock(it));
      const sel = document.createElement('select'); sel.className = 'cs-select';
      const mkOpt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; };
      if (it.fontList) {
        const g1 = document.createElement('optgroup'); g1.label = '预设';
        it.options.forEach((opt) => g1.appendChild(mkOpt(opt[0], opt[1])));
        sel.appendChild(g1);
        const g2 = document.createElement('optgroup'); g2.label = '本机字体库…';
        sel.appendChild(g2);
        loadSystemFonts(g2, sel, it.key);
      } else {
        it.options.forEach((opt) => sel.appendChild(mkOpt(opt[0], opt[1])));
      }
      sel.value = config[it.key];
      sel.addEventListener('change', () => patchConfig(it.key, sel.value));
      card.appendChild(sel);
      consoleControls[it.key] = (v) => { sel.value = v; };
    } else if (it.type === 'text') {
      card.className = 'cs-card cs-card-col';
      const ti = document.createElement('div'); ti.className = 'cs-card-title'; ti.textContent = it.label;
      card.appendChild(ti);
      const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'cs-text';
      inp.placeholder = it.placeholder || ''; inp.value = config[it.key] || '';
      inp.addEventListener('change', () => patchConfig(it.key, inp.value.trim()));
      card.appendChild(inp);
      consoleControls[it.key] = (v) => { inp.value = v || ''; };
    } else if (it.type === 'seg') {
      card.className = 'cs-card cs-card-col';
      card.appendChild(txtBlock(it));
      const chips = document.createElement('div'); chips.className = 'cs-chips';
      it.options.forEach((opt) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'cs-chip' + (config[it.key] === opt[0] ? ' active' : '');
        b.textContent = opt[1];
        b.onclick = () => patchConfig(it.key, opt[0]);
        chips.appendChild(b);
      });
      card.appendChild(chips);
      consoleControls[it.key] = (v) => {
        const btns = chips.querySelectorAll('.cs-chip');
        it.options.forEach((opt, i) => { if (btns[i]) btns[i].classList.toggle('active', opt[0] === v); });
      };
    } else if (it.type === 'player') {
      // 播放器选择不进 schema 常规渲染流，挂载到「跟随」面板的 #followPlayerSlot
      const slot = document.getElementById('followPlayerSlot');
      if (!slot) return null;
      slot.innerHTML = '';
      card.className = 'cs-card cs-card-col';
      card.appendChild(txtBlock(it));
      const chips = document.createElement('div'); chips.className = 'cs-chips cs-player-chips';
      const chipMap = {};
      it.options.forEach((opt) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'cs-chip' + (config[it.key] === opt[0] ? ' active' : '');
        b.textContent = opt[1];
        b.onclick = () => patchConfig(it.key, opt[0]);
        chips.appendChild(b);
        chipMap[opt[0]] = b;
      });
      card.appendChild(chips);
      consoleControls[it.key] = (v) => {
        it.options.forEach((opt) => { if (chipMap[opt[0]]) chipMap[opt[0]].classList.toggle('active', opt[0] === v); });
      };
      playerChipMap = chipMap;   // 供活跃绿点刷新使用
      slot.appendChild(card);
      if (isElectron && !playerPollStarted) { playerPollStarted = true; setInterval(refreshActivePlayers, 3000); }
      refreshActivePlayers();
      return null;
    } else if (it.type === 'action') {
      card.className = 'cs-card';
      card.appendChild(txtBlock(it));
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cs-headbtn'; b.style.marginLeft = 'auto';
      b.textContent = it.btn || '选择';
      b.onclick = () => pickBackgroundImage();
      card.appendChild(b);
    }
    return card;
  }
  let csSections = [];
  function showSection(i) {
    csSections.forEach((s, k) => s.classList.toggle('hidden', k !== i));
    document.querySelectorAll('#csNav .cs-nav-btn').forEach((b, k) => b.classList.toggle('active', k === i));
    const t = document.getElementById('csTitle');
    if (t) t.textContent = CONFIG_SCHEMA[i] ? CONFIG_SCHEMA[i].group : '';
  }
  function buildConsole() {
    const nav = document.getElementById('csNav');
    const body = document.getElementById('consoleBody');
    if (!nav || !body) return;
    nav.innerHTML = ''; body.innerHTML = ''; csSections = [];
    CONFIG_SCHEMA.forEach((group, gi) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cs-nav-btn' + (gi === 0 ? ' active' : '');
      b.innerHTML = '<svg class="ico"><use href="#' + (group.icon || 'i-settings') + '"/></svg><span></span>';
      b.querySelector('span').textContent = group.group;
      b.onclick = () => showSection(gi);
      nav.appendChild(b);
      const sec = document.createElement('section');
      sec.className = 'cs-section' + (gi === 0 ? '' : ' hidden');
      const h = document.createElement('div'); h.className = 'cs-sec-title'; h.textContent = group.group;
      sec.appendChild(h);
      group.items.forEach((it) => { const c = buildControl(it); if (c) sec.appendChild(c); });
      body.appendChild(sec);
      csSections.push(sec);
    });
  }
  function syncConsole() {
    Object.keys(consoleControls).forEach((k) => {
      if (config[k] !== undefined) { try { consoleControls[k](config[k]); } catch (e) {} }
    });
  }
  function patchConfig(key, value) {
    config[key] = value;
    applyConfig(config);
    if (isElectron) { try { wallAPI.setConfig({ [key]: value }); } catch (e) {} }
  }

  /* ---------------- 背景模式：封面光晕 / 纯黑 / 预设渐变 / 自定义图（Alpha 开启时强制全透） ---------------- */
  const BG_MODES = ['cover', 'black', 'g1', 'g2', 'g3', 'g4', 'custom'];
  let serverOrigin = '';
  function applyBackground() {
    const trans = !!config.ft_transparent;
    const mode = BG_MODES.indexOf(config.bg_mode) >= 0 ? config.bg_mode : 'cover';
    BG_MODES.forEach((m) => document.body.classList.toggle('bg-' + m, !trans && m === mode));
    if (el.bgCustom) {
      if (!trans && mode === 'custom') {
        const base = isElectron ? (serverOrigin || 'http://127.0.0.1:8787') : '';
        el.bgCustom.style.backgroundImage = 'url("' + base + '/api/bg-custom?v=' + (config.bg_custom_v || 0) + '")';
      } else {
        el.bgCustom.style.backgroundImage = '';
      }
    }
  }
  async function pickBackgroundImage() {
    try {
      const r = await wallAPI.bgPick();
      if (r && r.ok) {
        config.bg_mode = 'custom';
        config.bg_custom_v = r.v || Date.now();
        applyConfig(config);   // 本地立即生效；主进程已持久化+广播到全端
      }
    } catch (e) {}
  }
  // 应用配置：元素显隐（body 类）+ 视图 + 样式 + 跟随；桌面预览与网页输出共用
  function applyConfig(cfg) {
    if (cfg && typeof cfg === 'object') Object.assign(config, cfg);
    EL_KEYS.forEach((k) => document.body.classList.toggle('hide-' + k.slice(3), !config[k]));
    // 透明背景输出＝阿尔法通道：只剩字幕，底色/光晕/遮罩/卡片全透明
    const trans = !!config.ft_transparent;
    document.body.classList.toggle('bg-transparent', trans);
    document.documentElement.classList.toggle('bg-transparent', trans);
    applyBackground();
    setViewMode(config.view);
    applyStyle(config);
    applyTypography();
    pvMode = config.view === 'pv';
    showMode = config.view === 'show';
    boxMode = config.view === 'box';
    pvCurText = null;
    showCurIdx = -2;
    if (window.PVEngine && PVEngine.isActive()) PVEngine.setTransparent(trans);
    if (window.BoxEngine && BoxEngine.isActive()) { BoxEngine.setTransparent(trans); applyBoxParams(); }
    if (pvMode) renderPV(centerCur >= 0 && lines[centerCur] ? lines[centerCur].text : '');
    else clearPVLine();
    if (showMode) renderShow(centerCur);
    else if (el.showStage) el.showStage.innerHTML = '';
    if (isElectron) setFollow(!!config.ft_follow);
    syncConsole();
  }

  /* ---------------- 预览角标快捷切换视图（与控制台 seg 同步走配置广播） ---------------- */
  document.querySelectorAll('#viewToggle .vt-btn').forEach((b) => {
    b.onclick = () => patchConfig('view', b.dataset.view);
  });

  /* ---------------- 拖拽文件支持 ---------------- */
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (/\.(mp3|flac|wav|m4a|ogg|aac)$/i.test(file.name)) {
      audio.src = URL.createObjectURL(file);
      el.trackName.textContent = file.name;
      autoMatchLyrics(file.name.replace(/\.[^.]+$/, ''));
      audio.play().catch(() => {});
    } else if (/\.(lrc|txt)$/i.test(file.name)) {
      const r = new FileReader();
      r.onload = () => applyLrc(r.result, file.name);
      r.readAsText(file);
    }
  });

  /* ---------------- 网页正式显示：卡片 + AMLL 居中大歌词 ---------------- */
  let viewMode = 'wall';
  let centerRows = [];
  let centerCur = -2;

  function setViewMode(m) {
    viewMode = (m === 'card') ? 'card' : (m === 'pv') ? 'pv' : (m === 'show') ? 'show' : (m === 'box') ? 'box' : 'wall';
    document.body.classList.toggle('view-card', viewMode === 'card');
    document.body.classList.toggle('view-wall', viewMode === 'wall');
    document.body.classList.toggle('view-pv', viewMode === 'pv');
    document.body.classList.toggle('view-show', viewMode === 'show');
    document.body.classList.toggle('view-box', viewMode === 'box');
    document.querySelectorAll('#viewToggle .vt-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.view === viewMode));
    // PV/3D方块视图：创建/恢复 WebGL 引擎；离开只暂停不销毁
    if (viewMode === 'pv') ensurePVEngine(); else pausePVEngine();
    if (viewMode === 'box') ensureBoxEngine(); else pauseBoxEngine();
    if (viewMode !== 'wall' && viewMode !== 'box') highlightCenter(currentLineIndex(currentTime()), true);
  }

  function renderCenterList() {
    if (!el.lyricScroll) return;
    el.lyricScroll.innerHTML = '';
    centerRows = [];
    centerCur = -2;
    const frag = document.createDocumentFragment();
    lines.forEach((ln) => {
      const div = document.createElement('div');
      div.className = 'lc-row';
      div.textContent = ln.text;
      frag.appendChild(div);
      centerRows.push(div);
    });
    el.lyricScroll.appendChild(frag);
    if (el.lyricCenter) el.lyricCenter.classList.toggle('empty', lines.length === 0);
  }

  function highlightCenter(idx, force) {
    if (!centerRows.length || !el.lyricScroll) return;
    if (idx === centerCur && !force) return;
    centerCur = idx;
    for (let i = 0; i < centerRows.length; i++) {
      const d = Math.abs(i - idx);
      centerRows[i].classList.toggle('cur', i === idx);
      centerRows[i].classList.toggle('near', d > 0 && d <= 2);
    }
    const row = idx >= 0 ? centerRows[idx] : null;
    if (row && el.lyricCenter) {
      const c = el.lyricCenter.clientHeight;
      const y = c / 2 - (row.offsetTop + row.offsetHeight / 2);
      el.lyricScroll.style.transform = 'translateY(' + y + 'px)';
    } else {
      el.lyricScroll.style.transform = 'translateY(0)';
    }
    if (pvMode) renderPV(idx >= 0 && lines[idx] ? lines[idx].text : '');
    else if (showMode) renderShow(idx);
  }

  /* 歌综字幕：只显示当前句；旧句按原动效退场、新句轮换动效入场（飞/淡入淡出/弹/滑） */
  let showCurIdx = -2;
  let showFxI = 0;
  const SHOW_FX = ['fly', 'fade', 'pop', 'slide'];
  function renderShow(idx) {
    if (!el.showStage) return;
    if (idx === showCurIdx) return;
    showCurIdx = idx;
    const spd = Math.min(2, Math.max(.5, (config.sh_speed || 100) / 100));
    // 旧句退场：沿用它入场时的动效，播完移除（叠放不挡新句）
    el.showStage.querySelectorAll('.show-cur').forEach((o) => {
      const m = /\bin-(\w+)\b/.exec(o.className);
      o.className = 'show-cur out-' + (m ? m[1] : 'fly');
      const rm = () => { try { o.remove(); } catch (e) {} };
      o.addEventListener('animationend', rm, { once: true });
      setTimeout(rm, Math.round(900 / spd));   // 兜底：动画被打断也能清理
    });
    const cur = idx >= 0 && lines[idx] ? lines[idx].text : '';
    if (!cur) return;
    // 动画选择：轮换 或 固定一种（sh_anim）
    let fx = config.sh_anim;
    if (!fx || fx === 'rotate' || SHOW_FX.indexOf(fx) < 0) {
      fx = SHOW_FX[showFxI % SHOW_FX.length];
      showFxI++;
    }
    const c = document.createElement('div');
    c.className = 'show-cur in-' + fx;
    c.textContent = cur;
    el.showStage.appendChild(c);
  }

  function fmtClock(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function setNpTitle(text) {
    const sc = el.npTitleScroller;
    if (!sc) return;
    const val = text || '';
    if (sc.dataset.txt === val) return;
    sc.dataset.txt = val;
    const titleBox = sc.parentElement;
    sc.classList.remove('animate');
    if (titleBox) titleBox.classList.remove('is-scrolling');
    sc.innerHTML = '<span></span>';
    sc.firstChild.textContent = val || 'Nothing Playing';
    requestAnimationFrame(() => {
      if (titleBox && sc.scrollWidth > titleBox.clientWidth + 2) {
        sc.innerHTML = '<span></span><span></span>';
        sc.children[0].textContent = val; sc.children[1].textContent = val;
        titleBox.classList.add('is-scrolling');
        sc.classList.add('animate');
      }
    });
  }

  function setNpCover(src) {
    if (!el.npCover) return;
    if (!src) { el.npCover.classList.remove('loaded'); el.npCover.removeAttribute('src'); el.npCover.dataset.cur = ''; return; }
    if (el.npCover.dataset.cur !== src) {
      el.npCover.dataset.cur = src;
      el.npCover.classList.remove('loaded');
      el.npCover.onload = () => el.npCover.classList.add('loaded');
      el.npCover.src = src;
    }
  }

  function updateNpProgress() {
    if (viewMode === 'wall' || viewMode === 'box') return;   // box 由 loop 喂时间，其余靠它驱动歌词跟随
    const tc = currentTime();
    const dur = follow.durationMs > 0 ? follow.durationMs / 1000
      : (lines.length ? lines[lines.length - 1].time : 0);
    if (el.npCur) el.npCur.textContent = fmtClock(tc);
    if (el.npRem) el.npRem.textContent = '-' + fmtClock(Math.max(0, dur - tc));
    if (el.npFill) el.npFill.style.width = (dur > 0 ? Math.min(100, (tc / dur) * 100) : 0) + '%';
    // 手动指定优先：显示 pin 那句，忽略时间轴自动定位
    highlightCenter(manualPin ? manualPin.idx : currentLineIndex(tc), false);
  }

  /* ---------------- 初始化：桌面=控制台+实时预览；网页=正式输出（配置驱动） ---------------- */
  window.addEventListener('resize', () => { if (viewMode === 'card') highlightCenter(centerCur, true); });

  if (!isElectron) {
    // 网页：纯输出，隐藏所有控制台 chrome；配置由桌面广播驱动
    document.body.classList.add('app-display');
    followMode = true;
    el.btnFollow.classList.add('active');
    setFollowLabel('跟随中(网页)');
    el.trackName.textContent = '连接服务器中…';
    setNpTitle('');
    updateStatusBadge();
    updateSyncStatus();
    applyConfig({});                       // 先用默认值渲染，避免闪烁
    wallAPI.getConfig().then((cfg) => applyConfig(cfg || {})).catch(() => {});
    wallAPI.onConfig((cfg) => applyConfig(cfg));
  } else {
    // 桌面：大预览为底，面板由左侧导航按需打开
    document.body.classList.add('app-console');
    buildConsole();
    applyConfig({});
    wallAPI.getConfig().then((cfg) => applyConfig(migrateLegacyTy(cfg || {}))).catch(() => {});
    wallAPI.onConfig((cfg) => applyConfig(cfg));
    wallAPI.getServerUrl().then((info) => {
      if (info && info.url) {
        el.serverUrl.textContent = info.url;
        serverOrigin = String(info.url).replace(/\/+$/, '');
        applyBackground();   // origin 就绪后刷新自定义背景图 URL
      }
    }).catch(() => {});
  }
})();
