# LyricsWall · 动态歌词墙

全屏动态歌词可视化墙 —— 碎片漂浮歌词 + PV 风格排版，适合投影到墙面做氛围，也可作为直播 OBS 歌词图层。

## 效果预览

| haruhikage | cyberRuins |
| :---: | :---: |
| ![haruhikage](docs/screenshots/pv_haruhikage.png) | ![cyberRuins](docs/screenshots/pv_cyberRuins.png) |

| geometric | girlyClouds |
| :---: | :---: |
| ![geometric](docs/screenshots/pv_geometric.png) | ![girlyClouds](docs/screenshots/pv_girlyClouds.png) |

## 功能特性

- **多播放器识别**：通过 Windows SMTC 通用识别酷狗 / QQ音乐 / 网易云 / 酷我 / 汽水 / Spotify / Apple Music / PotPlayer / foobar 等；酷狗另有 CDP 专用适配器（进度更准），网易云本地库补偿时间轴
- **双视图**：桌面总控卡片（封面 / 标题 / 进度 / 波形）+ 全屏碎片歌词墙
- **PV 模板引擎**：内置多款排版模板（haruhikage、cyberRuins、geometric、girlyClouds、rainCity、classic 等），支持速度 / 动量 / 透明度 / BPM 律动调节与胶片颗粒、扫描线、故障特效
- **碎片盒子引擎**：歌词碎片随机漂浮、旋转、回显，参数全可调
- **在线歌词**：自动匹配在线歌词并本地缓存，支持 KRC 解析与逐字时间轴对齐
- **直播输出**：内置 HTTP/WS 服务（默认 `:8787`），提供 OBS 浏览器源叠加层，同时写出 `nowplaying.txt / nowplaying.json`
- **局域网输出**：局域网内其他设备可直接打开歌词墙页面

## 快速开始

环境要求：Windows 10/11，Node.js 18+

```bash
npm install
npm start
```

## 打包发行

```bash
npm run dist
```

在 `dist/` 下同时生成两种产物：

| 文件 | 说明 |
| --- | --- |
| `LyricsWall-Setup-x.x.x.exe` | 安装版（NSIS，可自选安装目录，创建桌面/开始菜单快捷方式） |
| `LyricsWall-Portable-x.x.x.exe` | 便携版（单文件，双击即用，不写注册表） |

其他脚本：

```bash
npm run pack           # 仅生成免安装目录（win-unpacked）
npm run dist:portable  # 仅打包便携版
npm run selftest       # 自检
```

## OBS / 直播接入

1. 在总控中开启「输出」与「局域网」开关
2. OBS 添加浏览器源，地址填 `http://127.0.0.1:8787/web/overlay.html`（局域网设备将 IP 换为本机局域网地址）
3. 如需文本形式的歌名信息，读取输出目录下的 `nowplaying.txt`（开发期在项目 `output/`，打包后在 `userData/output/`）

## 目录结构

```
├─ main.js              # Electron 主进程（窗口/IPC/配置持久化/崩溃日志）
├─ preload.js           # 渲染层桥接
├─ lyrics-service.js    # 在线歌词匹配、缓存、逐字时间轴
├─ krc.js / kugou-cdp.js
├─ src/                 # 渲染层（总控 + 歌词墙）
│  ├─ app.js / animator.js / pv-engine.js / pv-templates.js
│  ├─ box-engine.js / bridge.js / lrc.js
│  └─ vendor/           # pixi / gsap / three（本地化依赖）
├─ players/             # 播放器适配：SMTC 通用 + 酷狗 CDP + 网易云本地库
├─ server/              # HTTP/WS 服务与 nowplaying 输出
├─ web/overlay.html     # OBS 浏览器源叠加层
├─ tools/               # 探测/补丁/自检脚本
└─ docs/screenshots/    # 模板效果截图
```

## 技术栈

Electron 31 · PIXI.js · GSAP · Three.js · ws · electron-builder（NSIS + portable）

## License

MIT
