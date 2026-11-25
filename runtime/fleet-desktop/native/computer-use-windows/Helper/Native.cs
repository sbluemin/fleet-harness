using System.Runtime.InteropServices;
using System.Text;

namespace FleetComputerUse.Helper;

/// <summary>
/// Win32 surface used by the helper. Deliberately absent: SendInput, SetCursorPos, keybd_event, mouse_event,
/// SetWindowPos on foreign windows, ShowWindow on foreign windows, BitBlt from the screen DC. The helper never
/// injects hardware-level input and never raises another window.
/// </summary>
internal static unsafe class Native
{
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; public int W => R - L; public int H => B - T; }
    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public uint cbSize, flags;
        public nint hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT
    {
        public uint length, flags, showCmd;
        public POINT ptMinPosition, ptMaxPosition;
        public RECT rcNormalPosition;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER
    {
        public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount;
        public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter; public uint biClrUsed, biClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct SHELLEXECUTEINFO
    {
        public uint cbSize, fMask; public nint hwnd;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpVerb;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpParameters;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpDirectory;
        public int nShow; public nint hInstApp, lpIDList;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpClass;
        public nint hkeyClass; public uint dwHotKey; public nint hIconOrMonitor, hProcess;
    }

    public delegate bool EnumProc(nint hwnd, nint lParam);

    public const uint WM_NULL = 0, WM_CHAR = 0x102, WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105,
        WM_MOUSEMOVE = 0x200, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202, WM_LBUTTONDBLCLK = 0x203,
        WM_RBUTTONDOWN = 0x204, WM_RBUTTONUP = 0x205, WM_MOUSEWHEEL = 0x20A, WM_MOUSEHWHEEL = 0x20E,
        WM_CONTEXTMENU = 0x7B, WM_DESTROY = 2, WM_CLOSE = 0x10, WM_NCCREATE = 0x81;
    public const uint MK_LBUTTON = 1, MK_RBUTTON = 2, MK_SHIFT = 4, MK_CONTROL = 8;
    public const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
    public const uint WS_POPUP = 0x80000000, WS_VISIBLE = 0x10000000, WS_CAPTION = 0xC00000;
    public const uint WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000, WS_EX_NOACTIVATE = 0x08000000, WS_EX_LAYERED = 0x80000, WS_EX_TOPMOST = 8;
    public const uint GA_ROOT = 2, GA_ROOTOWNER = 3, GW_OWNER = 4;
    public const uint SMTO_ABORTIFHUNG = 2, SMTO_BLOCK = 1;
    public const uint CWP_SKIPINVISIBLE = 1, CWP_SKIPDISABLED = 2, CWP_SKIPTRANSPARENT = 4;
    public const uint PW_RENDERFULLCONTENT = 2;
    public const int DWMWA_CLOAKED = 14, DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    public const int SW_SHOWNORMAL = 1, SW_SHOWNOACTIVATE = 4;

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, nint l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(nint parent, EnumProc proc, nint l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(nint h, char* text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(nint h, char* text, int max);
    [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(nint h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(nint h);
    [DllImport("user32.dll")] public static extern bool IsIconic(nint h);
    [DllImport("user32.dll")] public static extern bool IsWindow(nint h);
    [DllImport("user32.dll")] public static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(nint h);
    [DllImport("user32.dll")] public static extern nint SetFocus(nint h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(nint h, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] public static extern uint GetCurrentProcessId();
    [DllImport("user32.dll", EntryPoint = "PostMessageW")] public static extern bool PostMessage(nint h, uint msg, nint w, nint l);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] public static extern nint SendMessageTimeout(nint h, uint msg, nint w, nint l, uint flags, uint timeout, out nint result);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(nint h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(nint h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(nint h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(nint h, ref POINT p);
    [DllImport("user32.dll")] public static extern nint ChildWindowFromPointEx(nint parent, POINT p, uint flags);
    [DllImport("user32.dll")] public static extern nint WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern bool PrintWindow(nint h, nint hdc, uint flags);
    [DllImport("user32.dll")] public static extern nint GetDC(nint h);
    [DllImport("user32.dll")] public static extern int ReleaseDC(nint h, nint dc);
    [DllImport("gdi32.dll")] public static extern nint CreateCompatibleDC(nint dc);
    [DllImport("gdi32.dll")] public static extern nint CreateDIBSection(nint dc, ref BITMAPINFOHEADER bmi, uint usage, out byte* bits, nint section, uint offset);
    [DllImport("gdi32.dll")] public static extern nint SelectObject(nint dc, nint obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(nint obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(nint dc);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(nint h, int attr, out RECT value, int size);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(nint h, int attr, out int value, int size);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern nint GetWindowLongPtr(nint h, int index);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(nint h, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] public static extern nint GetAncestor(nint h, uint flags);
    [DllImport("user32.dll")] public static extern nint GetWindow(nint h, uint cmd);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("user32.dll")] public static extern bool GetKeyboardState(byte* state);
    [DllImport("user32.dll")] public static extern bool SetKeyboardState(byte* state);
    [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint type);
    [DllImport("user32.dll")] public static extern short VkKeyScanW(char ch);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern nint OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(nint desktop);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfoW(uint action, uint param, out RECT value, uint winIni);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("kernel32.dll")] public static extern nint OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(nint h);
    [DllImport("kernel32.dll")] public static extern bool GetProcessTimes(nint h, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(nint h, uint flags, char* name, ref uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetApplicationUserModelId(nint process, ref uint length, char* id);
    [DllImport("kernel32.dll")] public static extern nint GetStdHandle(int which);
    [DllImport("kernel32.dll")] public static extern bool PeekNamedPipe(nint pipe, byte* buffer, uint size, uint* read, uint* available, uint* left);
    [DllImport("kernel32.dll")] public static extern bool TerminateProcess(nint process, uint code);
    [DllImport("kernel32.dll")] public static extern nint GetCurrentProcess();
    [DllImport("kernel32.dll")] public static extern uint GetProcessId(nint process);
    [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(nint h, uint ms);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "ShellExecuteExW")] public static extern bool ShellExecuteEx(ref SHELLEXECUTEINFO info);

    // Clipboard
    [DllImport("user32.dll")] public static extern bool OpenClipboard(nint owner);
    [DllImport("user32.dll")] public static extern bool CloseClipboard();
    [DllImport("user32.dll")] public static extern bool EmptyClipboard();
    [DllImport("user32.dll")] public static extern nint SetClipboardData(uint format, nint mem);
    [DllImport("user32.dll")] public static extern nint GetClipboardData(uint format);
    [DllImport("user32.dll")] public static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "RegisterClipboardFormatW")] public static extern uint RegisterClipboardFormat(string name);
    [DllImport("kernel32.dll")] public static extern nint GlobalAlloc(uint flags, nuint bytes);
    [DllImport("kernel32.dll")] public static extern nint GlobalFree(nint mem);
    [DllImport("kernel32.dll")] public static extern void* GlobalLock(nint mem);
    [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(nint mem);
    [DllImport("kernel32.dll")] public static extern nuint GlobalSize(nint mem);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateWindowExW")]
    public static extern nint CreateWindowEx(uint exStyle, string cls, string? title, uint style, int x, int y, int w, int h, nint parent, nint menu, nint instance, nint param);
    [DllImport("user32.dll")] public static extern bool DestroyWindow(nint h);

    public static string WindowText(nint h)
    {
        var length = Math.Clamp(GetWindowTextLengthW(h), 0, 4096);
        if (length == 0) return "";
        var buffer = stackalloc char[length + 1];
        var n = GetWindowTextW(h, buffer, length + 1);
        return n <= 0 ? "" : new string(buffer, 0, n);
    }

    public static string ClassName(nint h)
    {
        var buffer = stackalloc char[256];
        var n = GetClassNameW(h, buffer, 256);
        return n <= 0 ? "" : new string(buffer, 0, n);
    }

    public static (int Pid, uint Thread) Owner(nint h)
    {
        var thread = GetWindowThreadProcessId(h, out var pid);
        return ((int)pid, thread);
    }

    public static nint Make(int x, int y) => (nint)(((y & 0xFFFF) << 16) | (x & 0xFFFF));
    public static nint HwndOf(uint id) => (nint)(int)id;
    public static uint IdOf(nint hwnd) => unchecked((uint)(long)hwnd);

    public static List<nint> TopLevelWindows()
    {
        var list = new List<nint>();
        EnumWindows((h, _) => { list.Add(h); return true; }, 0);
        return list;
    }

    public static List<nint> Descendants(nint parent)
    {
        var list = new List<nint>();
        EnumChildWindows(parent, (h, _) => { list.Add(h); return true; }, 0);
        return list;
    }

    public static string? ProcessImagePath(nint process)
    {
        var buffer = stackalloc char[1024];
        uint size = 1024;
        return QueryFullProcessImageNameW(process, 0, buffer, ref size) ? new string(buffer, 0, (int)size) : null;
    }

    public static string? AppUserModelId(nint process)
    {
        uint length = 256;
        var buffer = stackalloc char[256];
        return GetApplicationUserModelId(process, ref length, buffer) == 0 && length > 1 ? new string(buffer, 0, (int)length - 1) : null;
    }

    public static double FileTimeToEpochSeconds(long fileTime) => (fileTime - 116444736000000000L) / 1e7;

    public static RECT Rect(nint h) { GetWindowRect(h, out var r); return r; }
}
