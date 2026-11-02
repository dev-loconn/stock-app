$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskArtifacts = Join-Path $taskRoot 'artifacts'
New-Item -Path $taskArtifacts -ItemType Directory -Force | Out-Null
$taskOut = Join-Path $taskArtifacts 'ui-check-stdout.log'
$taskErr = Join-Path $taskArtifacts 'ui-check-stderr.log'
$taskCheck = Start-Process -FilePath (Join-Path $taskRoot 'node_modules\electron\dist\electron.exe') -ArgumentList '.', '--ui-check' -WorkingDirectory $taskRoot -WindowStyle Normal -PassThru -RedirectStandardOutput $taskOut -RedirectStandardError $taskErr
if (-not $taskCheck.WaitForExit(20000)) {
    Stop-Process -Id $taskCheck.Id -ErrorAction SilentlyContinue
    throw 'UI check timed out.'
}
Get-Content -LiteralPath $taskOut
Get-Content -LiteralPath $taskErr
if ($taskCheck.ExitCode -ne 0) { exit 1 }
