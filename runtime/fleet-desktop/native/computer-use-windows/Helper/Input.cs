using System.Diagnostics;
using static FleetComputerUse.Helper.Native;

namespace FleetComputerUse.Helper;

/// <summary>A key or chord as accepted by the wire (`cmd`/`command` mean Ctrl on Windows; `win`/`meta` are rejected).</summary>
internal sealed class KeyStroke
{
    public ushort Vk { get; }
    public bool Ctrl { get; }
    public bool Alt { get; }
    public bool Shift { get; }
    public bool Extended { get; }
    public bool HasModifiers => Ctrl || Alt || Shift;

    private static readonly Dictionary<string, (ushort Vk, bool Extended)> Named = new()
    {
        ["return"] = (0x0D, false), ["enter"] = (0x0D, false), ["tab"] = (0x09, false), ["escape"] = (0x1B, false), ["esc"] = (0x1B, false),
        ["backspace"] = (0x08, false), ["delete"] = (0x2E, true), ["forwarddelete"] = (0x2E, true),
        ["up"] = (0x26, true), ["down"] = (0x28, true), ["left"] = (0x25, true), ["right"] = (0x27, true),
        ["arrowup"] = (0x26, true), ["arrowdown"] = (0x28, true), ["arrowleft"] = (0x25, true), ["arrowright"] = (0x27, true),
        ["home"] = (0x24, true), ["end"] = (0x23, true), ["pageup"] = (0x21, true), ["pagedown"] = (0x22, true), ["space"] = (0x20, false),
        ["f1"] = (0x70, false), ["f2"] = (0x71, false), ["f3"] = (0x72, false), ["f4"] = (0x73, false), ["f5"] = (0x74, false), ["f6"] = (0x75, false),
        ["f7"] = (0x76, false), ["f8"] = (0x77, false), ["f9"] = (0x78, false), ["f10"] = (0x79, false), ["f11"] = (0x7A, false), ["f12"] = (0x7B, false),
    };

    private static readonly Dictionary<char, ushort> Punctuation = new()
    {
        ['-'] = 0xBD, ['='] = 0xBB, ['['] = 0xDB, [']'] = 0xDD, ['\\'] = 0xDC, [';'] = 0xBA, ['\''] = 0xDE, [','] = 0xBC, ['.'] = 0xBE, ['/'] = 0xBF, ['`'] = 0xC0,
    };

    public KeyStroke(string spec)
    {
        var parts = spec.ToLowerInvariant().Split('+').Select(p => p.Trim()).ToArray();
        var key = parts[^1];
        if (key.Length == 0) throw new HelperError("invalid_key");
        bool ctrl = false, alt = false, shift = false;
        foreach (var modifier in parts[..^1])
        {
            switch (modifier)
            {
                case "cmd" or "command" or "ctrl" or "control":
                    if (ctrl) throw new HelperError("invalid_key");
                    ctrl = true; break;
                case "alt" or "option":
                    if (alt) throw new HelperError("invalid_key");
                    alt = true; break;
                case "shift":
                    if (shift) throw new HelperError("invalid_key");
                    shift = true; break;
                default: throw new HelperError("invalid_key"); // includes win / meta / super: no Windows-key chords in the background
            }
        }
        Ctrl = ctrl; Alt = alt; Shift = shift;
        if (Named.TryGetValue(key, out var named)) { Vk = named.Vk; Extended = named.Extended; }
        else if (key.Length == 1)
        {
            if (!HasModifiers) throw new HelperError("text_via_key");
            var c = key[0];
            if (c is >= 'a' and <= 'z') Vk = (ushort)char.ToUpperInvariant(c);
            else if (c is >= '0' and <= '9') Vk = c;
            else if (Punctuation.TryGetValue(c, out var vk)) Vk = vk;
            else throw new HelperError("invalid_key");
        }
        else throw new HelperError("invalid_key");
    }

    public bool Paste => Vk == 'V' && Ctrl && !Alt && !Shift;
    public bool SelectAll => Vk == 'A' && Ctrl && !Alt && !Shift;
}

internal enum ClickKind { Click, DoubleClick, RightClick }

/// <summary>
/// Window-message input. Everything here is PostMessage to the target's own window; nothing reaches the global input stream,
/// the physical pointer or the foreground window.
/// </summary>
internal static class MessageInput
{
    private static readonly string[] UnreachablePrefixes =
    [
        "Microsoft.UI.", "Windows.UI.", "ApplicationFrame", "InputSite", "HwndWrapper[", "DesktopWindowXamlSource",
    ];

    /// <summary>Whether a deepest-child window class can take posted mouse/wheel messages (contract §1 allow/deny lists).</summary>
    public static bool MessageSurface(string windowClass)
    {
        foreach (var prefix in UnreachablePrefixes)
            if (windowClass.StartsWith(prefix, StringComparison.Ordinal)) return false;
        return windowClass.Length > 0;
    }

    /// <summary>Deepest visible/enabled child of `top` containing the screen point, ignoring other top-level windows' z-order.</summary>
    public static nint DeepestChild(nint top, int sx, int sy)
    {
        var current = top;
        for (var i = 0; i < 32; i++)
        {
            var p = new POINT { X = sx, Y = sy };
            ScreenToClient(current, ref p);
            var child = ChildWindowFromPointEx(current, p, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT);
            if (child == 0 || child == current) return current;
            current = child;
        }
        return current;
    }

    /// <summary>Chromium/Electron take input on the top-level `Chrome_WidgetWin_*`; the legacy child ignores wheel and is not the click target.</summary>
    public static nint PointerTarget(WindowInfo win, int sx, int sy) => win.IsChromium ? win.Hwnd : DeepestChild(win.Hwnd, sx, sy);

    private static void Post(nint hwnd, uint message, nint w, nint l)
    {
        if (!PostMessage(hwnd, message, w, l)) throw new HelperError("background_unavailable", "post_message_failed");
    }

    private static nint ClientPoint(nint hwnd, int sx, int sy)
    {
        var p = new POINT { X = sx, Y = sy };
        ScreenToClient(hwnd, ref p);
        return Make(p.X, p.Y);
    }

    public static void Click(nint target, int sx, int sy, ClickKind kind, CancellationToken ct)
    {
        var l = ClientPoint(target, sx, sy);
        Post(target, WM_MOUSEMOVE, 0, l);
        if (kind == ClickKind.RightClick)
        {
            Post(target, WM_RBUTTONDOWN, (nint)MK_RBUTTON, l);
            Clock.Pause(40, ct);
            Post(target, WM_RBUTTONUP, 0, l);
            return;
        }
        Post(target, WM_LBUTTONDOWN, (nint)MK_LBUTTON, l);
        Clock.Pause(40, ct);
        Post(target, WM_LBUTTONUP, 0, l);
        if (kind != ClickKind.DoubleClick) return;
        Clock.Pause(30, ct);
        Post(target, WM_LBUTTONDBLCLK, (nint)MK_LBUTTON, l);
        Clock.Pause(30, ct);
        Post(target, WM_LBUTTONUP, 0, l);
    }

    public static void Wheel(nint target, int sx, int sy, int notches, bool horizontal, CancellationToken ct)
    {
        // Wheel messages carry screen coordinates. Positive delta = up/right.
        var message = horizontal ? WM_MOUSEHWHEEL : WM_MOUSEWHEEL;
        var l = Make(sx, sy);
        var local = ClientPoint(target, sx, sy);
        Post(target, WM_MOUSEMOVE, 0, local);
        var sign = Math.Sign(notches);
        for (var i = 0; i < Math.Abs(notches); i++)
        {
            Post(target, message, (nint)((sign * 120) << 16), l);
            if (i % 4 == 3) Clock.Pause(10, ct);
        }
    }

    public static void Drag(nint target, int sx, int sy, int ex, int ey, CancellationToken ct)
    {
        var start = ClientPoint(target, sx, sy);
        Post(target, WM_MOUSEMOVE, 0, start);
        Post(target, WM_LBUTTONDOWN, (nint)MK_LBUTTON, start);
        Clock.Pause(40, ct);
        const int steps = 8;
        for (var i = 1; i <= steps; i++)
        {
            var x = sx + (ex - sx) * i / steps;
            var y = sy + (ey - sy) * i / steps;
            Post(target, WM_MOUSEMOVE, (nint)MK_LBUTTON, ClientPoint(target, x, y));
            Clock.Pause(16, ct);
        }
        Post(target, WM_LBUTTONUP, 0, ClientPoint(target, ex, ey));
    }

    /// <summary>The window that currently has keyboard focus inside the target (its own thread's focus, not the user's).</summary>
    public static nint FocusWindow(WindowInfo win)
    {
        if (win.IsChromium) return win.Hwnd;
        var candidates = new List<nint> { win.Hwnd };
        if (win.Class == "ApplicationFrameWindow")
            candidates.InsertRange(0, Descendants(win.Hwnd).Where(h => ClassName(h) == "Windows.UI.Core.CoreWindow"));
        foreach (var candidate in candidates)
        {
            var (_, thread) = Owner(candidate);
            var info = new GUITHREADINFO { cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<GUITHREADINFO>() };
            if (!GetGUIThreadInfo(thread, ref info)) continue;
            if (info.hwndFocus != 0 && IsWindow(info.hwndFocus) && (GetAncestor(info.hwndFocus, GA_ROOT) == win.Hwnd || Owner(info.hwndFocus).Pid == Owner(candidate).Pid))
            {
                // Focus inside bridged XAML content cannot take WM_CHAR; hand it the enclosing real window.
                return MessageSurface(ClassName(info.hwndFocus)) ? info.hwndFocus : candidate;
            }
            if (candidate != win.Hwnd) return candidate;
        }
        return win.Hwnd;
    }

    /// <summary>Whether the window class is an edit-like Win32 control (used when UIA does not report keyboard focus).</summary>
    public static bool EditLikeClass(string windowClass) =>
        windowClass == "Edit" || windowClass.StartsWith("RichEdit", StringComparison.Ordinal) || windowClass.StartsWith("Scintilla", StringComparison.Ordinal) ||
        windowClass.Contains("TextBox", StringComparison.OrdinalIgnoreCase) || windowClass.Contains("Edit", StringComparison.Ordinal);

    public static void Chars(nint target, string text, CancellationToken ct)
    {
        // The posted-message queue holds 10,000 entries per thread; send in small batches and give the target time to drain.
        var sent = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') continue;
            if (c == '\n') c = '\r';
            var attempts = 0;
            while (!PostMessage(target, WM_CHAR, c, 1))
            {
                if (++attempts > 50 || !IsWindow(target)) throw new HelperError(sent == 0 ? "background_unavailable" : "timeout", "post_char_failed");
                Clock.Pause(10, ct);
            }
            sent++;
            if (sent % 256 == 0) Clock.Pause(12, ct);
        }
    }

    /// <summary>Posts a key chord. Returns the `via` label: `message` or `message+keystate` (modifiers set on the target thread).</summary>
    public static unsafe string Key(nint target, KeyStroke key, CancellationToken ct)
    {
        var scan = MapVirtualKeyW(key.Vk, 0);
        var down = (nint)(1 | (scan << 16) | (key.Extended ? 1u << 24 : 0) | (key.Alt ? 1u << 29 : 0));
        var up = (nint)unchecked((long)((uint)down | 0xC0000000u));
        var message = key.Alt ? WM_SYSKEYDOWN : WM_KEYDOWN;
        var messageUp = key.Alt ? WM_SYSKEYUP : WM_KEYUP;
        if (!key.HasModifiers)
        {
            Post(target, message, key.Vk, down);
            Post(target, messageUp, key.Vk, up);
            return "message";
        }
        var (_, thread) = Owner(target);
        var me = GetCurrentThreadId();
        var attached = thread != me && AttachThreadInput(me, thread, true);
        var original = stackalloc byte[256];
        var changed = false;
        try
        {
            if (!attached) throw new HelperError("background_unavailable", "modifier_state_unavailable");
            GetKeyboardState(original);
            var state = stackalloc byte[256];
            for (var i = 0; i < 256; i++) state[i] = original[i];
            if (key.Ctrl) { state[0x11] = 0x80; state[0xA2] = 0x80; }
            if (key.Shift) { state[0x10] = 0x80; state[0xA0] = 0x80; }
            if (key.Alt) { state[0x12] = 0x80; state[0xA4] = 0x80; }
            SetKeyboardState(state);
            changed = true;
            Post(target, message, key.Vk, down);
            Post(target, messageUp, key.Vk, up);
            // The target reads modifier state while handling the posted key; keep it until it has had time to.
            Clock.Pause(120, ct);
        }
        finally
        {
            if (changed) SetKeyboardState(original);
            if (attached) AttachThreadInput(me, thread, false);
        }
        return "message+keystate";
    }
}

/// <summary>
/// Out-of-context EVENT_SYSTEM_FOREGROUND listener. It timestamps every foreground change so the B route can report how long the
/// target really held the foreground (first change event to confirmed restore), not how long the whole call took.
/// </summary>
internal static class ForegroundEvents
{
    private delegate void WinEventProc(nint hook, uint ev, nint hwnd, int obj, int child, uint thread, uint time);
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern nint SetWinEventHook(uint min, uint max, nint module, WinEventProc proc, uint pid, uint thread, uint flags);

    private static readonly object Gate = new();
    private static readonly List<(long Tick, nint Hwnd)> Events = new();
    private static WinEventProc? keep;
    private static bool started;
    private static volatile EarlyRestore? early;
    public static EarlyRestore? Early { get => early; set => early = value; }

    public static void EnsureStarted()
    {
        lock (Gate)
        {
            if (started) return;
            started = true;
        }
        var ready = new ManualResetEventSlim();
        var thread = new Thread(() =>
        {
            keep = (_, _, hwnd, _, _, _, _) =>
            {
                var tick = Stopwatch.GetTimestamp();
                lock (Gate)
                {
                    Events.Add((tick, hwnd));
                    if (Events.Count > 256) Events.RemoveRange(0, 128);
                }
                Early?.OnForegroundChanged(hwnd, tick);
            };
            SetWinEventHook(3, 3, 0, keep, 0, 0, 0);
            ready.Set();
            while (ProbeNative.GetMessage(out var msg, 0, 0, 0) > 0)
            {
                ProbeNative.TranslateMessage(ref msg);
                ProbeNative.DispatchMessage(ref msg);
            }
        }) { IsBackground = true, Name = "Fleet foreground events" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        ready.Wait(1_000);
    }

    /// <summary>First foreground change at or after `since` that satisfies the predicate, as a Stopwatch tick.</summary>
    public static long? FirstSince(long since, Func<nint, bool> match)
    {
        lock (Gate)
        {
            foreach (var (tick, hwnd) in Events)
                if (tick >= since && match(hwnd)) return tick;
        }
        return null;
    }

    public static double Milliseconds(long from, long to) => (to - from) * 1000.0 / Stopwatch.Frequency;
}

/// <summary>
/// Hands the foreground back from the event thread the instant the target takes it, while the (possibly slow) UIA call is still
/// blocking the request thread. One shot: it never asks twice and never injects input.
/// </summary>
internal sealed class EarlyRestore
{
    private readonly Func<nint, bool> isTarget;
    private readonly nint userForeground;
    private readonly nint userRoot;
    private int fired;
    public long TakenTick { get; private set; }
    public long RestoredTick { get; private set; }
    public bool Attempted => fired == 1;

    public EarlyRestore(Func<nint, bool> isTarget, nint userForeground, nint userRoot)
    {
        this.isTarget = isTarget; this.userForeground = userForeground; this.userRoot = userRoot;
    }

    public void OnForegroundChanged(nint hwnd, long tick)
    {
        if (!isTarget(hwnd) || Interlocked.Exchange(ref fired, 1) == 1) return;
        TakenTick = tick;
        if (!IsWindow(userForeground)) return;
        var me = GetCurrentThreadId();
        var thread = Owner(hwnd).Thread;
        var attached = thread != 0 && thread != me && AttachThreadInput(me, thread, true);
        try { SetForegroundWindow(userForeground); }
        finally { if (attached) AttachThreadInput(me, thread, false); }
        var after = GetForegroundWindow();
        if (after == userForeground || (after != 0 && GetAncestor(after, GA_ROOT) == userRoot)) RestoredTick = Stopwatch.GetTimestamp();
    }
}

internal static class ForegroundGuard
{
    private static bool OwnedByTarget(nint hwnd, WindowInfo win)
    {
        if (hwnd == 0) return false;
        var pid = Owner(hwnd).Pid;
        return pid == win.Key.Pid || pid == win.InnerPid;
    }

    /// <summary>
    /// UIA actions can raise the provider window (measured on Notepad, Calculator and Edge). This runs the pattern call and, the moment
    /// it returns (before any observation), hands the foreground back to the window the person was using. The restore always runs
    /// (also when the call throws), is judged by GetForegroundWindow() afterwards, and never retries or injects input.
    /// The reported milliseconds are the time the target held the foreground: first foreground-change event to confirmed restore.
    /// </summary>
    public static void Run(WindowInfo win, List<string> notes, CancellationToken ct, Action action)
    {
        var userForeground = GetForegroundWindow();
        var userRoot = userForeground == 0 ? 0 : GetAncestor(userForeground, GA_ROOT);
        if (userForeground == 0)
        {
            action();
            notes.Add("foreground_restore_skipped:no_foreground");
            return;
        }
        if (userRoot == win.Hwnd || OwnedByTarget(userForeground, win))
        {
            action();
            notes.Add("foreground_restore_skipped:target_is_foreground");
            return;
        }
        ForegroundEvents.EnsureStarted();
        var early = new EarlyRestore(h => OwnedByTarget(h, win), userForeground, userRoot);
        var since = Stopwatch.GetTimestamp();
        ForegroundEvents.Early = early;
        try { action(); }
        finally
        {
            var returned = Stopwatch.GetTimestamp();
            ForegroundEvents.Early = null;
            Restore(win, userForeground, userRoot, since, returned, early, notes);
        }
    }

    private static void Restore(WindowInfo win, nint userForeground, nint userRoot, long since, long returned, EarlyRestore early, List<string> notes)
    {
        // Normal case: the event thread already returned the foreground while the call was still in flight.
        if (early.Attempted && early.RestoredTick != 0)
        {
            var now = GetForegroundWindow();
            if (now != 0 && GetAncestor(now, GA_ROOT) == userRoot && !OwnedByTarget(now, win))
            {
                // Give a late re-activation one chance to show up before declaring the foreground settled.
                var late = Stopwatch.StartNew();
                while (late.ElapsedMilliseconds < 40 && GetAncestor(GetForegroundWindow(), GA_ROOT) == userRoot) Thread.Yield();
                if (GetAncestor(GetForegroundWindow(), GA_ROOT) == userRoot)
                {
                    var heldEarly = Math.Max(1, (int)Math.Ceiling(ForegroundEvents.Milliseconds(early.TakenTick, early.RestoredTick)));
                    UiaSession.Trace($"fg timing: early restore held={ForegroundEvents.Milliseconds(early.TakenTick, early.RestoredTick):F1}ms call={ForegroundEvents.Milliseconds(since, returned):F1}ms");
                    notes.Add($"foreground_borrowed:{heldEarly}ms restored");
                    return;
                }
            }
        }
        // The activation usually lands inside the call; give a late one a short window, spinning rather than sleeping.
        long? taken = ForegroundEvents.FirstSince(since, h => OwnedByTarget(h, win));
        var wait = Stopwatch.StartNew();
        while (taken == null && wait.ElapsedMilliseconds < 220)
        {
            if (OwnedByTarget(GetForegroundWindow(), win)) { taken = Stopwatch.GetTimestamp(); break; }
            Thread.Yield();
            taken = ForegroundEvents.FirstSince(since, h => OwnedByTarget(h, win));
        }
        if (taken == null)
        {
            notes.Add("foreground_unchanged");
            return;
        }
        var restored = false;
        if (IsWindow(userForeground))
        {
            var now = GetForegroundWindow();
            if (now != 0 && GetAncestor(now, GA_ROOT) == userRoot) restored = true;
            else
            {
                var me = GetCurrentThreadId();
                var foregroundThread = now == 0 ? 0u : Owner(now).Thread;
                var attached = foregroundThread != 0 && foregroundThread != me && AttachThreadInput(me, foregroundThread, true);
                try { SetForegroundWindow(userForeground); }
                finally { if (attached) AttachThreadInput(me, foregroundThread, false); }
                // The switch can complete a few milliseconds after the call returns; wait for it, but never ask twice.
                var confirm = Stopwatch.StartNew();
                while (!restored && confirm.ElapsedMilliseconds < 250)
                {
                    var after = GetForegroundWindow();
                    restored = after == userForeground || (after != 0 && GetAncestor(after, GA_ROOT) == userRoot);
                    if (!restored) Thread.Yield();
                }
            }
        }
        var end = Stopwatch.GetTimestamp();
        UiaSession.Trace($"fg timing: call={ForegroundEvents.Milliseconds(since, returned):F1}ms activation@{ForegroundEvents.Milliseconds(since, taken.Value):F1}ms restoreFromReturn={ForegroundEvents.Milliseconds(returned, end):F1}ms heldAfterReturn={ForegroundEvents.Milliseconds(Math.Max(taken.Value, returned), end):F1}ms");
        var held = Math.Max(1, (int)Math.Ceiling(ForegroundEvents.Milliseconds(taken.Value, Stopwatch.GetTimestamp())));
        notes.Add($"foreground_borrowed:{held}ms {(restored ? "restored" : "not_restored")}");
    }
}
