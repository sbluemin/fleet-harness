using System.Runtime.InteropServices;
using System.Text;

// Test-only "person" for the real-window smoke runs. It stands in for the user: owns the foreground window, parks the pointer,
// and records every foreground change and pointer position. The helper under test never injects input; this tool may.
internal static unsafe class SmokeTool
{
    delegate nint WndProc(nint h, uint m, nint w, nint l);
    delegate void WinEventProc(nint hook, uint ev, nint hwnd, int obj, int child, uint thread, uint time);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASS { public uint style; public nint proc; public int cls, wnd; public nint inst, icon, cursor, bg; public string? menu; public string name; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public nint h; public uint m; public nint w, l; public uint t; public POINT pt; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassW(ref WNDCLASS c);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern nint CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, nint parent, nint menu, nint inst, nint p);
    [DllImport("user32.dll")] static extern nint DefWindowProcW(nint h, uint m, nint w, nint l);
    [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, nint h, uint a, uint b);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern nint DispatchMessageW(ref MSG m);
    [DllImport("user32.dll")] static extern bool ShowWindow(nint h, int c);
    [DllImport("user32.dll")] static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(nint h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint h, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, nuint extra);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(nint h, char* s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(nint h, char* s, int n);
    [DllImport("user32.dll")] static extern nint SetWinEventHook(uint min, uint max, nint mod, WinEventProc proc, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(nint h);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool IsIconic(nint h);

    static string Describe(nint h)
    {
        if (h == 0) return "none";
        var t = stackalloc char[256]; var c = stackalloc char[128];
        var tl = GetWindowTextW(h, t, 256); var cl = GetClassNameW(h, c, 128);
        return $"{h:X}:{new string(c, 0, cl)}/{new string(t, 0, Math.Min(tl, 50))}";
    }

    static int Main(string[] args)
    {
        switch (args.FirstOrDefault())
        {
            case "blocker": return Blocker();
            case "focus": return Focus();
            case "state": { GetCursorPos(out var p); Console.WriteLine($"fg={Describe(GetForegroundWindow())} cursor={p.X},{p.Y}"); return 0; }
            case "watch": return Watch(args[1]);
            case "raise": { var target = (nint)Convert.ToInt64(args[1], 16); var fgw = GetForegroundWindow(); var ft = GetWindowThreadProcessId(fgw, out _); var me = GetCurrentThreadId(); AttachThreadInput(me, ft, true); ShowWindow(target, 9); SetForegroundWindow(target); AttachThreadInput(me, ft, false); if (GetForegroundWindow() != target) { keybd_event(0x12, 0, 0, 0); keybd_event(0x12, 0, 2, 0); SetForegroundWindow(target); } Thread.Sleep(300); Console.WriteLine($"raised={GetForegroundWindow() == target}"); return 0; }
            case "minimize": { ShowWindow(Convert.ToInt64(args[1], 16) is var v ? (nint)v : 0, args.Length > 2 ? int.Parse(args[2]) : 6); return 0; }
            default: Console.Error.WriteLine("blocker | focus | state | watch <file> | minimize <hex hwnd>"); return 2;
        }
    }

    static WndProc? keep;
    static int Blocker()
    {
        keep = (h, m, w, l) => DefWindowProcW(h, m, w, l);
        var wc = new WNDCLASS { proc = Marshal.GetFunctionPointerForDelegate(keep), name = "FleetSmokeBlocker", bg = 6 };
        RegisterClassW(ref wc);
        var h = CreateWindowExW(0, "FleetSmokeBlocker", "FLEET-BLOCKER (user foreground)", 0x10CF0000 /*OVERLAPPEDWINDOW|VISIBLE*/, 0, 0, 1500, 1250, 0, 0, 0, 0);
        CreateWindowExW(0, "EDIT", "user is typing here", 0x50200844 /*child|visible|vscroll|multiline|autovscroll*/, 10, 10, 800, 400, h, 0, 0, 0);
        ShowWindow(h, 5);
        while (GetMessageW(out var m, 0, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessageW(ref m); }
        return 0;
    }

    static int Focus()
    {
        nint blocker = 0;
        for (var i = 0; i < 100 && blocker == 0; i++) { blocker = FindBlocker(); if (blocker == 0) Thread.Sleep(100); }
        if (blocker == 0) { Console.WriteLine("no blocker"); return 1; }
        var fg = GetForegroundWindow();
        var fgThread = GetWindowThreadProcessId(fg, out _);
        var me = GetCurrentThreadId();
        AttachThreadInput(me, fgThread, true);
        SetForegroundWindow(blocker);
        AttachThreadInput(me, fgThread, false);
        if (GetForegroundWindow() != blocker) { keybd_event(0x12, 0, 0, 0); keybd_event(0x12, 0, 2, 0); SetForegroundWindow(blocker); }
        Thread.Sleep(150);
        // The "person" last typed into their own window: a Shift tap lands on it, so it is the last-input receiver.
        if (GetForegroundWindow() == blocker) { keybd_event(0x10, 0, 0, 0); keybd_event(0x10, 0, 2, 0); }
        SetCursorPos(60, 60);
        Thread.Sleep(100);
        Console.WriteLine($"focused={GetForegroundWindow() == blocker}");
        return 0;
    }

    static nint FindBlocker()
    {
        nint found = 0;
        EnumWindows((h, _) => { var t = stackalloc char[64]; var n = GetWindowTextW(h, t, 64); if (new string(t, 0, n).StartsWith("FLEET-BLOCKER")) { found = h; return false; } return true; }, 0);
        return found;
    }
    delegate bool EnumProc(nint h, nint l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, nint l);

    static WinEventProc? hook;
    static int Watch(string file)
    {
        var log = new StreamWriter(file, false, new UTF8Encoding(false)) { AutoFlush = true };
        hook = (_, _, h, _, _, _, _) => { lock (log) log.WriteLine($"fg-event {Describe(h)}"); };
        SetWinEventHook(3, 3, 0, hook, 0, 0, 0);
        var mover = new Thread(() =>
        {
            POINT last = default;
            nint lastFg = 0;
            while (true)
            {
                var fgNow = GetForegroundWindow();
                if (fgNow != lastFg) { lock (log) log.WriteLine($"fg-poll {Describe(fgNow)}"); lastFg = fgNow; }
                GetCursorPos(out var p);
                if (p.X != last.X || p.Y != last.Y) { lock (log) log.WriteLine($"cursor {p.X},{p.Y}"); last = p; }
                Thread.Sleep(1);
            }
        }) { IsBackground = true };
        mover.Start();
        while (GetMessageW(out var m, 0, 0, 0) > 0) { }
        return 0;
    }
}
