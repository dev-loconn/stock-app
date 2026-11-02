using System;
using System.Runtime.InteropServices;
using System.Threading;

// Test-only input injector, compiled into artifacts rather than the portable app.
internal static class ShortcutFixture {
    [StructLayout(LayoutKind.Explicit, Size = 40)] struct Input {
        [FieldOffset(0)] public uint Type;
        [FieldOffset(8)] public ushort Key;
        [FieldOffset(12)] public uint Flags;
    }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    static void Key(int key, bool up) {
        var input = new Input { Type = 1, Key = (ushort)key, Flags = (uint)((up ? 2 : 0) | (key >= 37 && key <= 40 ? 1 : 0)) };
        if (SendInput(1, new[] { input }, 40) != 1) throw new Exception("Input injection failed: " + Marshal.GetLastWin32Error());
    }
    static int Main(string[] args) {
        int mods = Int32.Parse(args[0]), primary = Int32.Parse(args[1]), duration = Int32.Parse(args[2]), presses = Int32.Parse(args[3]);
        try {
            if ((mods & 2) != 0) Key(17, false); if ((mods & 1) != 0) Key(18, false); if ((mods & 4) != 0) Key(16, false);
            for (int press = 0; press < presses; press++) {
                Key(primary, false);
                for (int elapsed = 0; elapsed < duration; elapsed += 40) { Thread.Sleep(40); Key(primary, false); }
                Key(primary, true); Thread.Sleep(100);
            }
            return 0;
        } finally {
            Key(primary, true); if ((mods & 4) != 0) Key(16, true); if ((mods & 1) != 0) Key(18, true); if ((mods & 2) != 0) Key(17, true);
        }
    }
}
