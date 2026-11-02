$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskElectron = Join-Path $taskRoot 'node_modules\electron\dist\electron.exe'
$taskMain = Join-Path $taskRoot 'dist-electron\main\main.js'
if (-not (Test-Path -LiteralPath $taskElectron)) { throw 'Run npm run setup:electron first.' }
if (-not (Test-Path -LiteralPath $taskMain)) { throw 'Run npm run build first.' }
# This is an interactive window. SW_HIDE can keep it invisible even when Chromium has rendered.
Start-Process -FilePath $taskElectron -ArgumentList '.' -WorkingDirectory $taskRoot -WindowStyle Normal | Out-Null
