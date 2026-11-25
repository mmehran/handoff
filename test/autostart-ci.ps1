# Runs scripts\autostart.ps1 for real (CI on Windows): every command, checking the server answers,
# or doesn't, after each one. Uses its own task name.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$task = 'HandoffCI'
function Healthy { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:7860/api/health).StatusCode -eq 200 } catch { $false } }
function Up { for ($i = 0; $i -lt 40; $i++) { if (Healthy) { return } ; Start-Sleep 1 }; Get-Content data\server.log -Tail 40 -ErrorAction SilentlyContinue; throw 'FAIL: not answering' }
function Down { for ($i = 0; $i -lt 20; $i++) { if (-not (Healthy)) { return } ; Start-Sleep 1 }; throw 'FAIL: still answering' }
function Run($action) { & powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 $action -TaskName $task; if ($LASTEXITCODE) { throw "autostart.ps1 $action failed" } }

Run install
Run start;   Up;   'OK: start'
$s = Run status | Out-String; $s; if ($s -notmatch 'running \(pid') { throw 'FAIL: status' }; 'OK: status shows it running'
Run stop;    Down; 'OK: stop'
Start-Sleep 15
if (Healthy) { throw 'FAIL: it came back after stop' }; 'OK: stays off'
Run start;   Up;   'OK: start again'
Run restart; Up;   'OK: restart'
Run uninstall; Down; 'OK: uninstall'
if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { throw 'FAIL: task still there' }; 'OK: gone'
