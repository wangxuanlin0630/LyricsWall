$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$mediaType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]

Write-Output "===== 1) 运行中的音乐播放器进程 ====="
$names = 'QQMusic','cloudmusic','KuGou','KuwoMusic','Spotify','foobar2000','MusicCenter','PotPlayer'
$procs = Get-Process | Where-Object { $n=$_.ProcessName; ($names | Where-Object { $n -match $_ }) }
if ($procs) { $procs | Select-Object ProcessName, Id, MainWindowTitle | Format-Table -AutoSize | Out-String | Write-Output }
else { Write-Output "(未发现上述播放器进程)" }

Write-Output ""
Write-Output "===== 2) SMTC 当前注册的所有媒体会话 ====="
try {
  $mgr = Await ($mgrType::RequestAsync()) ($mgrType)
  $sessions = $mgr.GetSessions()
  if ($sessions -and $sessions.Count -gt 0) {
    $i = 0
    foreach ($s in $sessions) {
      $i++
      $pb = $s.GetPlaybackInfo()
      $status = if ($pb) { [int]$pb.PlaybackStatus } else { -1 }
      $statusText = switch ($status) { 4 {'PLAYING'} 5 {'PAUSED'} 0 {'CLOSED'} 1 {'OPENED'} 2 {'CHANGING'} 3 {'STOPPED'} default {"?($status)"} }
      $media = Await ($s.TryGetMediaPropertiesAsync()) ($mediaType)
      Write-Output ("[{0}] sourceId = {1}" -f $i, $s.SourceAppUserModelId)
      Write-Output ("     status  = {0}" -f $statusText)
      Write-Output ("     title   = {0}" -f $media.Title)
      Write-Output ("     artist  = {0}" -f $media.Artist)
      $tl = $s.GetTimelineProperties()
      Write-Output ("     pos/dur = {0} / {1} ms" -f [math]::Round($tl.Position.TotalMilliseconds), [math]::Round($tl.EndTime.TotalMilliseconds))
    }
    Write-Output ("--- 共 {0} 个会话 ---" -f $sessions.Count)
  } else {
    Write-Output "(SMTC 无任何会话 —— 说明当前没有播放器向系统注册媒体控制)"
  }
} catch {
  Write-Output ("SMTC 枚举失败: " + $_.Exception.Message)
}
