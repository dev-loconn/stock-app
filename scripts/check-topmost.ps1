param([string]$Executable, [switch]$Taskbar)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TopmostLossProbe {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string kind, string title);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLong(IntPtr h, int n);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int l,t,r,b; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
}
'@
$root = Split-Path -Parent $PSScriptRoot
$env:STOCK_BAR_TEST_PROFILE = Join-Path $root 'artifacts/topmost-loss-profile'
New-Item -ItemType Directory -Force -Path $env:STOCK_BAR_TEST_PROFILE | Out-Null
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Ordinary window overlap test'
$form.ShowInTaskbar = $false
$form.Show()
$form.WindowState = [System.Windows.Forms.FormWindowState]::Maximized
$binary = if ($Executable) { (Resolve-Path -LiteralPath $Executable).Path } else { Join-Path $root 'node_modules/electron/dist/electron.exe' }
$arguments = if ($Executable) { @('--ui-check', '--topmost-check') } else { @('.', '--ui-check', '--topmost-check') }
$proc = Start-Process -FilePath $binary -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Normal -PassThru
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  $bar = [IntPtr]::Zero
  while ([DateTime]::UtcNow -lt $deadline -and $bar -eq [IntPtr]::Zero -and -not $proc.HasExited) {
    [System.Windows.Forms.Application]::DoEvents()
    $script:found = [IntPtr]::Zero
    [void][TopmostLossProbe]::EnumWindows({ param($h,$p) $owner = 0; [void][TopmostLossProbe]::GetWindowThreadProcessId($h,[ref]$owner); $r = New-Object TopmostLossProbe+Rect; [void][TopmostLossProbe]::GetWindowRect($h,[ref]$r); if ($owner -eq $proc.Id -and [TopmostLossProbe]::IsWindowVisible($h) -and ($r.b - $r.t) -lt 150 -and ($r.r - $r.l) -gt 200) { $script:found = $h; return $false }; return $true }, [IntPtr]::Zero)
    $bar = $script:found
    if ($bar -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 20 }
  }
  if ($bar -eq [IntPtr]::Zero) { throw 'Visible bar not found' }
  Start-Sleep -Seconds 1
  [void][TopmostLossProbe]::SetForegroundWindow($form.Handle)
  $rect = New-Object TopmostLossProbe+Rect
  [void][TopmostLossProbe]::GetWindowRect($bar,[ref]$rect)
  if ($Taskbar) {
    $taskbarWindow = [TopmostLossProbe]::FindWindow('Shell_TrayWnd', $null)
    $taskbarRect = New-Object TopmostLossProbe+Rect
    if (-not [TopmostLossProbe]::GetWindowRect($taskbarWindow, [ref]$taskbarRect)) { throw 'Taskbar not found' }
    $x = [int](($taskbarRect.l + $taskbarRect.r - ($rect.r - $rect.l)) / 2)
    $y = [int](($taskbarRect.t + $taskbarRect.b - ($rect.b - $rect.t)) / 2)
    if (-not [TopmostLossProbe]::SetWindowPos($bar, [IntPtr](-1), $x, $y, 0, 0, 0x11)) { throw 'Could not place bar over taskbar' }
    $point = New-Object TopmostLossProbe+Point
    $point.x = [int](($taskbarRect.l + $taskbarRect.r) / 2)
    $point.y = [int](($taskbarRect.t + $taskbarRect.b) / 2)
    if ([TopmostLossProbe]::GetAncestor([TopmostLossProbe]::WindowFromPoint($point), 2) -ne $bar) { throw 'Bar was not initially above the taskbar' }
    if (-not [TopmostLossProbe]::SetWindowPos($taskbarWindow, [IntPtr](-1), 0, 0, 0, 0, 0x13)) { throw 'Could not raise taskbar' }
    $hit = [TopmostLossProbe]::GetAncestor([TopmostLossProbe]::WindowFromPoint($point), 2)
    if ($hit -ne $taskbarWindow -or ([TopmostLossProbe]::GetWindowLong($bar,-20).ToInt64() -band 8) -eq 0) { throw 'Injection did not obscure the still-topmost bar with the taskbar' }
    $foregroundBefore = [TopmostLossProbe]::GetForegroundWindow()
    Start-Sleep -Seconds 2
    $recovered = [TopmostLossProbe]::GetAncestor([TopmostLossProbe]::WindowFromPoint($point), 2) -eq $bar
    $focusUnchanged = [TopmostLossProbe]::GetForegroundWindow() -eq $foregroundBefore
    @{ obscuredWhileTopmost = $true; recoveredAboveTaskbar = $recovered; focusUnchanged = $focusUnchanged } | ConvertTo-Json -Compress
    if (-not $recovered -or -not $focusUnchanged) { exit 1 }
    return
  }
  $point = New-Object TopmostLossProbe+Point
  $point.x = [int](($rect.l + $rect.r) / 2); $point.y = [int](($rect.t + $rect.b) / 2)
  $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
  [void][TopmostLossProbe]::SetWindowPos($form.Handle, [IntPtr]::Zero, $rect.l, $rect.t, ($rect.r - $rect.l + 100), ($rect.b - $rect.t + 150), 0x10)
  $before = [TopmostLossProbe]::GetAncestor([TopmostLossProbe]::WindowFromPoint($point), 2) -eq $bar
  if (-not $before) { throw 'Bar is already obscured before the injected condition' }
  # Simulate an external change that removes topmost and lowers the bar without activating it.
  if (-not [TopmostLossProbe]::SetWindowPos($bar, [IntPtr](1), 0, 0, 0, 0, 0x13)) { throw 'Could not simulate loss of topmost' }
  [void][TopmostLossProbe]::SetWindowPos($form.Handle, [IntPtr]::Zero, 0, 0, 0, 0, 0x13)
  [void][TopmostLossProbe]::SetForegroundWindow($form.Handle)
  $injectedTopmost = ([TopmostLossProbe]::GetWindowLong($bar,-20).ToInt64() -band 8) -ne 0
  $obscured = [TopmostLossProbe]::GetAncestor([TopmostLossProbe]::WindowFromPoint($point), 2) -ne $bar
  if ($injectedTopmost -or -not $obscured) { $fr=New-Object TopmostLossProbe+Rect; [void][TopmostLossProbe]::GetWindowRect($form.Handle,[ref]$fr); $hit=[TopmostLossProbe]::GetAncestor([TopmostLossProbe]::WindowFromPoint($point), 2); throw "Injection did not remove topmost and obscure the bar: topmost=$injectedTopmost obscured=$obscured hit=$hit fixture=$($form.Handle) bar=$($rect.l),$($rect.t),$($rect.r),$($rect.b) fixtureBounds=$($fr.l),$($fr.t),$($fr.r),$($fr.b)" }
  $foregroundBefore = [TopmostLossProbe]::GetForegroundWindow()
  Start-Sleep -Seconds 4
  $after = [TopmostLossProbe]::GetAncestor([TopmostLossProbe]::WindowFromPoint($point), 2) -eq $bar
  $focusUnchanged = [TopmostLossProbe]::GetForegroundWindow() -eq $foregroundBefore
  $result = @{ initiallyAbove = $before; injectionRemovedTopmost = -not $injectedTopmost; injectedObscured = $obscured; recoveredAbove = $after; recoveredTopmost = ([TopmostLossProbe]::GetWindowLong($bar,-20).ToInt64() -band 8) -ne 0; focusUnchanged = $focusUnchanged; barVisible = [TopmostLossProbe]::IsWindowVisible($bar) }
  $result | ConvertTo-Json -Compress
  if (-not $after -or -not $focusUnchanged) { exit 1 }
} finally { $form.Close(); if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force } }
