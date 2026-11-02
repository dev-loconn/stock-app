param([string]$Executable)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = if ($env:npm_node_execpath) { $env:npm_node_execpath } else { (Get-Command node -ErrorAction Stop).Source }
$taskOldCheck = $env:STOCK_BAR_SEARCH_CHECK
$taskOldExecutable = $env:STOCK_BAR_CHECK_EXECUTABLE
try {
    $env:STOCK_BAR_SEARCH_CHECK = '1'
    if ($Executable) { $env:STOCK_BAR_CHECK_EXECUTABLE = (Resolve-Path -LiteralPath $Executable).Path }
    else { Remove-Item Env:STOCK_BAR_CHECK_EXECUTABLE -ErrorAction SilentlyContinue }
    Push-Location $taskRoot
    try {
        & $taskNode 'node_modules/vitest/vitest.mjs' run 'tests/desktop-search.test.ts'
        if ($LASTEXITCODE -ne 0) { throw 'Native search check failed.' }
    } finally { Pop-Location }
} finally {
    $env:STOCK_BAR_SEARCH_CHECK = $taskOldCheck
    $env:STOCK_BAR_CHECK_EXECUTABLE = $taskOldExecutable
}
