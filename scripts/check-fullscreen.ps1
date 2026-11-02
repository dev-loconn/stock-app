param([string]$Executable, [string]$Output, [switch]$Live)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $Output) { $Output = Join-Path $taskRoot 'artifacts\fullscreen-dev' }
New-Item -Path $Output -ItemType Directory -Force | Out-Null
if (-not $Live) { $env:STOCK_BAR_TEST_PROFILE = Join-Path $Output 'profile' }
$env:STOCK_BAR_CHECK_OUTPUT = $Output
try {
    $taskArguments = @('--fullscreen-check')
    if ($Live) { $taskArguments = @('--fullscreen-live-check') }
    if (-not $Executable) {
        $Executable = Join-Path $taskRoot 'node_modules\electron\dist\electron.exe'
        $taskArguments = @('.') + $taskArguments
    }
    $taskWorking = if ($taskArguments[0] -eq '.') { $taskRoot } else { Split-Path -Parent $Executable }
    $taskProcess = Start-Process -FilePath $Executable -ArgumentList $taskArguments -WorkingDirectory $taskWorking -WindowStyle Normal -PassThru -RedirectStandardOutput (Join-Path $Output 'stdout.log') -RedirectStandardError (Join-Path $Output 'stderr.log')
    if (-not $taskProcess.WaitForExit(60000)) { Stop-Process -Id $taskProcess.Id; throw 'Fullscreen check timed out.' }
    Get-Content -LiteralPath (Join-Path $Output 'stdout.log')
    Get-Content -LiteralPath (Join-Path $Output 'stderr.log')
    if ($taskProcess.ExitCode -ne 0) { throw 'Fullscreen check failed.' }
    $taskResult = Get-Content -LiteralPath (Join-Path $Output 'fullscreen-check.json') -Raw | ConvertFrom-Json
    if (-not $taskResult.passed) { throw 'Fullscreen evidence reports failure.' }
} finally { Remove-Item Env:STOCK_BAR_TEST_PROFILE -ErrorAction SilentlyContinue; Remove-Item Env:STOCK_BAR_CHECK_OUTPUT -ErrorAction SilentlyContinue }
