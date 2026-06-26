$ErrorActionPreference = 'Stop'
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$bridge = "C:\Workspace\Active\homelab-noc-dashboard\homelab-noc-dashboard\homelab-noc-dashboard\ops\windows-bridge\mav-repo-bridge.mjs"
$logFile = "C:\Workspace\Active\homelab-noc-dashboard\homelab-noc-dashboard\homelab-noc-dashboard\ops\windows-bridge\mav-repo-bridge.log"
$port = if ($env:SEO_APP_PORT) { $env:SEO_APP_PORT } else { "8790" }

if (-not (Test-Path $bridge)) {
    Write-Error "SEO App bridge file not found at $bridge"
}

$env:MAV_REPO_DEFAULT = if ($env:MAV_REPO_DEFAULT) {
    $env:MAV_REPO_DEFAULT
} else {
    "C:\Workspace\Active\homelab-noc-dashboard\homelab-noc-dashboard\homelab-noc-dashboard"
}

$env:MAV_REPO_ALLOWED_ROOTS = if ($env:MAV_REPO_ALLOWED_ROOTS) {
    $env:MAV_REPO_ALLOWED_ROOTS
} else {
    "C:\Workspace\Active;C:\Users\carte\CodeProjects"
}

Write-Host "Starting SEO Agents App bridge on http://0.0.0.0:$port ..." -ForegroundColor Cyan
Write-Host "Default repo: $env:MAV_REPO_DEFAULT" -ForegroundColor DarkGray
Write-Host "Allowed roots: $env:MAV_REPO_ALLOWED_ROOTS" -ForegroundColor DarkGray
Write-Host "Log: $logFile" -ForegroundColor DarkGray

cmd.exe /c "node `"$bridge`" >> `"$logFile`" 2>&1"
