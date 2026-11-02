$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskOutput = Join-Path $taskRoot 'artifacts\search-live'
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskProfileBefore = $env:STOCK_BAR_TEST_PROFILE
$taskSettings = Join-Path $env:APPDATA 'stock-bar\stock-bar-settings.json'
$taskHashBefore = if (Test-Path -LiteralPath $taskSettings) { (Get-FileHash -LiteralPath $taskSettings).Hash } else { '' }
$taskStarted = Get-Date
try {
    $env:STOCK_BAR_TEST_PROFILE = Join-Path $taskOutput 'profile'
    # Do not surface SDK console output: only the diagnostic's bounded, redacted JSON is evidence.
    $taskProcess = Start-Process -FilePath (Join-Path $taskRoot 'node_modules\electron\dist\electron.exe') -ArgumentList '.', '--search-live-check' -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskOutput 'stdout.log') -RedirectStandardError (Join-Path $taskOutput 'stderr.log')
    $null = $taskProcess.Handle
    if (-not $taskProcess.WaitForExit(120000)) { Stop-Process -Id $taskProcess.Id; throw 'Real OpenD search check timed out.' }
    if ($taskHashBefore -and (Get-FileHash -LiteralPath $taskSettings).Hash -ne $taskHashBefore) { throw 'Settings changed during the read-only check; re-run once connection setup is finished.' }
    $taskResultPath = Join-Path $taskOutput 'result.json'
    if ($taskProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $taskResultPath) -or (Get-Item -LiteralPath $taskResultPath).LastWriteTime -lt $taskStarted) {
        $taskProgressPath = Join-Path $taskOutput 'progress.json'
        if (Test-Path -LiteralPath $taskProgressPath) { Get-Content -LiteralPath $taskProgressPath -Encoding UTF8 }
        throw 'Real OpenD search check did not pass.'
    }
    Get-Content -LiteralPath $taskResultPath -Encoding UTF8
} finally { $env:STOCK_BAR_TEST_PROFILE = $taskProfileBefore }
