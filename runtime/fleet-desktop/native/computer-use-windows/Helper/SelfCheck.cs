using System.Runtime.InteropServices;
using static FleetComputerUse.Helper.Native;

namespace FleetComputerUse.Helper;

/// <summary>Win32 pieces for the helper's own 24x24 probe window. Only ever applied to windows this process created.</summary>
internal static unsafe class ProbeNative
{
    public delegate nint WndProc(nint hwnd, uint message, nint w, nint l);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASSEX
    {
        public uint cbSize, style;
        public nint lpfnWndProc;
        public int cbClsExtra, cbWndExtra;
        public nint hInstance, hIcon, hCursor, hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
        public nint hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public nint hwnd; public uint message; public nint wParam, lParam; public uint time; public POINT pt; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "RegisterClassExW")] public static extern ushort RegisterClassEx(ref WNDCLASSEX c);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "UnregisterClassW")] public static extern bool UnregisterClass(string name, nint instance);
    [DllImport("user32.dll", EntryPoint = "DefWindowProcW")] public static extern nint DefWindowProc(nint hwnd, uint message, nint w, nint l);
    [DllImport("user32.dll", EntryPoint = "GetMessageW")] public static extern int GetMessage(out MSG msg, nint hwnd, uint min, uint max);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll", EntryPoint = "DispatchMessageW")] public static extern nint DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] public static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] public static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(nint hwnd, uint key, byte alpha, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetModuleHandleW")] public static extern nint GetModuleHandle(string? name);
}

/// <summary>A tiny click-through, no-activate window that receives one posted click: proves the message path works without touching foreground or pointer.</summary>
internal sealed class ProbeWindow : IDisposable
{
    private readonly Thread thread;
    private readonly ManualResetEventSlim created = new();
    private readonly string className = "FleetComputerUse.Probe." + Guid.NewGuid().ToString("N");
    private readonly ProbeNative.WndProc proc;
    private volatile int clickX = int.MinValue, clickY = int.MinValue;
    private volatile bool failed;

    public nint Hwnd { get; private set; }
    public bool Received => clickX != int.MinValue;
    public (int X, int Y) Click => (clickX, clickY);

    public ProbeWindow()
    {
        proc = WindowProc;
        thread = new Thread(Run) { IsBackground = true, Name = "Fleet probe window" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        created.Wait(2_000);
        if (Hwnd == 0 || failed) throw new InvalidOperationException("probe window unavailable");
    }

    private nint WindowProc(nint hwnd, uint message, nint w, nint l)
    {
        if (message == WM_LBUTTONDOWN)
        {
            clickX = (short)((long)l & 0xFFFF);
            clickY = (short)(((long)l >> 16) & 0xFFFF);
            return 0;
        }
        if (message == WM_DESTROY) { ProbeNative.PostQuitMessage(0); return 0; }
        return ProbeNative.DefWindowProc(hwnd, message, w, l);
    }

    private void Run()
    {
        var instance = ProbeNative.GetModuleHandle(null);
        var wc = new ProbeNative.WNDCLASSEX
        {
            cbSize = (uint)Marshal.SizeOf<ProbeNative.WNDCLASSEX>(), lpfnWndProc = Marshal.GetFunctionPointerForDelegate(proc),
            hInstance = instance, lpszClassName = className,
        };
        if (ProbeNative.RegisterClassEx(ref wc) == 0) { failed = true; created.Set(); return; }
        SystemParametersInfoW(48, 0, out var work, 0);
        var hwnd = CreateWindowEx(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TOPMOST, className, null, WS_POPUP,
            work.L + 8, work.T + 8, 24, 24, 0, 0, instance, 0);
        if (hwnd == 0) { failed = true; created.Set(); return; }
        ProbeNative.SetLayeredWindowAttributes(hwnd, 0, 8, 2);
        ProbeNative.ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        Hwnd = hwnd;
        created.Set();
        while (ProbeNative.GetMessage(out var msg, 0, 0, 0) > 0)
        {
            ProbeNative.TranslateMessage(ref msg);
            ProbeNative.DispatchMessage(ref msg);
        }
        ProbeNative.UnregisterClass(className, instance);
    }

    public void Dispose()
    {
        if (Hwnd != 0) PostMessage(Hwnd, WM_CLOSE, 0, 0);
        thread.Join(500);
    }
}

internal static class SelfCheck
{
    private static (int, int) ProbePoint => (9, 7);

    private static Obj Report(double start, string? reason = null)
    {
        var result = new Obj(("ok", reason == null), ("ms", Clock.MillisSince(start)));
        if (reason != null) result["reason"] = reason;
        return result;
    }

    /// <summary>
    /// Interactive desktop, UI Automation and a posted click on a no-activate probe window, with foreground and pointer
    /// compared before/after. The helper never injects input; this proves the message route itself is intact.
    /// </summary>
    public static Obj Run(HelperService service, CancellationToken ct)
    {
        var start = Clock.Now;
        var desktop = OpenInputDesktop(0, false, 0x100);
        if (desktop == 0) return Report(start, "no_display");
        CloseDesktop(desktop);
        if (GetSystemMetrics(80) <= 0) return Report(start, "no_display");
        try { _ = service.Uia; } catch { return Report(start, "uia_unavailable"); }
        GetCursorPos(out var pointer);
        var front = GetForegroundWindow();
        try
        {
            using var probe = new ProbeWindow();
            Clock.Pause(16, ct);
            var (px, py) = ProbePoint;
            if (!PostMessage(probe.Hwnd, WM_LBUTTONDOWN, (nint)MK_LBUTTON, Make(px, py))) return Report(start, "probe_failed");
            while (!probe.Received && Clock.MillisSince(start) < 500) Clock.Pause(10, ct);
            var frontAfter = GetForegroundWindow();
            var ours = (int)GetCurrentProcessId();
            if ((front != 0 && Owner(front).Pid == ours) || (frontAfter != 0 && Owner(frontAfter).Pid == ours)) return Report(start, "helper_activated");
            if (front != frontAfter) return Report(start, "front_changed");
            GetCursorPos(out var after);
            if (after.X != pointer.X || after.Y != pointer.Y) return Report(start, "pointer_changed");
            if (!probe.Received) return Report(start, "probe_click_not_received");
            if (probe.Click.X != px || probe.Click.Y != py) return Report(start, "probe_coordinate_mismatch");
            return Report(start);
        }
        catch (OperationCanceledException) { throw; }
        catch { return Report(start, "probe_failed"); }
    }
}
