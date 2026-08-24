# Build dsh-desktop Windows bundles (NSIS installer + portable exe).
# Requires: Rust stable (msvc toolchain), Node.js 20+, WebView2 runtime
# (preinstalled on Windows 10/11 and GitHub windows runners).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

npm install
npx tauri build --bundles nsis,portable

Write-Host ''
Write-Host 'Artifacts:'
Write-Host '  .\src-tauri\target\release\bundle\nsis\*.exe    (installer)'
Write-Host '  .\src-tauri\target\release\bundle\portable\*.exe (portable)'