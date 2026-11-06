using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

// Owns hotkey registrations on one message thread. Keyboard capture exists only
// while the settings window is foreground and explicitly recording a shortcut.
internal static class ShortcutMonitor {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Window; public uint Id; public UIntPtr W; public IntPtr L; public uint Time; public Point Position; public uint Private; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public uint Key, Scan, Flags, Time; public UIntPtr Extra; }
    delegate IntPtr KeyboardProc(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr window, int id);
    [DllImport("user32.dll")] static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, UIntPtr w, IntPtr l);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int kind, KeyboardProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    sealed class Binding { public string Action; public int Modifiers, Key; public string Code { get { return Modifiers + ":" + Key; } } }
    sealed class Registration { public int Id; public Binding Binding; }
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static readonly ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
    static readonly Dictionary<string, Registration> registered = new Dictionary<string, Registration>();
    static readonly HashSet<int> capturedKeys = new HashSet<int>();
    static List<Binding> active = new List<Binding>(), staged;
    static HashSet<string> beforePrepare;
    static readonly string[] actions = { "toggleBar", "togglePanel", "previousPage", "nextPage", "nextMarket" };
    static int nextId = 1;
    static uint thread;
    static IntPtr hook, captureWindow;
    static bool capturing, draining;
    static readonly KeyboardProc keyboardProc = Capture;
    static void Emit(object value) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
    static List<Binding> Parse(Dictionary<string, object> command) {
        var result = new List<Binding>(); var seen = new HashSet<string>(); var seenActions = new HashSet<string>();
        var list = command["bindings"] as IList;
        if (list == null || list.Count > actions.Length) throw new Exception("Invalid bindings");
        foreach (var item in list) {
            var data = item as Dictionary<string, object>;
            var binding = new Binding { Action = Convert.ToString(data["action"]), Modifiers = Convert.ToInt32(data["modifiers"]), Key = Convert.ToInt32(data["key"]) };
            int mods = binding.Modifiers;
            bool key = binding.Key >= 48 && binding.Key <= 57 || binding.Key >= 65 && binding.Key <= 90 || binding.Key >= 37 && binding.Key <= 40 || binding.Key >= 112 && binding.Key <= 122;
            if (Array.IndexOf(actions, binding.Action) < 0 || !key || mods < 1 || mods > 7 || (mods & (mods - 1)) == 0 || !seen.Add(binding.Code) || !seenActions.Add(binding.Action)) throw new Exception("Invalid bindings");
            result.Add(binding);
        }
        return result;
    }
    static bool Add(Binding binding, out int error) {
        error = 0; if (registered.ContainsKey(binding.Code)) return true;
        int id = nextId++;
        if (!RegisterHotKey(IntPtr.Zero, id, (uint)binding.Modifiers | 0x4000, (uint)binding.Key)) { error = Marshal.GetLastWin32Error(); return false; }
        registered.Add(binding.Code, new Registration { Id = id, Binding = binding }); return true;
    }
    static void Keep(List<Binding> bindings) {
        var keep = new HashSet<string>(); foreach (var binding in bindings) keep.Add(binding.Code);
        KeepCodes(keep);
    }
    static void KeepCodes(HashSet<string> keep) {
        foreach (var code in new List<string>(registered.Keys)) if (!keep.Contains(code)) { UnregisterHotKey(IntPtr.Zero, registered[code].Id); registered.Remove(code); }
    }
    static void DiscardQueuedHotkeys() {
        Message queued;
        while (PeekMessage(out queued, IntPtr.Zero, 0x312, 0x312, 1)) { }
    }
    static void Rollback() { if (beforePrepare != null) KeepCodes(beforePrepare); beforePrepare = null; staged = null; DiscardQueuedHotkeys(); }
    static object[] Statuses(List<Binding> bindings) {
        var result = new List<object>();
        foreach (var binding in bindings) result.Add(new { action = binding.Action, active = registered.ContainsKey(binding.Code) });
        return result.ToArray();
    }
    static void StopCapture() {
        capturing = false; draining = false; captureWindow = IntPtr.Zero; capturedKeys.Clear();
        if (hook != IntPtr.Zero) { UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
        DiscardQueuedHotkeys();
    }
    static void EndCapture() {
        capturing = false; captureWindow = IntPtr.Zero;
        // Keep suppressing the recorded primary until its release. Otherwise a
        // held key can become an action as soon as the recorder finishes.
        if (hook != IntPtr.Zero && capturedKeys.Count > 0) draining = true;
        else StopCapture();
    }
    static IntPtr Capture(int code, IntPtr message, IntPtr data) {
        if (code < 0) return CallNextHookEx(hook, code, message, data);
        var input = (Keyboard)Marshal.PtrToStructure(data, typeof(Keyboard));
        int key = (int)input.Key, kind = message.ToInt32();
        if (capturing && GetForegroundWindow() != captureWindow) { EndCapture(); Emit(new { eventType = "capture", cancelled = true }); }
        if (draining) {
            if (capturedKeys.Contains(key)) {
                if (kind == 0x101 || kind == 0x105) { capturedKeys.Remove(key); if (capturedKeys.Count == 0) StopCapture(); }
                return new IntPtr(1);
            }
            return CallNextHookEx(hook, code, message, data);
        }
        if (!capturing) return CallNextHookEx(hook, code, message, data);
        if (kind == 0x101 || kind == 0x105) { if (capturedKeys.Remove(key)) return new IntPtr(1); }
        if (kind == 0x100 || kind == 0x104) {
            if (key == 27) { EndCapture(); Emit(new { eventType = "capture", cancelled = true }); return new IntPtr(1); }
            // Modifier presses and navigation such as Tab are left to the focused settings UI.
            bool primary = key >= 48 && key <= 57 || key >= 65 && key <= 90 || key >= 37 && key <= 40 || key >= 112 && key <= 123;
            if (primary) {
                if (capturedKeys.Add(key)) {
                    int mods = (GetAsyncKeyState(17) < 0 ? 2 : 0) | (GetAsyncKeyState(18) < 0 ? 1 : 0) | (GetAsyncKeyState(16) < 0 ? 4 : 0)
                        | (GetAsyncKeyState(91) < 0 || GetAsyncKeyState(92) < 0 ? 8 : 0);
                    Emit(new { eventType = "capture", modifiers = mods, key = key });
                }
                return new IntPtr(1);
            }
        }
        return CallNextHookEx(hook, code, message, data);
    }
    static void Execute(string line) {
        int id = 0;
        try {
            if (line.Length > 8192) throw new Exception("Command too long");
            var command = json.Deserialize<Dictionary<string, object>>(line);
            id = Convert.ToInt32(command["id"]); string operation = Convert.ToString(command["operation"]);
            if (operation == "capture") {
                if (Convert.ToBoolean(command["active"])) {
                    if (draining) throw new Exception("Release the previous key first");
                    StopCapture();
                    if (staged != null) throw new Exception("Shortcut update in progress");
                    captureWindow = new IntPtr(Convert.ToInt64(command["window"]));
                    if (captureWindow == IntPtr.Zero || GetForegroundWindow() != captureWindow) throw new Exception("Settings window is not focused");
                    hook = SetWindowsHookEx(13, keyboardProc, GetModuleHandle(null), 0);
                    if (hook == IntPtr.Zero) throw new Exception("Keyboard capture unavailable");
                    capturing = true;
                } else EndCapture();
                Emit(new { id = id, ok = true }); return;
            }
            if (capturing) throw new Exception("Finish shortcut recording first");
            if (operation == "prepare" || operation == "sync") {
                if (staged != null) throw new Exception("Shortcut update in progress");
                var bindings = Parse(command); var failures = new List<object>();
                // Pause dispatch while preparing; existing registrations are retained until commit.
                staged = bindings;
                beforePrepare = new HashSet<string>(registered.Keys);
                foreach (var binding in bindings) {
                    int error;
                    if (!Add(binding, out error)) failures.Add(new { action = binding.Action, error = error });
                }
                if (operation == "sync") {
                    active = bindings; Keep(active); staged = null; beforePrepare = null; DiscardQueuedHotkeys();
                    Emit(new { id = id, ok = true, statuses = Statuses(active), failures = failures });
                } else if (failures.Count > 0) {
                    Rollback();
                    Emit(new { id = id, ok = false, failures = failures });
                } else Emit(new { id = id, ok = true });
                return;
            }
            if (operation == "commit") {
                if (staged == null) throw new Exception("No prepared shortcut update");
                active = staged; staged = null; beforePrepare = null; Keep(active); DiscardQueuedHotkeys();
                Emit(new { id = id, ok = true, statuses = Statuses(active) }); return;
            }
            if (operation == "rollback") { Rollback(); Emit(new { id = id, ok = true }); return; }
            throw new Exception("Unknown command");
        } catch { Emit(new { id = id, ok = false, message = "快捷键操作未完成，请重新尝试" }); }
    }
    static int Main(string[] args) {
        try {
            var parent = Process.GetProcessById(Int32.Parse(args[0]));
            thread = GetCurrentThreadId(); Message pending; PeekMessage(out pending, IntPtr.Zero, 0, 0, 0);
            new Thread(delegate() {
                try { string line; while ((line = Console.ReadLine()) != null) { commands.Enqueue(line); PostThreadMessage(thread, 0x8001, UIntPtr.Zero, IntPtr.Zero); } } catch { }
                PostThreadMessage(thread, 0x12, UIntPtr.Zero, IntPtr.Zero);
            }) { IsBackground = true }.Start();
            new Thread(delegate() { try { parent.WaitForExit(); } catch { } PostThreadMessage(thread, 0x12, UIntPtr.Zero, IntPtr.Zero); }) { IsBackground = true }.Start();
            Emit(new { eventType = "ready" });
            Message message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
                if (message.Id == 0x8001) { string line; while (commands.TryDequeue(out line)) Execute(line); }
                else if (message.Id == 0x312 && staged == null && !capturing && !draining) {
                    int id = (int)message.W.ToUInt64();
                    foreach (var binding in active) {
                        Registration registration;
                        if (registered.TryGetValue(binding.Code, out registration) && registration.Id == id) { Emit(new { eventType = "action", action = binding.Action }); break; }
                    }
                }
            }
            return 0;
        } catch { return 1; }
        finally { StopCapture(); foreach (var registration in registered.Values) UnregisterHotKey(IntPtr.Zero, registration.Id); }
    }
}
