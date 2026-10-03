# LyricsWall 控制端 UI 重构计划

## Context（背景）

控制端（Electron 主窗口）当前把所有功能堆在顶部工具栏（13+ 按钮）和多个独立浮动面板里，信息密度高、层级混乱。用户明确：

- **本软件定位是控制端**——真正给观众看的输出在网页端（wall 页面，手机/OBS），控制端只做控制+预览
- **输出端（`#previewPane` 及其内部）一行不动**——网页端与桌面端共用同一个 `src/index.html`，靠 `body.app-display` 隐藏控制端元素，重构必须保持输出 DOM 和 `wallAPI` 接口完全不变
- 布局选型已定：**左侧竖排导航栏 + 预览区**；预览大小两种模式（大预览 / 右上角小窗）用户可切换

## 目标布局

```
┌──────────────────────────────────────────────────┐
│ #titlebar  标题·歌名·同步徽标           ─ □ ✕    │  精简：去掉工具按钮
├───┬──────────────────────────────────────────────┤
│ ▶ │  #mainArea                                   │
│ ♫ │   ┌────────────────────────────┐             │
│ 🔗│   │ #previewPane（原样不动）   │ ← 大预览：铺满│
│ 📝│   └────────────────────────────┘             │
│ ⚙ │   小窗模式：previewPane 缩至右上 320×180，    │
│ 🌐│   #panelArea 铺满主区显示当前功能面板          │
├───┴──────────────────────────────────────────────┤
│ #statusBar  ▶ ⏸ │ 进度条(可拖) │ 时间 │ 偏移 ± │ 状态│  新增长驻底栏
└──────────────────────────────────────────────────┘
```

左侧导航 5 项（图标+小字）：**播放 / 跟随 / 歌词 / 显示 / 输出**

## 面板内容映射（现有功能全部保留）

| 导航项 | 内容来源 |
| --- | --- |
| 播放 | 现 `#controlBar` 的 btnPlay/btnOpenAudio/btnOpenLrc + 音量条 |
| 跟随 | btnFollow + 播放器选择（CONFIG_SCHEMA "功能"组的 `ft_player`，type:'player' 抽到本面板）+ 偏移 ±/btnRealign/btnRefreshLyrics |
| 歌词 | 现 `#lyricsPanel`（搜索/粘贴两标签）+ 现 `#previewPanel`（歌词预览列表并入第三个标签） |
| 显示 | 现 `#settingsPanel` 控制台（CONFIG_SCHEMA 10 组，`buildConsole()` 机制原样保留，作为本面板内容） |
| 输出 | 服务器地址/二维码、btnOpenWeb、btnFullscreen、OBS 使用说明、更新检查入口 |

底部 `#statusBar`（常驻）：播放/暂停、跟随开关、可拖进度条、curTime/durTime、偏移显示与 ±、同步徽标——由现 `#playerCard` + `#controlBar` 元素迁移重组。

## 实施步骤

### Step 1 — HTML 骨架重组（`src/index.html`）

- `#titlebar` 移除 `#controlBar`，保留标题/窗控；新增 `#syncBadges`（状态徽标迁入）
- 新增 `#sideNav`（5 个导航按钮）、`#panelArea`（5 个面板容器）、`#statusBar`
- 现有元素**保留 id 原样移动**：controlBar 按钮 → 各面板；`#lyricsPanel`/`#previewPanel`/`#settingsPanel` 内容 → `#panelArea` 对应面板；`#playerCard` 的封面/歌名/seek/时间/徽标 → `#statusBar` + 标题栏
- `#previewPane`、`#viewToggle`、`#syncHint`、`#stage`、`#displayView`、`#npCard` **完全不动**
- 图标 sprite 补充 2-3 个新 symbol（输出、跟随已有）

### Step 2 — CSS 新布局（`src/styles.css`）

- 新增：网格布局（56px 导航列 + 主区）、`#sideNav`、`#panelArea` 面板通用样式、`#statusBar`、预览大小切换（`body.prev-large` / `body.prev-mini` 两 class 驱动 previewPane 定位）
- 更新 `body.app-display` 隐藏清单：加上 `#sideNav`、`#statusBar`、`#panelArea`、新标题栏元素（网页端依旧干净）
- 更新 `#updateBanner` 定位适配新布局
- 删除：`#controlBar`、`#playerCard`、旧浮动面板定位样式（Step 4 确认无回归后删）

### Step 3 — 交互逻辑（`src/app.js`）

- 新增导航路由：点击侧导航 → 切换 `#panelArea` 面板 + 面板打开时自动切小窗预览，关闭面板回大预览
- 新增预览大小切换按钮（侧导航底部或标题栏）：`body.prev-mini` ↔ `prev-large`
- 状态条绑定：复用现有 seek/时间/播放/跟随绑定逻辑（函数不变，只改 DOM 引用指向迁移后的同 id 元素——id 不变则大部分绑定零改动）
- 偏移控件、重新对齐、重新匹配歌词迁入"跟随"面板（id 不变，绑定不动）
- 播放器选择：`buildConsole()` 中 `type:'player'` 分支改为渲染到"跟随"面板专属容器（ft_player 从"功能"组 schema 移出，单独处理）
- 三态控制台机制（pv-console/pv-split/pv-full、btnCsPreview/btnCsClose）**删除**，由新导航+预览切换取代
- `#playerCard` 相关代码迁移到 `#statusBar`，封面缩略图放状态条左侧

### Step 4 — 主进程与清理

- `main.js`：窗口默认尺寸 1040×700 → 1200×760（容纳导航+面板+预览）
- `bridge.js` / `preload.js`：**不动**
- 删除旧 CSS、旧面板残留 DOM、失效绑定
- 更新 README 控制台部分截图说明（docs/screenshots 暂不更新图片，后续补）

### Step 5 — 验证（CDP 冒烟测试）

复用 `_scratch/cdp-full-test.js` 模式，逐项验证：

1. 5 个导航面板全部可打开/切换
2. 播放/暂停、跟随 start/stop、歌词搜索（「晴天」）、偏移 ±、重新对齐 —— 功能等价
3. CONFIG_SCHEMA 10 组设置在"显示"面板全部可渲染可切换（抽查 3 组）
4. 预览大/小切换正常，`body.app-display` 下控制端元素全部隐藏（模拟网页端）
5. 更新横幅在控制台开启时显示正常
6. 全程收集 console error = 0
7. wall 网页端（http://127.0.0.1:8787/）用 browser_use 复测渲染无变化

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 输出端被误伤 | previewPane 内 DOM/ID 不碰；`wallAPI` 形状不变；验证步骤含网页端复测 |
| id 迁移遗漏绑定 | 所有 id 保留原名，app.js 的 `el` 引用表（L221-273）不用改，仅新增面板路由代码 |
| ft_player 抽取破坏 schema 渲染 | buildConsole 里特判：type:'player' 的项跳过 schema 常规渲染，改由"跟随"面板挂载 |
| app-display 隐藏清单漏项 | 验证步骤 4 专项测试 |

## 涉及文件

- `src/index.html`（大改：结构重组）
- `src/styles.css`（大改：新增 ~300 行，删除 ~200 行）
- `src/app.js`（中改：新增导航路由 ~150 行，迁移/删除 ~100 行）
- `main.js`（1 行：默认窗口尺寸）
- 不动：`bridge.js`、`preload.js`、previewPane 内部一切、`server/`、wall 输出相关

---

## 当前进度与剩余工作（2026-10-04 续）

已完成：Step 1（index.html 骨架）、Step 2（styles.css 布局）、Step 3 大部分（el 引用表清理、showPanel/closePanel 路由、btnPrevMode、歌词 tab 限定、Escape、.close 清理）。

### 剩余 1 — app.js 三处残留修复

1. **L508** `el.lyricsPanel.classList.add('hidden')`：搜索选歌后引用已删元素。改为 `closePanel()`（应用歌词后回大预览，直接看效果）。
2. **L1356-1375 `type:'player'` 分支**：改为把整张播放器选择卡片挂载到 `document.getElementById('followPlayerSlot')`，不再进入 schema 常规渲染流：
   - buildConsole 的逐项循环中 `if (it.type === 'player') { /* 渲染到 followPlayerSlot，跳过 section 追加 */ continue; }`
   - 保留 `playerChipMap`、`refreshActivePlayers` 轮询、`consoleControls[ft_player]` 回写逻辑不变
   - CONFIG_SCHEMA L123 的 ft_player 条目**保留**（承载默认值与 label/desc/options 数据），仅渲染位置改变
3. **L1663-1664** 启动序列残留：`el.settingsPanel.classList.remove('hidden'); setConsoleState('console');` 删除——新布局启动即为大预览、面板默认隐藏（`#panelArea.hidden`），无需任何面板初始化动作。

改完执行 `node --check src/app.js` 语法检查，并 grep 确认 `btnLyrics|btnSettings|btnCsPreview|btnCsClose|btnPreviewToggle|previewPanel|lyricsPanel|settingsPanel|setConsoleState` 零残留。

### 剩余 2 — main.js 窗口默认尺寸

L289-290 `width: Math.min(1040, ...), height: Math.min(700, ...)` → 改为 `1200 / 760`（容纳侧导航+面板+预览）。

### 剩余 3 — 软件图标重构

- 用文生图接口生成新图标（方形 HD，深色玻璃拟态风格：音符+声波+墙面碎片元素，与 UI 的 --accent #7fd4ff / --accent-2 #c9a6ff 配色一致）
- 下载替换 `build/icon.png`（≥512×512，electron-builder 自动生成 ico；package.json `build.icon` 不变）
- 旧 icon.png 先备份为 icon-old.png 再替换（防生成效果不佳可回退）

### 剩余 4 — CDP 冒烟测试（计划 Step 5 原 7 项不变）

复用 `_scratch/cdp-full-test.js` 模式逐项验证：5 面板切换、播放/跟随/搜索/偏移、显示面板 schema 渲染抽查、prev 大小切换、app-display 隐藏清单、updateBanner、console error = 0；网页端 http://127.0.0.1:8787/ 复测渲染无变化。

验证通过后**仅本地提交，不推送 GitHub/Gitee、不发 Release**——等用户明确指示后再推。
