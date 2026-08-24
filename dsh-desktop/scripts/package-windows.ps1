# Build dsh-desktop Windows bundles (NSIS installer).
# Requires: Rust stable (msvc toolchain), Node.js 20+, WebView2 runtime
# (preinstalled on Windows 10/11 and GitHub windows runners).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

npm install
npx tauri build --bundles nsis

Write-Host ''
Write-Host 'Artifacts:'
Write-Host '  .\src-tauri\target\release\bundle\nsis\*.exe    (installer)'