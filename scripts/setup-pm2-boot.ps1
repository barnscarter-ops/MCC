<#
  setup-pm2-boot.ps1
  ------------------------------------------------------------------------------
  Make PM2 — and therefore MCC (mav-console), mav-bridge, etc. — come back by
  itself after a Windows reboot.

  WHY THIS EXISTS: `pm2 startup` is a no-op on Windows. After a reboot the PM2
  daemon does not run and your saved process list is never loaded, so everything
  PM2 managed stays DOWN until someone logs in and runs `pm2 resurrect` by hand.
  This script registers a Scheduled Task that runs `pm2 resurrect` at every boot,
  whether or not anyone logs in.

  RUN ONCE, from an *elevated* PowerShell (Run as Administrator), AFTER your
  processes are up and saved:
      pm2 start C:\Workspace\Active\MCC\ecosystem.config.cjs
      pm2 save
      powershell -ExecutionPolicy Bypass -File C:\Workspace\Active\MCC\scripts\setup-pm2-boot.ps1

  Review the variables below before running.
#>

$ErrorActionPreference = 'Stop'

# --- Review these -------------------------------------------------------------
$TaskName  = 'PM2 Resurrect On Boot'
$RunAsUser = "$env:USERDOMAIN\$env:USERNAME"   # the account whose PM2 home holds the saved dump
# Resolve the pm2 CLI (npm global shim). Override if pm2 lives elsewhere.
$Pm2Cmd = (Get-Command pm2 -ErrorAction SilentlyContinue)?.Source
if (-not $Pm2Cmd) { $Pm2Cmd = Join-Path $env:APPDATA 'npm\pm2.cmd' }
if (-not (Test-Path $Pm2Cmd)) { throw "Could not find pm2. Install with: npm i -g pm2  (looked at $Pm2Cmd)" }
# ------------------------------------------------------------------------------

Write-Host "Registering '$TaskName' to run '$Pm2Cmd resurrect' at startup as $RunAsUser ..."

# `pm2 resurrect` needs the daemon; `pm2 update`/resurrect via the shim handles spawn.
$action  = New-ScheduledTaskAction -Execute $Pm2Cmd -Argument 'resurrect'
$trigger = New-ScheduledTaskTrigger -AtStartup
# Run whether logged on or not, without storing a password (S4U), elevated.
$principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType S4U -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Done. Verify with:  Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host "Test without rebooting:  Start-ScheduledTask -TaskName '$TaskName'; pm2 ls"
Write-Host ""
Write-Host "IMPORTANT: re-run 'pm2 save' any time you add/remove a PM2 app, so the"
Write-Host "saved dump that 'pm2 resurrect' reloads stays current."
