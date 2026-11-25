using System.ComponentModel;
using System.Runtime.InteropServices;

namespace FleetComputerUse.Cursor;

internal static class Win32
{
    internal const uint Layered = 0x80000, Transparent = 0x20, NoActivate = 0x08000000, ToolWindow = 0x80, Topmost = 8;
    internal const uint Popup = 0x80000000;
    internal const uint NoSize = 1, NoMove = 2, NoZOrder = 4, NoActivatePos = 0x10, Show = 0x40, NoOwnerZOrder = 0x200;
    internal const uint WmTimer = 0x113, WmMouseActivate = 0x21, WmNcHitTest = 0x84, WmCommands = 0x8001;
    internal const uint Previous = 3, Next = 2, DestroyEvent = 0x8001, AncestorRoot = 2;
    internal const int ExtendedStyle = -20;

    [StructLayout(LayoutKind.Sequential)] internal record struct Point(int X, int Y);
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] internal record struct Size(int Width, int Height);
    [StructLayout(LayoutKind.Sequential)] internal struct Msg { public nint Window; public uint Id; public nuint WParam; public nint LParam; public uint Time; public Point Point; public uint Private; }
    [StructLayout(LayoutKind.Sequential)] internal struct BitmapInfo
    {
        public uint Size;
        public int Width, Height;
        public ushort Planes, BitCount;
        public uint Compression, SizeImage;
        public int XPelsPerMeter, YPelsPerMeter;
        public uint ColorsUsed, ColorsImportant, Color;
    }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] internal record struct Blend(byte Operation, byte Flags, byte ConstantAlpha, byte AlphaFormat);
    internal delegate nint WndProc(nint window, uint message, nuint wParam, nint lParam);
    internal delegate void EventProc(nint hook, uint @event, nint window, int objectId, int childId, uint thread, uint time);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct WindowClass
    {
        public uint Style;
        public WndProc Procedure;
        public int ClassExtra, WindowExtra;
        public nint Instance, Icon, Cursor, Background;
        public string? MenuName;
        public string ClassName;
    }

    internal static Win32Exception Error(string operation) => new(Marshal.GetLastWin32Error(), operation);

    [DllImport("kernel32", CharSet = CharSet.Unicode)] internal static extern nint GetModuleHandle(string? name);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern ushort RegisterClass(in WindowClass windowClass);
    [DllImport("user32", CharSet = CharSet.Unicode)] internal static extern bool UnregisterClass(string className, nint instance);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern nint CreateWindowEx(uint exStyle, string className, string? title, uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);
    [DllImport("user32", CharSet = CharSet.Unicode)] internal static extern nint DefWindowProc(nint window, uint message, nuint wParam, nint lParam);
    [DllImport("user32")] internal static extern bool DestroyWindow(nint window);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern int GetMessage(out Msg message, nint window, uint min, uint max);
    [DllImport("user32", CharSet = CharSet.Unicode)] internal static extern nint DispatchMessage(in Msg message);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool PostMessage(nint window, uint message, nuint wParam, nint lParam);
    [DllImport("user32")] internal static extern void PostQuitMessage(int exitCode);
    [DllImport("user32", SetLastError = true)] internal static extern nuint SetTimer(nint window, nuint id, uint interval, nint timerProc);
    [DllImport("user32")] internal static extern bool KillTimer(nint window, nuint id);
    [DllImport("user32")] internal static extern bool IsWindowVisible(nint window);
    [DllImport("user32")] internal static extern bool IsIconic(nint window);
    [DllImport("user32")] internal static extern bool IsWindow(nint window);
    [DllImport("user32")] internal static extern nint GetAncestor(nint window, uint flags);
    [DllImport("user32")] internal static extern uint GetWindowThreadProcessId(nint window, out uint process);
    [DllImport("user32")] internal static extern nint GetWindow(nint window, uint command);
    [DllImport("user32", EntryPoint = "GetWindowLongPtrW")] internal static extern nint GetWindowLongPtr(nint window, int index);
    [DllImport("user32", SetLastError = true)] private static extern bool SetWindowPos(nint window, nint insertAfter, int x, int y, int width, int height, uint flags);
    // Centralize the invariant; callers cannot accidentally activate a window.
    internal static bool Position(nint window, nint after, int x, int y, int width, int height, uint flags) =>
        SetWindowPos(window, after, x, y, width, height, flags | NoActivatePos | NoOwnerZOrder);
    [DllImport("user32")] internal static extern bool ShowWindow(nint window, int command);
    [DllImport("user32", SetLastError = true)] internal static extern bool UpdateLayeredWindow(nint window, nint destinationDc, in Point destination, in Size size, nint sourceDc, in Point source, uint colorKey, in Blend blend, uint flags);
    [DllImport("user32", SetLastError = true)] internal static extern nint SetThreadDpiAwarenessContext(nint context);
    [DllImport("user32")] internal static extern uint GetDpiForWindow(nint window);
    [DllImport("user32")] internal static extern nint MonitorFromPoint(Point point, uint flags);
    [DllImport("user32")] internal static extern nint MonitorFromRect(in Rect rect, uint flags);
    [DllImport("user32")] internal static extern bool GetWindowRect(nint window, out Rect rect);
    [DllImport("user32")] internal static extern bool GetClientRect(nint window, out Rect rect);
    [DllImport("user32")] internal static extern bool ClientToScreen(nint window, ref Point point);
    [DllImport("user32", CharSet = CharSet.Unicode)] internal static extern bool SystemParametersInfo(uint action, uint param, out int value, uint flags);
    [DllImport("user32")] internal static extern nint SetWinEventHook(uint min, uint max, nint module, EventProc callback, uint process, uint thread, uint flags);
    [DllImport("user32")] internal static extern bool UnhookWinEvent(nint hook);
    [DllImport("dwmapi")] internal static extern int DwmGetWindowAttribute(nint window, uint attribute, out uint value, uint size);
    [DllImport("user32")] internal static extern nint GetDC(nint window);
    [DllImport("user32")] internal static extern int ReleaseDC(nint window, nint dc);
    [DllImport("gdi32", SetLastError = true)] internal static extern nint CreateCompatibleDC(nint dc);
    [DllImport("gdi32")] internal static extern bool DeleteDC(nint dc);
    [DllImport("gdi32", SetLastError = true)] internal static extern nint CreateDIBSection(nint dc, in BitmapInfo info, uint usage, out nint bits, nint section, uint offset);
    [DllImport("gdi32", SetLastError = true)] internal static extern nint SelectObject(nint dc, nint obj);
    [DllImport("gdi32")] internal static extern bool DeleteObject(nint obj);
}
