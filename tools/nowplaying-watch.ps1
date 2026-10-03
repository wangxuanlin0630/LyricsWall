$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# 首选播放器关键词（SourceAppUserModelId 模糊匹配）；多个会话同时在播时优先它。
# 留空或不传 = 不偏好，取第一个正在播放的会话。
$preferred = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { '' }

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

# 带超时的 WinRT 异步等待，避免卡死
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  if (-not $netTask.Wait(3000)) { throw 'await-timeout' }
  $netTask.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
$mgrType   = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$mediaType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]

# 直接以 UTF-8 字节写标准输出，彻底规避 GBK 乱码
$stdout = [Console]::OpenStandardOutput()
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Emit($obj) {
  $json = $obj | ConvertTo-Json -Compress
  $bytes = $utf8.GetBytes($json + "`n")
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

# 封面缩略图缓存（固定临时文件，歌变才重写，避免每轮 IO）
$coverFile = Join-Path $env:TEMP 'dtgc_cover.jpg'
$lastCoverKey = $null
$coverOk = $false   # 本会话是否真正写入成功过：只有写成功才上报路径（WinRT 投影失效时流是裸 ComObject、Size=0、写不出）

# 酷狗 ini 状态缓存（事件驱动：切歌/暂停/拖动时才重写）
$iniPath = Join-Path $env:APPDATA 'KuGou8\KuGou.ini'
$lastIniMtime = -1
$lastHash = $null
$lastPos = $null

while ($true) {
  $out = @{ ok = $false }
  $allIds = @()
  try {
    # 每轮重建 manager，避免长连接失效导致"连不上"
    $mgr = Await ($mgrType::RequestAsync()) ($mgrType)

    # 多会话枚举：优先"正在播放"的会话；多个在播时优先 preferred；否则回退当前会话
    $session = $null
    $playing = @()
    $sessions = $mgr.GetSessions()
    if ($sessions) {
      foreach ($s in $sessions) {
        $allIds += [string]$s.SourceAppUserModelId
        $pbx = $s.GetPlaybackInfo()
        if ($pbx -and [int]$pbx.PlaybackStatus -eq 4) { $playing += $s }
      }
    }
    if ($playing.Count -gt 0) {
      if ($preferred) {
        # 指定了首选播放器：只认匹配的会话；匹配不到则不回退（保持 $session=$null → ok:false）
        foreach ($s in $playing) { if ($s.SourceAppUserModelId -match $preferred) { $session = $s; break } }
      } else {
        $session = $playing[0]
      }
    }
    if (-not $session -and -not $preferred) { $session = $mgr.GetCurrentSession() }

    if ($session) {
      $media = Await ($session.TryGetMediaPropertiesAsync()) ($mediaType)
      $tl = $session.GetTimelineProperties()
      $pb = $session.GetPlaybackInfo()
      $lastUpdated = 0
      try { $lastUpdated = $tl.LastUpdatedTime.ToUnixTimeMilliseconds() } catch {}
      if ($lastUpdated -lt 0) { $lastUpdated = 0 }   # 无效时间归零，避免插值算出天文数字
      $rate = 1
      try { if ($null -ne $pb.PlaybackRate) { $rate = [double]$pb.PlaybackRate } } catch {}

      # 封面：歌变才重新落盘。写入成功才记 key（失败留下轮重试）；
      # 只有本会话真实写出过文件才上报路径——绝不上报不存在的路径（上层会当封面有效而显示空白）。
      $coverPath = $null
      try {
        if ($media.Thumbnail) {
          $key = "$($media.Title)|$($media.Artist)"
          if ($key -ne $lastCoverKey) {
            $ras = Await ($media.Thumbnail.OpenReadAsync()) ($streamType)
            $size = [uint64]$ras.Size
            if ($size -gt 0 -and $size -lt 20MB) {
              $reader = New-Object Windows.Storage.Streams.DataReader($ras)
              Await ($reader.LoadAsync([uint32]$size)) ([uint32]) | Out-Null
              $buf = New-Object byte[] $size
              $reader.ReadBytes($buf)
              [IO.File]::WriteAllBytes($coverFile, $buf)
              $lastCoverKey = $key
              $coverOk = $true
            }
          }
          if ($coverOk -and (Test-Path $coverFile)) { $coverPath = $coverFile }
        }
      } catch { $coverPath = $null }

      $out = @{
        ok          = $true
        sourceId    = $session.SourceAppUserModelId
        title       = $media.Title
        artist      = $media.Artist
        album       = $media.AlbumTitle
        coverPath   = $coverPath
        position    = [math]::Round($tl.Position.TotalMilliseconds)
        duration    = [math]::Round($tl.EndTime.TotalMilliseconds)
        lastUpdated = $lastUpdated
        rate        = $rate
        status      = [int]$pb.PlaybackStatus
      }
    } else {
      $out.reason = 'none'
    }
  } catch {
    $out.reason = $_.Exception.Message
  }

  # 读取酷狗 ini：精确 hash + 播放进度（用于精确匹配歌词与拖动/续播重对齐）
  try {
    if (Test-Path $iniPath) {
      $mt = [math]::Round((Get-Item $iniPath).LastWriteTimeUtc.Subtract([datetime]'1970-01-01').TotalMilliseconds)
      $out.iniMtime = $mt
      if ($mt -ne $lastIniMtime) {
        $lastIniMtime = $mt
        $content = Get-Content $iniPath -Raw
        $hm = [regex]::Match($content, '(?m)^LastPlayingSongHash=(.*)$')
        $pm = [regex]::Match($content, '(?m)^LastPlayingSongPos=(\d+)')
        if ($hm.Success) { $lastHash = $hm.Groups[1].Value.Trim() }
        if ($pm.Success) { $lastPos = [int64]$pm.Groups[1].Value }
      }
      if ($lastHash) { $out.krcHash = $lastHash }
      if ($null -ne $lastPos) { $out.krcPos = $lastPos }
    }
  } catch {}

  # 当前所有已注册会话的 sourceId（供上层标记哪些播放器可用，与首选过滤无关，始终输出）
  $out.sessions = $allIds

  Emit $out
  Start-Sleep -Milliseconds 500
}
