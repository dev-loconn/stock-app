param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
$taskIdentity = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $taskIdentity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ADMINISTRATOR_TOKEN_REQUIRED' }
$taskOutput = [IO.Path]::GetFullPath($Output)
$taskWorkspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $taskOutput.StartsWith((Join-Path $taskWorkspace 'artifacts') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'OUTPUT_MUST_BE_INSIDE_WORKSPACE_ARTIFACTS' }
[IO.File]::WriteAllText((Join-Path $taskOutput 'worker-ready.json'), ('{"administrator":true,"processId":' + $PID + '}'), [Text.UTF8Encoding]::new($false))
$taskPrevious = ''
$taskDeadline = (Get-Date).AddMinutes(18)
while ((Get-Date) -lt $taskDeadline) {
    $taskRequest = $null
    try { $taskRequest = Get-Content -LiteralPath (Join-Path $taskOutput 'request.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    if ($taskRequest -and [string]$taskRequest.id -ne $taskPrevious) {
        $taskPrevious = [string]$taskRequest.id
        if ($taskRequest.action -eq 'Stop') { break }
        if ($taskRequest.action -notin @('Preflight','Network','OpenD','Sleep')) { throw 'UNKNOWN_ACCEPTANCE_ACTION' }
        $taskArguments = '-NoProfile -File "' + (Join-Path $PSScriptRoot 'check-system-recovery.ps1') + '" -Action ' + $taskRequest.action + ' -Output "' + $taskOutput + '"'
        $taskJob = Start-Process powershell.exe -ArgumentList $taskArguments -WorkingDirectory $taskWorkspace -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskOutput ($taskRequest.action + '-stdout.log')) -RedirectStandardError (Join-Path $taskOutput ($taskRequest.action + '-stderr.log'))
        $null = $taskJob.Handle
        if (-not $taskJob.WaitForExit(240000)) { Stop-Process -Id $taskJob.Id; throw 'ACCEPTANCE_ACTION_TIMEOUT' }
        [IO.File]::WriteAllText((Join-Path $taskOutput 'worker-completed.json'), ([pscustomobject]@{id=$taskRequest.id;action=$taskRequest.action;at=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    }
    Start-Sleep -Milliseconds 500
}
