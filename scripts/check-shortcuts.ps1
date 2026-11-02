param([string]$Executable)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = if ($env:npm_node_execpath) { $env:npm_node_execpath } else { (Get-Command node -ErrorAction Stop).Source }
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$taskFixture = Join-Path $taskRoot 'artifacts\shortcuts\shortcut-fixture.exe'
New-Item -ItemType Directory -Path (Split-Path -Parent $taskFixture) -Force | Out-Null
& $taskCompiler /nologo /optimize+ /platform:x64 /target:exe "/out:$taskFixture" (Join-Path $taskRoot 'native\ShortcutFixture.cs')
if ($LASTEXITCODE -ne 0) { throw 'Shortcut fixture compilation failed' }
$taskOldCheck = $env:STOCK_BAR_SHORTCUT_CHECK
$taskOldExecutable = $env:STOCK_BAR_CHECK_EXECUTABLE
try {
    $env:STOCK_BAR_SHORTCUT_CHECK = '1'
    if ($Executable) { $env:STOCK_BAR_CHECK_EXECUTABLE = (Resolve-Path -LiteralPath $Executable).Path }
    else { Remove-Item Env:STOCK_BAR_CHECK_EXECUTABLE -ErrorAction SilentlyContinue }
    Push-Location $taskRoot
    try { & $taskNode 'node_modules/vitest/vitest.mjs' run 'tests/desktop-shortcuts.test.ts'; if ($LASTEXITCODE -ne 0) { throw 'Native shortcut check failed' } }
    finally { Pop-Location }
} finally { $env:STOCK_BAR_SHORTCUT_CHECK = $taskOldCheck; $env:STOCK_BAR_CHECK_EXECUTABLE = $taskOldExecutable }
