using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// Windows 11 x64. No titles, screenshots, keyboard hooks, or process contents are read.
internal static class FullscreenMonitor {
    static bool diagnostics;
    static string previousDiagnostic;
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Bounds, Work; public uint Flags; }
    [StructLayout(LayoutKind.Sequential)] struct Message {
        public IntPtr Window;
        public uint Id;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int X, Y;
    }
    delegate bool EnumWindow(IntPtr window, IntPtr data);
    delegate void WinEvent(IntPtr hook, uint kind, IntPtr window, int objectId, int childId, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern uint MsgWaitForMultipleObjectsEx(uint count, IntPtr handles, uint timeout, uint wakeMask, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect bounds);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int GetFrame(IntPtr window, int attribute, out Rect bounds, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int GetCloaked(IntPtr window, int attribute, out int value, int size);

    static bool Overlaps(Rect a, Rect b) {
        return a.Left < b.Right && a.Right > b.Left && a.Top < b.Bottom && a.Bottom > b.Top;
    }

    static List<string> FindFullscreen(uint excludedProcess, IntPtr target, List<IntPtr> overlappingTaskbars, out bool taskbarAbove) {
        var seen = new HashSet<IntPtr>();
        var fullscreen = new List<string>();
        Rect targetBounds;
        bool checkTaskbar = GetWindowRect(target, out targetBounds) && IsWindowVisible(target);
        bool beforeTarget = true;
        overlappingTaskbars.Clear();
        bool overlapsTaskbarAbove = false;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            if (window == target) beforeTarget = false;
            uint pid; GetWindowThreadProcessId(window, out pid);
            if (pid == excludedProcess || !IsWindowVisible(window) || IsIconic(window)) return true;
            int cloaked;
            if (GetCloaked(window, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            var className = new StringBuilder(256); GetClassName(window, className, className.Capacity);
            string kind = className.ToString();
            if (kind == "Shell_TrayWnd" || kind == "Shell_SecondaryTrayWnd") {
                Rect taskbarBounds;
                if (checkTaskbar && GetWindowRect(window, out taskbarBounds) && Overlaps(targetBounds, taskbarBounds)) {
                    overlappingTaskbars.Add(window);
                    overlapsTaskbarAbove |= beforeTarget;
                }
                return true;
            }
            if (kind == "Progman" || kind == "WorkerW") return true;
            long extended = GetWindowLongPtr(window, -20).ToInt64();
            if ((extended & (0x80L | 0x08000000L)) != 0) return true; // tool/no-activate overlays
            Rect bounds;
            if (GetFrame(window, 9, out bounds, Marshal.SizeOf(typeof(Rect))) != 0 && !GetWindowRect(window, out bounds)) return true;
            if (bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top) return true;
            IntPtr monitor = MonitorFromWindow(window, 2);
            // EnumWindows is in Z order. A normal window over a fullscreen window occludes it.
            if (monitor == IntPtr.Zero || !seen.Add(monitor)) return true;
            var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
            if (!GetMonitorInfo(monitor, ref info)) return true;
            long style = GetWindowLongPtr(window, -16).ToInt64();
            bool covers = bounds.Left <= info.Bounds.Left + 2 && bounds.Top <= info.Bounds.Top + 2
                && bounds.Right >= info.Bounds.Right - 2 && bounds.Bottom >= info.Bounds.Bottom - 2;
            if (diagnostics) {
                string detail = "candidate pid=" + pid + " class=" + kind + " zoom=" + IsZoomed(window) + " style=" + style.ToString("X")
                    + " covers=" + covers + " rect=" + bounds.Left + "," + bounds.Top + "," + bounds.Right + "," + bounds.Bottom
                    + " monitor=" + info.Bounds.Left + "," + info.Bounds.Top + "," + info.Bounds.Right + "," + info.Bounds.Bottom;
                if (detail != previousDiagnostic) { Console.Error.WriteLine(detail); previousDiagnostic = detail; }
            }
            // A standard maximized window is not fullscreen, including an auto-hidden taskbar.
            if (covers && !IsZoomed(window) && (style & 0x00C00000L) == 0) fullscreen.Add(monitor.ToInt64().ToString());
            return true;
        }, IntPtr.Zero);
        taskbarAbove = overlapsTaskbarAbove;
        return fullscreen;
    }

    static bool TaskbarMovedAbove(IntPtr target, List<IntPtr> overlappingTaskbars) {
        const uint previousWindow = 3;
        // Bound the walk because window order can change while it is being queried.
        IntPtr window = target;
        for (int i = 0; i < 128; i++) {
            window = GetWindow(window, previousWindow);
            if (window == IntPtr.Zero || window == target) break;
            if (overlappingTaskbars.Contains(window)) return true;
        }
        return false;
    }

    static int Main(string[] args) {
        try {
            if (args.Length < 2) return 2;
            diagnostics = args.Length > 2 && args[2] == "--diagnostics";
            var target = new IntPtr(long.Parse(args[0]));
            var parent = Process.GetProcessById(int.Parse(args[1]));
            SetThreadDpiAwarenessContext(new IntPtr(-4)); // per-monitor-aware v2, physical coordinates
            const uint foreground = 0x0003, reorder = 0x8004, outOfContext = 0;
            const uint allInput = 0x04FF, inputAvailable = 0x0004, removeMessage = 1;
            var desktop = GetDesktopWindow();
            var clock = Stopwatch.StartNew();
            bool rescan = false;
            WinEvent onWindowChange = delegate(IntPtr hook, uint kind, IntPtr window, int objectId, int childId, uint thread, uint time) {
                if (kind == foreground || (window == desktop && objectId == 0 && childId == 0)) rescan = true;
            };
            var foregroundHook = SetWinEventHook(foreground, foreground, IntPtr.Zero, onWindowChange, 0, 0, outOfContext);
            var reorderHook = SetWinEventHook(reorder, reorder, IntPtr.Zero, onWindowChange, 0, 0, outOfContext);
            var overlappingTaskbars = new List<IntPtr>();
            try {
                while (!parent.HasExited && IsWindow(target)) {
                    rescan = false;
                    bool taskbarAbove;
                    var monitors = FindFullscreen((uint)parent.Id, target, overlappingTaskbars, out taskbarAbove);
                    string current = MonitorFromWindow(target, 2).ToInt64().ToString();
                    bool watchTaskbar = overlappingTaskbars.Count != 0 && !monitors.Contains(current);
                    // The taskbar can move ahead of the bar without clearing WS_EX_TOPMOST.
                    if (taskbarAbove && watchTaskbar && IsWindowVisible(target)) {
                        const uint noMove = 0x2, noSize = 0x1, noActivate = 0x10, asyncWindowPos = 0x4000;
                        SetWindowPos(target, new IntPtr(-1), 0, 0, 0, 0, noMove | noSize | noActivate | asyncWindowPos);
                    }
                    Console.WriteLine("{\"monitor\":\"" + current + "\",\"fullscreenMonitors\":[" +
                        (monitors.Count == 0 ? "" : "\"" + string.Join("\",\"", monitors.ToArray()) + "\"") + "]}");
                    Console.Out.Flush();
                    // Keep the periodic sample for missed events and the watcher heartbeat.
                    long deadline = clock.ElapsedMilliseconds + 400;
                    while (!rescan) {
                        long remaining = deadline - clock.ElapsedMilliseconds;
                        if (remaining <= 0) break;
                        // Explorer can raise the taskbar after the foreground event, without another notification.
                        uint wait = (uint)(watchTaskbar ? Math.Min(remaining, 16) : remaining);
                        uint result = MsgWaitForMultipleObjectsEx(0, IntPtr.Zero, wait, allInput, inputAvailable);
                        if (result == 0) {
                            Message message;
                            PeekMessage(out message, IntPtr.Zero, 0, 0, removeMessage);
                        } else {
                            const uint waitTimeout = 258;
                            if (result != waitTimeout || (watchTaskbar && TaskbarMovedAbove(target, overlappingTaskbars))) break;
                        }
                    }
                }
            } finally {
                if (foregroundHook != IntPtr.Zero) UnhookWinEvent(foregroundHook);
                if (reorderHook != IntPtr.Zero) UnhookWinEvent(reorderHook);
                GC.KeepAlive(onWindowChange);
            }
            return 0;
        } catch { return 1; }
    }
}
