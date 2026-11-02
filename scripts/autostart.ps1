# Windows autostart: a per-user scheduled task that starts Handoff hidden at every logon and
# starts it again within 5 minutes if it ever stops. Settings come from .env as usual.
# Output goes to data\server.log (or data\whatsapp-only.log); a quick tunnel's URL is in data\public-url.txt.
#
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 install [-WhatsAppOnly]
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 start|stop|restart|status|uninstall
#
# Use "stop" here rather than Stop-ScheduledTask: that only ends the hidden console window and
# leaves Node (and its cloudflared) running, and the 5-minute check would start it again anyway.
param(
  [Parameter(Position = 0)][ValidateSet('install', 'start', 'stop', 'restart', 'status', 'uninstall')]
  [string]$Action = 'install',
  [switch]$WhatsAppOnly,
  [string]$TaskName = 'Handoff'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'src'

function Get-Task { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

# Node processes the task started from this folder (it runs the script by its full path).
# Callers wrap this in @(): a single CIM object has no .Count in Windows PowerShell 5.1.
function Get-HandoffProcesses {
  $pattern = '*' + [WildcardPattern]::Escape("$src\") + '*'
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like $pattern })
}

function Stop-Handoff {
  if (Get-Task) {
    Stop-ScheduledTask -TaskName $TaskName                 # ends the hidden console window
    Disable-ScheduledTask -TaskName $TaskName | Out-Null   # keeps the 5-minute check from starting it again
  }
  $procs = @(Get-HandoffProcesses)
  # /T also ends its children: cloudflared and any claude sessions Handoff started
  foreach ($p in $procs) { taskkill.exe /PID $p.ProcessId /T /F 2>&1 | Out-Null }
  Write-Host "Stopped ($($procs.Count) Handoff process(es) ended)."
}

function Start-Handoff {
  if (-not (Get-Task)) { throw "Task '$TaskName' is not installed. Run: scripts\autostart.ps1 install" }
  Enable-ScheduledTask -TaskName $TaskName | Out-Null
  $running = @(Get-HandoffProcesses)
  if ($running.Count) { Write-Host "Already running (pid $($running.ProcessId -join ', '))."; return }
  Start-ScheduledTask -TaskName $TaskName
  Write-Host 'Started.'
}

switch ($Action) {
  'install' {
    $node = (Get-Command node).Source
    $entry = Join-Path $src $(if ($WhatsAppOnly) { 'whatsapp-only.js' } else { 'index.js' })
    # conhost --headless runs the console app without opening a window
    $taskAction = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
      -Argument "--headless `"$node`" `"$entry`" --log-file" -WorkingDirectory $root
    $logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $logon.Delay = 'PT30S' # give Wi-Fi a moment to connect after logon
    # safety net: every 5 minutes, start it if it isn't running (IgnoreNew makes this a no-op while it runs)
    $every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger @($logon, $every5) -Settings $settings `
      -Description "Handoff: remote control and notifications for Claude Code ($root)" -Force | Out-Null
    Write-Host "Installed task '$TaskName' ($(if ($WhatsAppOnly) { 'WhatsApp only' } else { 'full app' })). It starts at every logon and comes back within 5 minutes if it stops."
    if (@(Get-HandoffProcesses).Count) { Write-Host 'Handoff is already running; use "restart" to apply the new settings.' }
    else { Write-Host 'Start it now with: scripts\autostart.ps1 start' }
  }
  'start' { Start-Handoff }
  'stop' { Stop-Handoff; Write-Host 'It stays off (also after logon) until: scripts\autostart.ps1 start' }
  'restart' { Stop-Handoff; Start-Sleep -Seconds 2; Start-Handoff }
  'status' {
    $task = Get-Task
    Write-Host ("Task:    " + $(if ($task) { "$($task.State)" } else { 'not installed' }))
    $procs = @(Get-HandoffProcesses)
    Write-Host ("Process: " + $(if ($procs.Count) { "running (pid $($procs.ProcessId -join ', '))" } else { 'not running' }))
    $url = Join-Path $root 'data\public-url.txt'
    if ($procs.Count -and (Test-Path $url)) { Write-Host ("Address: " + (Get-Content $url -TotalCount 1)) }
  }
  'uninstall' {
    Stop-Handoff
    if (Get-Task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    Write-Host "Removed task '$TaskName'."
  }
}
