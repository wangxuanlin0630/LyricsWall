$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$root = $AE::RootElement

# 找酷狗主窗口
$procs = Get-Process KuGou* | Where-Object { $_.MainWindowHandle -ne 0 }
$result = @()
foreach ($p in $procs) {
  $result += "PROC: $($p.ProcessName) hwnd=$($p.MainWindowHandle) title=$($p.MainWindowTitle)"
  try {
    $el = $AE::FromHandle($p.MainWindowHandle)
    if (-not $el) { continue }

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $timeRegex = [regex]'\d{1,2}:\d{2}'
    $found = 0
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@($el, 0))

    while ($queue.Count -gt 0 -and $found -lt 40) {
      $item = $queue.Dequeue()
      $node = $item[0]; $depth = $item[1]
      if ($depth -gt 12) { continue }

      $name = $node.Current.Name
      $ctype = $node.Current.ControlType.ProgrammaticName
      $cls = $node.Current.ClassName
      $aid = $node.Current.AutomationId

      $interesting = $false
      if ($name -and $timeRegex.IsMatch($name)) { $interesting = $true }
      if ($ctype -match 'Slider|ProgressBar|Text') { $interesting = $true }

      if ($interesting) {
        $val = ''
        try {
          $rp = $node.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
          if ($rp) { $val = "RANGE($($rp.Current.Value)/$($rp.Current.Minimum)..$($rp.Current.Maximum))" }
        } catch {}
        if (-not $val) {
          try {
            $vp = $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($vp) { $val = "VALUE($($vp.Current.Value))" }
          } catch {}
        }
        $result += ("  d$depth [$ctype] cls='$cls' aid='$aid' name='$name' $val")
        $found++
      }

      $child = $walker.GetFirstChild($node)
      while ($child) {
        $queue.Enqueue(@($child, $depth + 1))
        $child = $walker.GetNextSibling($child)
      }
    }
    $result += "  (interesting nodes: $found)"
  } catch {
    $result += "  ERR: $($_.Exception.Message)"
  }
}
if ($result.Count -eq 0) { $result += 'NO KUGOU MAIN WINDOW' }

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("$PSScriptRoot\uia_out.txt", ($result -join "`n"), $utf8)
