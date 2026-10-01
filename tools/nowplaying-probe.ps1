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

$out = @{ ok = $false }

try {
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $session = $manager.GetCurrentSession()
  if ($session) {
    $media = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $timeline = $session.GetTimelineProperties()
    $playback = $session.GetPlaybackInfo()
    $out = @{
      ok       = $true
      sourceId = $session.SourceAppUserModelId
      title    = $media.Title
      artist   = $media.Artist
      album    = $media.AlbumTitle
      position = [math]::Round($timeline.Position.TotalMilliseconds)
      duration = [math]::Round($timeline.EndTime.TotalMilliseconds)
      status   = [int]$playback.PlaybackStatus
    }
  } else {
    $out.reason = 'no-current-session'
  }
} catch {
  $out.reason = $_.Exception.Message
}

# 附加：列出所有可用会话（帮助判断酷狗是否接入 SMTC）
try {
  $manager2 = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions = $manager2.GetSessions()
  $list = @()
  foreach ($s in $sessions) { $list += $s.SourceAppUserModelId }
  $out.sessions = $list
} catch {}

# 附加：酷狗进程窗口标题兜底
try {
  $kg = Get-Process KuGou* | Where-Object { $_.MainWindowTitle } | Select-Object -First 1 -ExpandProperty MainWindowTitle
  if ($kg) { $out.kugouTitle = $kg }
} catch {}

$out | ConvertTo-Json -Compress
