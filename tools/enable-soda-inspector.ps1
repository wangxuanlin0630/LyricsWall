# tools/enable-soda-inspector.ps1 — 激活汽水音乐主进程的 Node inspector (9229)
#
# 原理（复刻 Node 的 process._debugProcess(pid)，对齐 PlayerCap sodamusic/watchdog）：
#   目标 Node/Electron 主进程启动时会建命名映射 node-debug-handler-<pid>，
#   内含一个指针 = 目标地址空间里 StartIoThreadWrapper 的函数地址。
#   激活 = 读出该地址 → CreateRemoteThread 到目标 → 目标自己拉起 inspector I/O 线程。
#   非破坏性：只读命名映射 + 让目标跑它自带的激活函数，不改汽水任何内存/状态。
#
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File enable-soda-inspector.ps1 -ProcId <pid>
# 输出: OK:activated | OK:mapped (成功) / ERR:<reason> (失败)，退出码 0=成功 1=失败
param([Parameter(Mandatory=$true)][int]$ProcId)

$ErrorActionPreference = 'Stop'

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class NativeInsp {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr OpenFileMappingW(uint dwDesiredAccess, bool bInheritHandle, string lpName);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr MapViewOfFile(IntPtr hFileMappingObject, uint dwDesiredAccess, uint dwFileOffsetHigh, uint dwFileOffsetLow, UIntPtr dwNumberOfBytesToMap);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool UnmapViewOfFile(IntPtr lpBaseAddress);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, int processId);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr CreateRemoteThread(IntPtr hProcess, IntPtr lpThreadAttributes, uint dwStackSize, IntPtr lpStartAddress, IntPtr lpParameter, uint dwCreationFlags, out uint lpThreadId);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr hObject);
}
'@
Add-Type -TypeDefinition $sig

$FILE_MAP_READ = 0x0004
# PROCESS_CREATE_THREAD|QUERY_INFORMATION|VM_OPERATION|VM_WRITE|VM_READ
$PROC_ACCESS = 0x0002 -bor 0x0400 -bor 0x0008 -bor 0x0020 -bor 0x0010

$map = [NativeInsp]::OpenFileMappingW($FILE_MAP_READ, $false, "node-debug-handler-$ProcId")
if ($map -eq [IntPtr]::Zero) { Write-Output "ERR:no-mapping"; exit 1 }
try {
  $view = [NativeInsp]::MapViewOfFile($map, $FILE_MAP_READ, 0, 0, [UIntPtr]::Zero)
  if ($view -eq [IntPtr]::Zero) { Write-Output "ERR:map-view"; exit 1 }
  try {
    $handlerAddr = [System.Runtime.InteropServices.Marshal]::ReadInt64($view)
  } finally {
    [NativeInsp]::UnmapViewOfFile($view) | Out-Null
  }
} finally {
  [NativeInsp]::CloseHandle($map) | Out-Null
}
if ($handlerAddr -eq 0) { Write-Output "ERR:null-handler"; exit 1 }

$proc = [NativeInsp]::OpenProcess($PROC_ACCESS, $false, $ProcId)
if ($proc -eq [IntPtr]::Zero) { Write-Output "ERR:open-process"; exit 1 }
try {
  $tid = 0
  $th = [NativeInsp]::CreateRemoteThread($proc, [IntPtr]::Zero, 0, [IntPtr]$handlerAddr, [IntPtr]::Zero, 0, [ref]$tid)
  if ($th -eq [IntPtr]::Zero) { Write-Output "ERR:remote-thread"; exit 1 }
  [NativeInsp]::CloseHandle($th) | Out-Null
} finally {
  [NativeInsp]::CloseHandle($proc) | Out-Null
}
Write-Output "OK:activated"
exit 0
