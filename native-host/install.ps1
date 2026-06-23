<#
  Register the APItiser local-runner native messaging host on Windows.
  Usage:  powershell -ExecutionPolicy Bypass -File .\install.ps1 <extension-id> [host-name]

  Windows native hosts must be an executable/batch (not a shebang script), and are located
  via a registry key (not a NativeMessagingHosts folder). This writes a .bat launcher that
  calls node by absolute path, drops the host manifest, and registers it for Chromium-based
  browsers per-user.
#>
param(
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [string]$HostName = "com.apitiser.localrunner"
)

$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Install into a stable per-user location and register THAT, so it doesn't depend on the
# (possibly temporary) download folder.
$Target = Join-Path $env:USERPROFILE ".apitiser\runner"
if ($Dir -ne $Target) {
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  Copy-Item -Path (Join-Path $Dir '*') -Destination $Target -Recurse -Force
  Write-Host "Installed runner files -> $Target"
}

$HostScript = Join-Path $Target "apitiser-runner.mjs"
$Launcher = Join-Path $Target "apitiser-runner.bat"
$ManifestPath = Join-Path $Target "$HostName.json"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error "Node.js is required on PATH. Install Node and retry."; exit 1 }
if (-not (Test-Path $HostScript)) { Write-Error "Host script missing: $HostScript"; exit 1 }

# Launcher .bat — invokes node by absolute path; %~dp0 is the launcher's own folder.
@"
@echo off
"$node" "%~dp0apitiser-runner.mjs" %*
"@ | Set-Content -Path $Launcher -Encoding ascii

# Host manifest (path -> the launcher .bat).
$manifest = [ordered]@{
  name            = $HostName
  description     = "APItiser local runner - boots a repo via runLocal for live test validation."
  path            = $Launcher
  type            = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4
Set-Content -Path $ManifestPath -Value $manifest -Encoding utf8

# Register for each Chromium-based browser (per-user). The (default) value is the manifest path.
$targets = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName"
)
foreach ($t in $targets) {
  New-Item -Path $t -Force | Out-Null
  Set-ItemProperty -Path $t -Name "(default)" -Value $ManifestPath
  Write-Host "Registered -> $t"
}

Write-Host ""
Write-Host "Using node: $node"
Write-Host "Done. Host name: $HostName"
Write-Host "Prerequisite: Git for Windows (provides bash) or WSL — runLocal is a bash tool."
Write-Host "In APItiser Settings: enable 'Run Locally', set the repo path, and save."
