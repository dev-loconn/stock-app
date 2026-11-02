param([long]$Handle)
$ErrorActionPreference = 'Stop'
# Read native styles only. This helper does not activate or modify any window.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StockBarWindowInspection {
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern IntPtr GetStyle(IntPtr window, int index);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr window, IntPtr region);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr region, out Rect bounds);
    [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr region, int x, int y);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr region);
}
'@
$taskStyle = [StockBarWindowInspection]::GetStyle([IntPtr]$Handle, -16).ToInt64()
$taskRegion = [StockBarWindowInspection]::CreateRectRgn(0, 0, 0, 0)
try {
    $taskKind = [StockBarWindowInspection]::GetWindowRgn([IntPtr]$Handle, $taskRegion)
    $taskRect = New-Object StockBarWindowInspection+Rect
    [void][StockBarWindowInspection]::GetRgnBox($taskRegion, [ref]$taskRect)
    $taskCornersExcluded = $taskKind -eq 3 -and
        -not [StockBarWindowInspection]::PtInRegion($taskRegion, $taskRect.Left, $taskRect.Top) -and
        -not [StockBarWindowInspection]::PtInRegion($taskRegion, $taskRect.Right - 1, $taskRect.Top) -and
        -not [StockBarWindowInspection]::PtInRegion($taskRegion, $taskRect.Left, $taskRect.Bottom - 1) -and
        -not [StockBarWindowInspection]::PtInRegion($taskRegion, $taskRect.Right - 1, $taskRect.Bottom - 1)
    $taskCenterIncluded = [StockBarWindowInspection]::PtInRegion($taskRegion, [int](($taskRect.Left + $taskRect.Right) / 2), [int](($taskRect.Top + $taskRect.Bottom) / 2))
    @{ style = $taskStyle; thickFrame = ($taskStyle -band 0x00040000) -ne 0; caption = ($taskStyle -band 0x00C00000) -eq 0x00C00000
       cornersExcluded = $taskCornersExcluded; centerIncluded = $taskCenterIncluded } | ConvertTo-Json -Compress
} finally { [void][StockBarWindowInspection]::DeleteObject($taskRegion) }
