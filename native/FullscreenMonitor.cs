using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Windows 11 x64. No titles, screenshots, keyboard hooks, or process contents are read.
internal static class FullscreenMonitor {
    static bool diagnostics;
    static string previousDiagnostic;
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Bounds, Work; public uint Flags; }
    delegate bool EnumWindow(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect bounds);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int GetFrame(IntPtr window, int attribute, out Rect bounds, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int GetCloaked(IntPtr window, int attribute, out int value, int size);

    static List<string> FindFullscreen(uint excludedProcess) {
        var seen = new HashSet<IntPtr>();
        var fullscreen = new List<string>();
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint pid; GetWindowThreadProcessId(window, out pid);
            if (pid == excludedProcess || !IsWindowVisible(window) || IsIconic(window)) return true;
            int cloaked;
            if (GetCloaked(window, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            long extended = GetWindowLongPtr(window, -20).ToInt64();
            if ((extended & (0x80L | 0x08000000L)) != 0) return true; // tool/no-activate overlays
            var className = new StringBuilder(256); GetClassName(window, className, className.Capacity);
            string kind = className.ToString();
            if (kind == "Progman" || kind == "WorkerW" || kind == "Shell_TrayWnd" || kind == "Shell_SecondaryTrayWnd") return true;
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
        return fullscreen;
    }

    static int Main(string[] args) {
        try {
            if (args.Length < 2) return 2;
            diagnostics = args.Length > 2 && args[2] == "--diagnostics";
            var target = new IntPtr(long.Parse(args[0]));
            var parent = Process.GetProcessById(int.Parse(args[1]));
            SetThreadDpiAwarenessContext(new IntPtr(-4)); // per-monitor-aware v2, physical coordinates
            while (!parent.HasExited && IsWindow(target)) {
                var monitors = FindFullscreen((uint)parent.Id);
                string current = MonitorFromWindow(target, 2).ToInt64().ToString();
                Console.WriteLine("{\"monitor\":\"" + current + "\",\"fullscreenMonitors\":[" +
                    (monitors.Count == 0 ? "" : "\"" + string.Join("\",\"", monitors.ToArray()) + "\"") + "]}");
                Console.Out.Flush();
                Thread.Sleep(400);
            }
            return 0;
        } catch { return 1; }
    }
}
