param([switch]$Live)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location $taskRoot
try {
    if ($Live) {
        # Diagnostic mode reads real settings but never saves or changes them.
        $taskOutput = Join-Path $taskRoot 'artifacts\recovery-live'
        New-Item -Path $taskOutput -ItemType Directory -Force | Out-Null
        $taskStarted = Get-Date
        $taskProcess = Start-Process -FilePath (Join-Path $taskRoot 'node_modules\electron\dist\electron.exe') -ArgumentList '.', '--recovery-live-check' -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskOutput 'stdout.log') -RedirectStandardError (Join-Path $taskOutput 'stderr.log')
        $null = $taskProcess.Handle
        if (-not $taskProcess.WaitForExit(180000)) { Stop-Process -Id $taskProcess.Id; throw 'Real OpenD recovery check timed out.' }
        Get-Content -LiteralPath (Join-Path $taskOutput 'stdout.log') -Encoding UTF8
        Get-Content -LiteralPath (Join-Path $taskOutput 'stderr.log') -Encoding UTF8
        $taskResultPath = Join-Path $taskOutput 'result.json'
        if (($null -ne $taskProcess.ExitCode -and $taskProcess.ExitCode -ne 0) -or -not (Test-Path -LiteralPath $taskResultPath)) { throw 'Real OpenD recovery check failed.' }
        $taskResult = Get-Content -LiteralPath $taskResultPath -Raw | ConvertFrom-Json
        if (-not $taskResult.passed -or (Get-Item -LiteralPath $taskResultPath).LastWriteTime -lt $taskStarted) { throw 'Missing current successful recovery evidence.' }
    } else {
        $taskPreviousNativeCheck = $env:STOCK_BAR_NATIVE_CHECK
        try {
            $env:STOCK_BAR_NATIVE_CHECK = '1'
            & node (Join-Path $taskRoot 'node_modules\vitest\vitest.mjs') run tests/desktop-recovery.test.ts
            if ($LASTEXITCODE -ne 0) { throw 'Native recovery check failed.' }
        } finally { $env:STOCK_BAR_NATIVE_CHECK = $taskPreviousNativeCheck }
    }
} finally { Pop-Location }
