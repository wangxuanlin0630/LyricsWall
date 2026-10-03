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
| 网易云音乐 | 设置 → 播放 → 开启「使用系统媒体传输控件 (SMTC)」 | 网易云**不上报进度**，软件会自动读它的本地播放记录把进度补准，正常播放不漂移；但**拖动进度条不会自动感知**，点一下正在唱的歌词行即可重新对齐 |
| QQ 音乐 | 设置 → 常规 → 开启「允许将媒体信息共享给系统」 | 进度精确，零漂移 |
| **酷狗音乐** | 默认只上报歌名、**不上报进度** | 显示「估算同步」→ 见 [第三步](#三酷狗零漂移补丁全流程) |

> Windows 系统侧无需任何额外设置，软件也不会控制你的播放器，全程只读。

### 第 3 步：在软件总控里打开跟随

打开 LyricsWall 总控面板：

1. 打开「**跟随播放器**」总开关（自动同步系统正在播放的歌曲）
2. 「**识别播放器**」可锁定只跟随某一个播放器（绿点 = 系统当前检测到了它）；不锁定则自动跟随任意在播的
3. 右上角徽标就是同步状态：

| 徽标 | 含义 |
| --- | --- |
| ● 精确同步（SMTC） | 播放器上报了实时进度，**零漂移**，拖动进度条实时感知（网易云经本地库补偿同样精确，但拖动进度条需点歌词行重新对齐） |
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

## 三、酷狗零漂移补丁（小白全流程）

> **这个补丁是干嘛的？** 一句话：酷狗不会把自己的播放进度告诉系统，所以歌词只能"猜"时间（中途打开、暂停过、拖动进度条都可能对不上）。打上补丁后，歌词软件可以直接问酷狗"现在唱到第几秒"，歌词就永远同步了。
> 放心：补丁只改酷狗安装目录里一个文件的小地方，**不动酷狗任何功能**，备份自动做，随时可还原。

以下以**安装版 LyricsWall** 为例（自带工具，什么都不用装）。全过程大约 2 分钟。

---

### 第 1 步：完全退出酷狗

1. 看屏幕**右下角**时间附近，找到酷狗的小图标 → **右键** → 点「**退出**」
2. 还是不放心？按 `Ctrl + Shift + Esc` 打开任务管理器，在列表里找到「酷狗音乐」→ 右键 →「结束任务」

> ⚠️ 酷狗没退干净的话，后面会提示「检测到酷狗正在运行」，什么都打不上。

### 第 2 步：打开"管理员 PowerShell"

1. 点屏幕左下角的**开始按钮**（Win 键）
2. 直接打字输入：`powershell`
3. 在搜索结果「Windows PowerShell」上**点右键** → 选「**以管理员身份运行**」
4. 弹出"是否允许此应用更改设备"→ 点「**是**」

会打开一个蓝底（或黑底）的窗口，光标一闪一闪——这就是要输命令的地方。

### 第 3 步：复制粘贴下面的命令

用鼠标**全选下面三行 → Ctrl+C 复制**，然后**在 PowerShell 窗口里点一下右键**（右键就是粘贴）→ 按**回车**：

```powershell
$dir = "$env:LOCALAPPDATA\Programs\LyricsWall"
$env:ELECTRON_RUN_AS_NODE = "1"
& "$dir\LyricsWall.exe" "$dir\resources\app.asar.unpacked\tools\patch-kugou.js"
```

> 这三行的意思是"借用 LyricsWall 自带的补丁工具给酷狗打补丁"，**不需要看懂**，粘对就行。

**举个例子**，成功时窗口里大致长这样（你的路径会不一样，重点是最后两行）：

```
发现 1 个 libcef.dll：
  [ORIGINAL] [x64] D:\KuGou\20.1.51.27967\libcef.dll

目标: D:\KuGou\20.1.51.27967\libcef.dll
  已备份原始 DLL -> D:\KuGou\20.1.51.27967\libcef.dll.dtgc.bak
  => 补丁写入并校验成功 ✔ 端口将在酷狗下次启动时开启 (12233)。

完成：成功 1 / 1。
```

`[ORIGINAL]` 表示"原始状态、可以打"；如果这里显示的是 `[PATCHED]`，窗口会写「已打过补丁，跳过」，同样不用管。

**看结果**，对照下表：

| 窗口里出现 | 说明 | 下一步 |
| --- | --- | --- |
| `补丁写入并校验成功 ✔` | 打好了 | 去第 4 步 |
| `已打过补丁，跳过` | 之前打过，不用再打 | 去第 4 步 |
| `未发现 libcef.dll，请用参数显式指定路径` | 酷狗没装在默认目录 | 看下面「酷狗装在别处怎么办」 |
| `无法将"…"项识别为…` 或找不到路径 | LyricsWall 没装在默认位置 | 看下面「装在别的盘怎么办」 |
| `检测到酷狗正在运行` | 酷狗没退干净 | 回第 1 步 |
| `拒绝写入` / 提到 `32位` / `特征` | 酷狗版本特殊，工具自动保护 | 见 [docs/kugou-patch.md](docs/kugou-patch.md) 常见问题 |

**酷狗装在别处怎么办**（提示「未发现 libcef.dll」时）：

1. 开始菜单找到 **酷狗音乐** → 右键 → 更多 →「打开文件所在位置」
2. 如果打开的是快捷方式，再右键那个快捷方式 →「打开文件所在位置」
3. 进入的文件夹里找 `libcef.dll`，把它的完整路径记下来
4. 三行命令照旧，最后**加上这个路径**再执行：

```powershell
$dir = "$env:LOCALAPPDATA\Programs\LyricsWall"
$env:ELECTRON_RUN_AS_NODE = "1"
& "$dir\LyricsWall.exe" "$dir\resources\app.asar.unpacked\tools\patch-kugou.js" "D:\酷狗目录\版本号\libcef.dll"
```

懒得找的话，也可以用这条命令自动搜出来（搜到哪个路径就填到上面）：

```powershell
Get-ChildItem "C:\Program Files","C:\Program Files (x86)","D:\" -Filter libcef.dll -Recurse -ErrorAction SilentlyContinue | Select-Object -First 5 FullName
```

**装在别的盘怎么办**（自定义过安装目录才会遇到）：

1. 开始菜单找到 **LyricsWall** 图标 → 右键 →「打开文件位置」
2. 在弹出的窗口里再右键 LyricsWall 快捷方式 →「打开文件所在位置」
3. 看窗口顶部的**地址栏**，复制里面的路径（比如 `D:\Soft\LyricsWall`）
4. 把三行命令的第一行换成这个路径，变成下面这样再整块粘贴执行：

```powershell
$dir = "D:\Soft\LyricsWall"
$env:ELECTRON_RUN_AS_NODE = "1"
& "$dir\LyricsWall.exe" "$dir\resources\app.asar.unpacked\tools\patch-kugou.js"
```

（其余两行原样不动，只换第一行引号里的路径。）

### 第 4 步：验证效果

1. **打开酷狗**，随便播放一首歌（补丁在酷狗重启后才生效）
2. 打开 LyricsWall，进入跟随模式
3. 右上角徽标变成 **「● 精确同步（酷狗直连）」** = 大功告成，试试拖动酷狗的进度条，歌词会立刻跟上

---

### 想撤销？（还原补丁）

同样先退出酷狗、打开管理员 PowerShell，粘贴这一段：

```powershell
$dir = "$env:LOCALAPPDATA\Programs\LyricsWall"
$env:ELECTRON_RUN_AS_NODE = "1"
& "$dir\LyricsWall.exe" "$dir\resources\app.asar.unpacked\tools\patch-kugou.js" --restore
```

**举个例子**，成功时窗口里会有一行：

```
已还原: D:\KuGou\20.1.51.27967\libcef.dll
```

看到「已还原」即恢复原样。

---

### 其他情况

- **便携版 LyricsWall 用户**：安装 [Node.js](https://nodejs.org/zh-cn) 后，下载补丁脚本执行即可，完整步骤见 [docs/kugou-patch.md](docs/kugou-patch.md)
- **酷狗自动更新后**又变回「估算同步」：重复第 1~4 步重打一次（1 分钟）
- 更多报错与原理说明：[docs/kugou-patch.md](docs/kugou-patch.md)

---

## 四、常见问题

| 现象 | 处理 |
| --- | --- |
| 网易云拖动进度条后歌词错位 | 网易云不向系统上报拖动动作；在歌词墙上点击当前正在唱的那句歌词，即可重新对齐 |
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
