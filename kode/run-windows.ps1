param(
  [switch]$SkipSidecars
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$guiDir = Join-Path $workspaceRoot 'apps\gui'
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$gitBin = 'C:\Program Files\Git\bin'

$env:Path = "$cargoBin;$gitBin;$env:Path"
$env:CI = 'true'

function Invoke-Checked([string]$File, [string[]]$Arguments) {
  Write-Host "> $File $($Arguments -join ' ')" -ForegroundColor Cyan
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$File failed with exit code $LASTEXITCODE"
  }
}

if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
  throw 'cargo.exe was not found. Install Rust or add ~/.cargo/bin to PATH.'
}
if (-not (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)) {
  throw 'pnpm.cmd was not found. Install Node.js and pnpm first.'
}

if (-not $SkipSidecars) {
  $bash = Join-Path $gitBin 'bash.exe'
  if (-not (Test-Path -LiteralPath $bash)) {
    throw 'Git Bash was not found. Install Git for Windows or use -SkipSidecars.'
  }
  $rootForBash = $workspaceRoot.Replace('\', '/')
  Invoke-Checked $bash @('-lc', "cd '$rootForBash' && bash apps/gui/build-sidecar.sh")
}

Invoke-Checked 'pnpm.cmd' @('--dir', $guiDir, 'build')
Invoke-Checked 'cargo.exe' @('build', '--release', '-p', 'kode-gui', '--manifest-path', (Join-Path $workspaceRoot 'Cargo.toml'))
Invoke-Checked 'pnpm.cmd' @('--dir', $guiDir, 'tauri', 'bundle', '--bundles', 'nsis')

$installerDir = Join-Path $workspaceRoot 'target\release\bundle\nsis'
$installer = Get-ChildItem -LiteralPath $installerDir -Filter '*-x64-setup.exe' -File | Select-Object -First 1
if ($null -ne $installer) {
  Write-Host "`nInstaller generated: $($installer.FullName)" -ForegroundColor Green
} else {
  throw "Installer not found in $installerDir"
}
