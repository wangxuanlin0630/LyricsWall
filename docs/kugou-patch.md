# 酷狗直连补丁教程 —— 让歌词零漂移同步

> 把 LyricsWall 装到其他电脑上，跟随酷狗播放时如果显示「● 估算同步」，说明该电脑的酷狗还没有打直连补丁。本教程面向**普通用户**，无需了解编程，按步骤操作即可。

## 为什么需要补丁

| 状态 | 说明 |
| --- | --- |
| ● 估算同步 | 酷狗不向系统上报实时进度，软件只能按时间推算。中途打开软件、暂停后恢复、拖动进度条，歌词都可能错位 |
| ● 精确同步（酷狗直连） | 补丁打开酷狗内置的调试通道（CDP，端口 12233），软件直连酷狗读取它自己显示的进度。**零漂移**，拖动进度条实时感知 |

补丁只修改酷狗安装目录下的一个文件 `libcef.dll`（9 处字节），不改任何酷狗功能，可随时一键还原。

## 前提条件

1. **酷狗音乐已安装**（已知适配版本：`20.1.51.27967`；其他版本脚本会自动校验字节指纹，不匹配则拒绝写入，不会改坏文件）
2. **酷狗完全退出**：右下角托盘图标也要退出，必要时在任务管理器确认没有 `KuGou.exe` 进程
3. 用**管理员身份**打开终端（补丁要写安装目录里的文件）

## 方式一：安装版 LyricsWall（推荐，无需安装 Node.js）

LyricsWall 安装包自带补丁工具和运行环境，直接用它即可。

**1. 以管理员身份打开 PowerShell**（开始菜单搜 PowerShell → 右键 → 以管理员身份运行）

**2. 执行以下命令**（如果自定义过安装目录，把前两行的路径改成实际目录）：

```powershell
$dir = "$env:LOCALAPPDATA\Programs\LyricsWall"
$exe = "$dir\LyricsWall.exe"
$script = "$dir\resources\app.asar.unpacked\tools\patch-kugou.js"
$env:ELECTRON_RUN_AS_NODE = "1"

# 第一步：查看当前状态（只读，不修改）
& $exe $script --status
```

输出示例：

```
ORIGINAL    C:\Program Files (x86)\KuGou\20.1.51.27967\libcef.dll    ← 未打补丁，可以打
PATCHED     ...                                                      ← 已打过，无需再打
UNKNOWN     ...                                                      ← 版本不匹配，会自动跳过
```

**3. 确认目标显示 `ORIGINAL` 后，打补丁：**

```powershell
& $exe $script
```

看到 `补丁写入并校验成功 ✔` 即完成。脚本会先自动备份原文件为 `libcef.dll.dtgc.bak`，失败会自动回滚。

## 方式二：便携版 / 未安装 LyricsWall

需要先安装 [Node.js LTS](https://nodejs.org/zh-cn)（一路下一步即可），然后下载补丁脚本：

- GitHub：<https://raw.githubusercontent.com/wangxuanlin0630/LyricsWall/main/tools/patch-kugou.js>
- Gitee：<https://gitee.com/miuiwang/LyricsWall/raw/main/tools/patch-kugou.js>

把 `patch-kugou.js` 保存到任意目录（比如 `D:\dtgc-tools\`），在管理员 PowerShell 中：

```powershell
cd D:\dtgc-tools
node patch-kugou.js --status    # 查看状态
node patch-kugou.js             # 打补丁
```

## 打补丁后

1. **启动酷狗**（端口在酷狗下次启动时生效），播放任意歌曲
2. 打开 LyricsWall，进入跟随模式
3. 右上角徽标变为 **「● 精确同步（酷狗直连）」** 即成功

装了 Node.js 的用户可以进一步验证（在酷狗播放时运行，拖动酷狗进度条观察数值实时跳变）：

```powershell
node cdp-probe.js
```

没有 Node.js 也可以用系统命令确认端口已开启：

```powershell
netstat -ano | findstr 12233
```

看到 `LISTENING` 即表示补丁生效。

## 还原补丁

想让酷狗恢复原样时（同样需要酷狗退出 + 管理员权限）：

```powershell
# 安装版用户
& "$env:LOCALAPPDATA\Programs\LyricsWall\LyricsWall.exe" "$env:LOCALAPPDATA\Programs\LyricsWall\resources\app.asar.unpacked\tools\patch-kugou.js" --restore

# Node.js 用户
node patch-kugou.js --restore
```

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 提示「检测到酷狗正在运行」 | 托盘右键退出酷狗；任务管理器结束所有 `KuGou.exe` 进程后重试 |
| 提示「拒绝写入：字节指纹不是纯原始状态」 | 你的酷狗版本与补丁适配版本不同（安全保护，不会改坏文件）。换装适配版本（如 20.1.51.27967）后重试 |
| 打开命令显示「无法加载文件…禁止运行脚本」 | 用上面给出的 `& "完整路径"` 方式调用，或改用 CMD |
| 补丁成功但徽标仍是「估算同步」 | 确认酷狗已重启过；确认播放的是酷狗内的歌曲；重启 LyricsWall 再试 |
| 酷狗自动更新后回到「估算同步」 | 更新替换了 libcef.dll，对新文件重新执行一次打补丁即可 |
| 找不到安装目录 | 酷狗桌面快捷方式 → 右键 → 打开文件位置，向上找到含 `libcef.dll` 的版本目录，把该路径作为参数传给脚本：`node patch-kugou.js "C:\路径\libcef.dll"` |

## 安全性说明

- 写入前校验 9 处字节指纹，**全部匹配才写入**，杜绝改坏未知版本
- 首次写入前自动备份 `libcef.dll → libcef.dll.dtgc.bak`（保留最原始副本）
- 写入后复验，失败自动回滚
- 开启的 12233 端口仅监听本机（127.0.0.1），不对外开放网络
- 补丁思路参考开源项目 PlayerCap（MIT）
