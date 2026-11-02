param(
    [ValidateSet('Preflight','Network','OpenD','Sleep')][string]$Action = 'Preflight',
    [Parameter(Mandatory)][string]$Output,
    [int]$AdapterIndex = 15
)
$ErrorActionPreference = 'Stop'
$taskPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ADMINISTRATOR_TOKEN_REQUIRED' }
$taskOutput = [IO.Path]::GetFullPath($Output)
$taskRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $taskOutput.StartsWith((Join-Path $taskRoot 'artifacts') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'OUTPUT_MUST_BE_INSIDE_WORKSPACE_ARTIFACTS' }
New-Item -Path $taskOutput -ItemType Directory -Force | Out-Null
$taskResult = [ordered]@{action=$Action;startedAt=(Get-Date).ToUniversalTime().ToString('o');passed=$false;administrator=$true}
$taskWakeName = 'StockBarAcceptance-' + [Guid]::NewGuid().ToString('N')
$taskWatchdog = $null
$taskOriginalProcesses = @()
$taskNetworkChanged = $false

function Set-TestPhase([string]$Stage) {
    $taskPhaseJson = [pscustomobject]@{action=$Action;stage=$Stage;at=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $taskOutput 'phase.json'), $taskPhaseJson, [Text.UTF8Encoding]::new($false))
}
function Get-TestState {
    try { return Get-Content -LiteralPath (Join-Path $taskOutput 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}
function Wait-TestState([scriptblock]$Predicate, [int]$Seconds = 90) {
    $taskDeadline = (Get-Date).AddSeconds($Seconds)
    do {
        $taskState = Get-TestState
        $taskAge = if ($taskState) { ([DateTimeOffset]::Now - [DateTimeOffset]$taskState.at).TotalSeconds } else { 999 }
        if ($taskState -and $taskAge -ge -1 -and $taskAge -lt 5 -and (& $Predicate $taskState)) { return $taskState }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $taskDeadline)
    throw 'STATE_WAIT_TIMEOUT'
}
function Quote-Signature($State) { return ($State.rows | ForEach-Object { "$($_.symbol):$($_.price):$($_.sourceEpoch)" }) -join ';' }
function Register-TestWake([int]$Seconds, [int]$RestoreAdapter = 0) {
    $taskRestore = Join-Path $PSScriptRoot 'system-recovery-restore.ps1'
    $taskMarker = Join-Path $taskOutput ($Action + '-watchdog.json')
    $taskArgs = '-NoProfile -File "' + $taskRestore + '" -AdapterIndex ' + $RestoreAdapter + ' -Marker "' + $taskMarker + '"'
    $taskTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds($Seconds)
    $taskSettings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
    $taskIdentityName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $taskRunPrincipal = New-ScheduledTaskPrincipal -UserId $taskIdentityName -LogonType Interactive -RunLevel Highest
    Register-ScheduledTask -TaskName $taskWakeName -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs) -Trigger $taskTrigger -Settings $taskSettings -Principal $taskRunPrincipal | Out-Null
    if (-not (Get-ScheduledTask -TaskName $taskWakeName).Settings.WakeToRun) { throw 'WAKE_TASK_NOT_ARMED' }
}
function Capture-OpenDProcesses {
    $taskCaptured = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Futu_OpenD.exe','FTWebSocket.exe') })
    if (@($taskCaptured | Where-Object Name -eq 'Futu_OpenD.exe').Count -ne 1) { throw 'EXPECTED_ONE_RUNNING_OPEND' }
    foreach ($taskProcessInfo in $taskCaptured) {
        if (-not $taskProcessInfo.ExecutablePath -or -not $taskProcessInfo.CommandLine) { throw 'OPEND_RESTART_METADATA_UNAVAILABLE' }
        $taskCommand = $taskProcessInfo.CommandLine.Trim()
        $taskExe = $taskProcessInfo.ExecutablePath
        if ($taskCommand.StartsWith('"' + $taskExe + '"', [StringComparison]::OrdinalIgnoreCase)) { $taskArguments = $taskCommand.Substring($taskExe.Length + 2).Trim() }
        elseif ($taskCommand.StartsWith($taskExe, [StringComparison]::OrdinalIgnoreCase)) { $taskArguments = $taskCommand.Substring($taskExe.Length).Trim() }
        else {
            $taskTokenMatch = [regex]::Match($taskCommand, '^\s*(?:"(?<program>[^"]*)"|(?<program>\S+))\s*(?<arguments>.*)$')
            $taskProgramName = [IO.Path]::GetFileNameWithoutExtension($taskTokenMatch.Groups['program'].Value.Replace('/','\'))
            if (-not $taskTokenMatch.Success -or $taskProgramName -ne [IO.Path]::GetFileNameWithoutExtension($taskExe)) { throw 'OPEND_RESTART_COMMAND_UNRECOGNIZED' }
            $taskArguments = $taskTokenMatch.Groups['arguments'].Value
        }
        # Arguments may contain credentials. They stay only in this elevated process's memory.
        [pscustomobject]@{Name=$taskProcessInfo.Name;Id=$taskProcessInfo.ProcessId;Executable=$taskExe;Arguments=$taskArguments;Directory=(Split-Path -Parent $taskExe)}
    }
}
function Restore-OpenDProcesses {
    foreach ($taskProcessInfo in ($taskOriginalProcesses | Sort-Object @{Expression={if ($_.Name -eq 'Futu_OpenD.exe') {0} else {1}}})) {
        $taskExisting = @(Get-CimInstance Win32_Process -Filter ("Name='" + $taskProcessInfo.Name + "'") | Where-Object ExecutablePath -eq $taskProcessInfo.Executable)
        if (-not $taskExisting.Count) {
            $taskStart = @{FilePath=$taskProcessInfo.Executable;WorkingDirectory=$taskProcessInfo.Directory;WindowStyle='Hidden';PassThru=$true}
            if ($taskProcessInfo.Arguments) { $taskStart.ArgumentList = $taskProcessInfo.Arguments }
            $null = Start-Process @taskStart
            Start-Sleep -Seconds 5
        }
    }
}

try {
    if ($Action -eq 'Preflight') {
        $taskOriginalProcesses = @(Capture-OpenDProcesses)
        $taskResult.processes = @($taskOriginalProcesses | ForEach-Object { [pscustomobject]@{name=$_.Name;id=$_.Id;restartMetadataAvailable=$true;configDirectoryExists=(Test-Path -LiteralPath $_.Directory)} })
        $taskResult.adapter = Get-NetAdapter -InterfaceIndex $AdapterIndex | Select-Object Name,InterfaceIndex,Status
        $taskResult.pendingAcceptanceWakeTasks = @(Get-ScheduledTask -TaskName 'StockBarAcceptance-*' -ErrorAction SilentlyContinue | Select-Object TaskName,State)
        $taskResult.recentWakeEvents = @(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Power-Troubleshooter';Id=1;StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object {
            $taskXml = [xml]$_.ToXml()
            [pscustomobject]@{recordId=$_.RecordId;at=$_.TimeCreated.ToUniversalTime().ToString('o');data=@($taskXml.Event.EventData.Data | Where-Object Name -in @('SleepTime','WakeTime','TargetState','EffectiveState','WakeSourceType','WakeSourceText') | ForEach-Object { [pscustomobject]@{name=$_.Name;value=$_.InnerText} })}
        })
        $taskResult.passed = $true
    } else {
        $taskBaseline = Wait-TestState { param($s) $s.connection -eq 'connected' -and $s.diagnostics.basicSubscriptions -eq $s.rows.Count -and @($s.rows | Where-Object { $null -eq $_.price }).Count -eq 0 }
        $taskResult.baseline = $taskBaseline
        Set-TestPhase 'baseline'
        if ($Action -eq 'Network') {
            $taskAdapter = Get-NetAdapter -InterfaceIndex $AdapterIndex
            if ($taskAdapter.Status -ne 'Up') { throw 'TARGET_ADAPTER_NOT_ORIGINALLY_UP' }
            if (@(Get-NetAdapter | Where-Object Status -eq 'Up').Count -ne 1) { throw 'NETWORK_TEST_REQUIRES_SINGLE_ACTIVE_ADAPTER' }
            Register-TestWake 70 $AdapterIndex
            $taskWatchdogArgs = '-NoProfile -File "' + (Join-Path $PSScriptRoot 'system-recovery-restore.ps1') + '" -AdapterIndex ' + $AdapterIndex + ' -DelaySeconds 50 -Marker "' + (Join-Path $taskOutput 'Network-process-watchdog.json') + '"'
            $taskWatchdog = Start-Process powershell.exe -ArgumentList $taskWatchdogArgs -WindowStyle Hidden -PassThru
            Set-TestPhase 'offline'
            $taskNetworkChanged = $true
            $taskAdapter | Disable-NetAdapter -Confirm:$false
            $taskResult.disabledAt = (Get-Date).ToUniversalTime().ToString('o')
            $taskResult.adapterWhileOffline = Get-NetAdapter -InterfaceIndex $AdapterIndex | Select-Object Name,InterfaceIndex,Status,AdminStatus
            try {
                $taskOffline = Wait-TestState { param($s) -not $s.online -and $s.connection -ne 'connected' } 35
                $taskResult.offline = $taskOffline
                if ((Quote-Signature $taskOffline) -ne (Quote-Signature $taskBaseline)) { throw 'OFFLINE_QUOTES_OR_SOURCE_TIME_LOST' }
                Start-Sleep -Seconds 5
            } catch { $taskResult.offlineFailure = 'HOST_OFFLINE_NOT_REFLECTED_OR_QUOTES_LOST'; $taskResult.offline = Get-TestState }
            Set-TestPhase 'restore'
            Get-NetAdapter -InterfaceIndex $AdapterIndex | Enable-NetAdapter -Confirm:$false
            $taskNetworkChanged = $false
        } elseif ($Action -eq 'OpenD') {
            $taskOriginalProcesses = @(Capture-OpenDProcesses)
            $taskResult.originalProcesses = @($taskOriginalProcesses | Select-Object Name,Id)
            Set-TestPhase 'offline'
            foreach ($taskProcessInfo in $taskOriginalProcesses) { Stop-Process -Id $taskProcessInfo.Id -Force -ErrorAction SilentlyContinue }
            $taskResult.stoppedAt = (Get-Date).ToUniversalTime().ToString('o')
            $taskOffline = Wait-TestState { param($s) $s.connection -ne 'connected' } 35
            $taskResult.offline = $taskOffline
            if ((Quote-Signature $taskOffline) -ne (Quote-Signature $taskBaseline)) { throw 'OPEND_STOP_QUOTES_OR_SOURCE_TIME_LOST' }
            Start-Sleep -Seconds 5
            Set-TestPhase 'restore'
            Restore-OpenDProcesses
            $taskResult.restartedProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Futu_OpenD.exe','FTWebSocket.exe') } | Select-Object Name,ProcessId)
        } elseif ($Action -eq 'Sleep') {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StockBarSleepAcceptance {
  [StructLayout(LayoutKind.Sequential)] public struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] public struct TokenPrivileges { public uint Count; public Luid Luid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] public struct PowerStatus { public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag; public uint BatteryLifeTime, BatteryFullLifeTime; }
  [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out PowerStatus status);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disable, ref TokenPrivileges state, uint size, IntPtr previous, IntPtr length);
  public static bool EnableShutdownPrivilege() {
    IntPtr token; Luid luid;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) return false;
    try {
      if (!LookupPrivilegeValue(null, "SeShutdownPrivilege", out luid)) return false;
      TokenPrivileges state = new TokenPrivileges { Count=1, Luid=luid, Attributes=2 };
      return AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero) && Marshal.GetLastWin32Error()==0;
    } finally { CloseHandle(token); }
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateWaitableTimer(IntPtr attributes, bool manualReset, string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetWaitableTimer(IntPtr timer, ref long due, int period, IntPtr completion, IntPtr argument, bool resume);
  [DllImport("kernel32.dll")] public static extern bool CancelWaitableTimer(IntPtr timer);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("powrprof.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.U1)] public static extern bool SetSuspendState([MarshalAs(UnmanagedType.U1)]bool hibernate, [MarshalAs(UnmanagedType.U1)]bool forceCritical, [MarshalAs(UnmanagedType.U1)]bool disableWakeEvent);
}
'@
            $taskWakePolicy = (powercfg /query SCHEME_CURRENT SUB_SLEEP RTCWAKE | Out-String)
            $taskResult.wakePolicy = $taskWakePolicy.Trim()
            $taskPowerStatus = New-Object StockBarSleepAcceptance+PowerStatus
            if (-not [StockBarSleepAcceptance]::GetSystemPowerStatus([ref]$taskPowerStatus) -or $taskPowerStatus.ACLineStatus -ne 1) { throw 'AC_POWER_REQUIRED_FOR_CURRENT_WAKE_POLICY' }
            if (-not [StockBarSleepAcceptance]::EnableShutdownPrivilege()) { throw 'SHUTDOWN_PRIVILEGE_UNAVAILABLE' }
            $taskWakeHandle = [StockBarSleepAcceptance]::CreateWaitableTimer([IntPtr]::Zero, $true, $null)
            if ($taskWakeHandle -eq [IntPtr]::Zero) { throw 'WAKE_TIMER_CREATION_FAILED' }
            try {
                Register-TestWake 75
                [long]$taskDue = (Get-Date).ToUniversalTime().AddSeconds(45).ToFileTimeUtc()
                if (-not [StockBarSleepAcceptance]::SetWaitableTimer($taskWakeHandle, [ref]$taskDue, 0, [IntPtr]::Zero, [IntPtr]::Zero, $true) -or [Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 50) { throw 'HARDWARE_WAKE_TIMER_ARM_FAILED' }
                $taskResult.wakeTimerArmed = $true
                Set-TestPhase 'suspend'
                $taskSleepStart = Get-Date
                $taskResult.suspendRequestedAt = $taskSleepStart.ToUniversalTime().ToString('o')
                $taskSleepResult = [StockBarSleepAcceptance]::SetSuspendState($false,$false,$false)
                $taskResult.suspendApiSucceeded = $taskSleepResult
                $taskResult.suspendReturnedAt = (Get-Date).ToUniversalTime().ToString('o')
                $taskResult.elapsedSeconds = ((Get-Date) - $taskSleepStart).TotalSeconds
                Set-TestPhase 'restore'
                Start-Sleep -Seconds 3
                $taskResult.powerLog = @(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Kernel-Power';Id=42,107;StartTime=$taskSleepStart.AddSeconds(-2)} -ErrorAction SilentlyContinue | ForEach-Object {
                    $taskXml = [xml]$_.ToXml()
                    [pscustomobject]@{id=$_.Id;recordId=$_.RecordId;at=$_.TimeCreated.ToUniversalTime().ToString('o');data=@($taskXml.Event.EventData.Data | Where-Object Name -in @('TargetState','EffectiveState') | ForEach-Object { [pscustomobject]@{name=$_.Name;value=$_.InnerText} })}
                })
                if (-not $taskSleepResult -or $taskResult.elapsedSeconds -lt 10 -or @($taskResult.powerLog | Where-Object id -eq 42).Count -eq 0 -or @($taskResult.powerLog | Where-Object id -eq 107).Count -eq 0) { throw 'PHYSICAL_SLEEP_NOT_CONFIRMED_BY_SYSTEM_LOG' }
            } finally { $null = [StockBarSleepAcceptance]::CancelWaitableTimer($taskWakeHandle); $null = [StockBarSleepAcceptance]::CloseHandle($taskWakeHandle) }
        }
        $taskRestoredAt = Get-Date
        $taskRecovered = Wait-TestState { param($s) $s.online -and $s.connection -eq 'connected' -and $s.diagnostics.basicSubscriptions -eq $s.rows.Count } 120
        $taskResult.recovered = $taskRecovered
        if ($Action -eq 'Sleep') {
            $taskSleepOffline = @(Get-Content -LiteralPath (Join-Path $taskOutput 'states.jsonl') -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object {
                $_.phase.action -eq 'Sleep' -and $_.connection -eq 'disconnected' -and [DateTimeOffset]$_.at -ge [DateTimeOffset]$taskResult.startedAt
            } | Select-Object -First 1)
            if (-not $taskSleepOffline.Count -or (Quote-Signature $taskSleepOffline[0]) -ne (Quote-Signature $taskBaseline)) { throw 'PHYSICAL_SLEEP_OLD_QUOTES_NOT_RETAINED' }
            if (@($taskRecovered.events | Where-Object { $_.event -eq 'resume' -and [DateTimeOffset]$_.at -ge [DateTimeOffset]$taskResult.startedAt }).Count -eq 0) { throw 'NATIVE_RESUME_EVENT_NOT_OBSERVED' }
            $taskResult.retainedSleepState = $taskSleepOffline[0]
        }
        $taskResult.recoveryWaitMs = [math]::Round(((Get-Date)-$taskRestoredAt).TotalMilliseconds)
        if ($taskResult.offlineFailure) { throw 'NETWORK_STATE_ACCEPTANCE_FAILED' }
        $taskResult.passed = $true
    }
} catch {
    $taskResult.error = $_.Exception.Message
} finally {
    if ($taskNetworkChanged) { Get-NetAdapter -InterfaceIndex $AdapterIndex | Enable-NetAdapter -Confirm:$false -ErrorAction Continue }
    if ($taskOriginalProcesses.Count -and $Action -eq 'OpenD') { Restore-OpenDProcesses }
    Unregister-ScheduledTask -TaskName $taskWakeName -Confirm:$false -ErrorAction SilentlyContinue
    # Let the independent process watchdog run to its bounded end; it only re-enables the originally-up adapter.
    $taskResult.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    $taskResult | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $taskOutput ($Action + '-result.json')) -Encoding UTF8
}
if (-not $taskResult.passed) { exit 1 }
