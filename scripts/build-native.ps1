$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $taskCompiler)) { throw 'Windows x64 .NET Framework C# compiler is required to build the fullscreen monitor.' }
$taskOutput = Join-Path $taskRoot 'dist-electron\native'
New-Item -Path $taskOutput -ItemType Directory -Force | Out-Null
foreach ($taskNative in @(@('FullscreenMonitor.cs', 'fullscreen-monitor.exe'), @('ShortcutMonitor.cs', 'shortcut-monitor.exe'))) {
    $taskNativeSource = Join-Path $taskRoot ('native\' + $taskNative[0])
    $taskNativeOutput = Join-Path $taskOutput $taskNative[1]
    # Unchanged native processes may be in use by the running app.
    if ((Test-Path -LiteralPath $taskNativeOutput) -and
        (Get-Item -LiteralPath $taskNativeOutput).LastWriteTimeUtc -ge (Get-Item -LiteralPath $taskNativeSource).LastWriteTimeUtc) { continue }
    & $taskCompiler /nologo /optimize+ /platform:x64 /target:exe /reference:System.Web.Extensions.dll "/out:$taskNativeOutput" $taskNativeSource
    if ($LASTEXITCODE -ne 0) { throw ('Native build failed: ' + $taskNative[0]) }
}
