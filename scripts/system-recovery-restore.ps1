param([int]$AdapterIndex = 0, [int]$DelaySeconds = 0, [Parameter(Mandatory)][string]$Marker)
$ErrorActionPreference = 'Stop'
if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
try {
    if ($AdapterIndex -gt 0) {
        $taskAdapter = Get-NetAdapter -InterfaceIndex $AdapterIndex
        if ([int]$taskAdapter.AdminStatus -ne 1) { $taskAdapter | Enable-NetAdapter -Confirm:$false }
    }
    [pscustomobject]@{restoredAt=(Get-Date).ToUniversalTime().ToString('o');adapterIndex=$AdapterIndex} | ConvertTo-Json | Set-Content -LiteralPath $Marker -Encoding UTF8
} catch {
    [pscustomobject]@{failedAt=(Get-Date).ToUniversalTime().ToString('o');errorType=$_.Exception.GetType().Name} | ConvertTo-Json | Set-Content -LiteralPath $Marker -Encoding UTF8
    exit 1
}
