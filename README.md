# LyricsWall · 动态歌词墙

全屏动态歌词可视化墙 —— 碎片漂浮歌词 + PV 风格排版，适合投影到墙面做氛围，也可作为直播 OBS 歌词图层。

| haruhikage | cyberRuins |
| :---: | :---: |
| ![haruhikage](docs/screenshots/pv_haruhikage.png) | ![cyberRuins](docs/screenshots/pv_cyberRuins.png) |

| geometric | girlyClouds |
| :---: | :---: |
| ![geometric](docs/screenshots/pv_geometric.png) | ![girlyClouds](docs/screenshots/pv_geometric.png) |

---

## 一、快速上手（5 步跑通）

### 第 1 步：下载安装

到 [Releases](https://github.com/wangxuanlin0630/LyricsWall/releases) 下载：

| 文件 | 适合谁 |
| --- | --- |
| `LyricsWall-Setup-x.x.x.exe` | 普通用户：安装一次，有桌面快捷方式，**自带补丁工具**（推荐） |
| `LyricsWall-Portable-x.x.x.exe` | 免安装 / U 盘携带：双击即用，不写注册表 |

系统要求：Windows 10 / 11。

### 第 2 步：打开软件，播放器里开启「SMTC 上报」

软件靠 **Windows 系统媒体控件（SMTC）** 感知"现在在放什么歌"。你只需要在**音乐播放器的设置里**打开对应开关（不同版本菜单位置略有差异，可在设置里搜索"SMTC"或"系统媒体"）：

| 播放器 | 开关位置 | 效果 |
| --- | --- | --- |
| 网易云音乐 | 设置 → 播放 → 开启「使用系统媒体传输控件 (SMTC)」 | 进度精确，零漂移 |
| QQ 音乐 | 设置 → 常规 → 开启「允许将媒体信息共享给系统」 | 进度精确，零漂移 |
| 酷我 / 汽水 / Spotify / Apple Music | 默认已上报，无需设置 | 进度精确，零漂移 |
| PotPlayer / foobar2000 | 默认已上报 | 进度精确，零漂移 |
| **酷狗音乐** | 默认只上报歌名、**不上报进度** | 显示「估算同步」→ 见 [第三步](#三酷狗零漂移补丁全流程) |

> Windows 系统侧无需任何额外设置，软件也不会控制你的播放器，全程只读。

### 第 3 步：在软件总控里打开跟随

打开 LyricsWall 总控面板：

1. 打开「**跟随播放器**」总开关（自动同步系统正在播放的歌曲）
2. 「**识别播放器**」可锁定只跟随某一个播放器（绿点 = 系统当前检测到了它）；不锁定则自动跟随任意在播的
3. 右上角徽标就是同步状态：

| 徽标 | 含义 |
| --- | --- |
| ● 精确同步（SMTC） | 播放器上报了实时进度，**零漂移**，拖动进度条实时感知 |
| ● 精确同步（酷狗直连） | 酷狗已打直连补丁，同样零漂移 |
| ● 估算同步 | 播放器不上报进度（典型就是酷狗），按时间推算，中途开软件/暂停/拖动可能错位 |

### 第 4 步（可选）：投影 / OBS 直播输出

1. 总控里打开「**写文件输出**」和「**局域网访问**」；OBS 用建议再开「**透明背景 (Alpha)**」
2. OBS 添加**浏览器源**，地址填：
   ```
   http://127.0.0.1:8787/web/overlay.html
   ```
3. 手机 / 平板 / 局域网其他设备：把 `127.0.0.1` 换成你电脑的局域网 IP（如 `http://192.168.1.5:8787/web/overlay.html`）
4. 需要纯文本歌名时，读取输出目录下的 `nowplaying.txt` / `nowplaying.json`（打包版统一在 `%APPDATA%\LyricsWall\output\`，开发期在项目 `output\`）

完成。到这里普通播放器已是零漂移；**用酷狗且在意进度错位的，继续往下**。

---

## 二、全屏模式与个性化

- 总控卡片：封面 / 标题 / 进度 / 波形，一键进入全屏歌词墙
- PV 模板：haruhikage、cyberRuins、geometric、girlyClouds、rainCity、classic 等多款排版，速度 / 动量 / 透明度 / BPM 律动可调，附胶片颗粒、扫描线、故障特效
- 碎片盒子：漂浮、旋转、回显参数全可调
- 自定义背景：总控「选择图片」，自动同步到全屏 / 手机 / OBS
- 歌词：自动在线匹配（含 KRC 逐字时间轴），本地缓存；点击歌词行可手动指定当前句

---

## 三、酷狗零漂移补丁（全流程）

**为什么要打**：酷狗不向系统上报实时进度，所以徽标是「估算同步」。补丁只修改酷狗安装目录里的一个文件 `libcef.dll`（9 处字节），打开酷狗内置的调试通道（端口 12233），软件即可直连酷狗读取它自己显示的进度——**零漂移，可随时一键还原**。补丁按指令特征定位，**不绑定酷狗版本号**，酷狗常规更新后重打一次即可；32 位版酷狗不支持（会明确提示）。

### 方式一：安装版自带工具（推荐，无需装任何东西）

1. **完全退出酷狗**（右下角托盘也要退出）
2. 开始菜单搜索 **PowerShell** → 右键 → **以管理员身份运行**
3. 粘贴执行（自定义过安装目录的把第一行改成实际目录）：

```powershell
$dir = "$env:LOCALAPPDATA\Programs\LyricsWall"
$env:ELECTRON_RUN_AS_NODE = "1"

# 查看状态（只读）
& "$dir\LyricsWall.exe" "$dir\resources\app.asar.unpacked\tools\patch-kugou.js" --status

# 打补丁
& "$dir\LyricsWall.exe" "$dir\resources\app.asar.unpacked\tools\patch-kugou.js"
```

看到 `补丁写入并校验成功 ✔` 即完成。脚本会自动备份原文件、校验失败自动回滚。

### 方式二：Node.js 方式（便携版用户 / 开发者）

安装 [Node.js LTS](https://nodejs.org/zh-cn) 后，在管理员 PowerShell 里：

```powershell
# 源码仓库用户
cd LyricsWall
node tools\patch-kugou.js

# 或只下载单个脚本使用（见 docs/kugou-patch.md 内的下载链接）
node patch-kugou.js
```

### 补丁后验证

1. **启动酷狗**，播放任意歌曲
2. 打开 LyricsWall 跟随模式 → 徽标变为 **「● 精确同步（酷狗直连）」**

### 还原补丁

```powershell
# 安装版
& "$dir\LyricsWall.exe" "$dir\resources\app.asar.unpacked\tools\patch-kugou.js" --restore

# Node.js
node tools\patch-kugou.js --restore
```

更多细节（32 位判断、常见报错、找不到安装目录等）见 [docs/kugou-patch.md](docs/kugou-patch.md)。

---

## 四、常见问题

| 现象 | 处理 |
| --- | --- |
| 一直显示「无播放」 | 检查播放器设置里 SMTC / 系统媒体上报开关是否打开；重新播放一首歌 |
| 酷狗显示「估算同步」 | 按第三节打补丁；酷狗更新后失效就重打一次 |
| 提示「特征不匹配 / 32 位」 | 补丁仅支持 64 位版酷狗，详见 docs/kugou-patch.md |
| OBS 黑屏 / 看不到歌词 | 确认总控「跟随播放器」开着；浏览器源地址没写错；勾选浏览器源"刷新时激活" |
| 手机打不开页面 | 确认「局域网访问」开着，且手机与电脑同一网络；防火墙放行 8787 端口 |

---

## 五、给开发者

环境要求：Windows 10/11，Node.js 18+

```bash
npm install
npm start
```

打包发行：

```bash
npm run dist           # 同时生成安装版 + 便携版（dist/）
npm run pack           # 仅生成免安装目录
npm run dist:portable  # 仅便携版
npm run selftest       # 自检
```

目录结构：

```
├─ main.js              # Electron 主进程（窗口/IPC/配置持久化/崩溃日志）
├─ lyrics-service.js    # 在线歌词匹配、缓存、逐字时间轴
├─ players/             # 播放器适配：SMTC 通用 + 酷狗 CDP + 网易云本地库
├─ server/              # HTTP/WS 服务与 nowplaying 输出
├─ src/                 # 渲染层（总控 + 歌词墙 + PV 引擎）
├─ web/overlay.html     # OBS 浏览器源叠加层
├─ tools/               # 探测 / 酷狗补丁 / 自检脚本
└─ docs/                # 教程与模板效果截图
```

技术栈：Electron 31 · PIXI.js · GSAP · Three.js · ws · electron-builder

## License

MIT
