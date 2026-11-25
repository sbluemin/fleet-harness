using System.Diagnostics;
using static FleetComputerUse.Cursor.Win32;

namespace FleetComputerUse.Cursor;

public enum CursorFeedback { Click, DoubleClick, RightClick, ScrollUp, ScrollDown, ScrollLeft, ScrollRight, TypingOn, TypingOff, DragBegin, DragEnd }

public interface IAICursor : IDisposable
{
    /// <summary>Tracks a target window; zero clears tracking and hides the cursor.</summary>
    void Track(IntPtr targetHwnd);
    /// <summary>Moves the visual cursor in physical screen pixels. Completes at landing (or when there is no drawable target); a newer move cancels the prior one.</summary>
    Task MoveToAsync(int screenX, int screenY, CancellationToken ct = default);
    void Feedback(CursorFeedback kind);
    void Hide(bool animated = true);
}

public static class AICursor
{
    public static IAICursor Create() => new CursorOverlay();
}

internal sealed class CursorOverlay : IAICursor
{
    internal const string WindowClassPrefix = "FleetComputerUse.AICursor.";
    private const nuint FrameTimer = 1, ReorderTimer = 2;
    private const int AnimatedFrameMs = 15; // Fits a 15.625 ms system timer period without raising global timer resolution.
    private static double Now => (double)Stopwatch.GetTimestamp() / Stopwatch.Frequency;
    private readonly Thread uiThread;
    private readonly string className = WindowClassPrefix + Guid.NewGuid().ToString("N");
    private readonly WndProc wndProc;
    private readonly EventProc destroyProc;
    private readonly TaskCompletionSource ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object gate = new();
    private List<Command> commands = [];
    private bool closing, stopped;
    private Exception? fault;
    private nint window, dpiProbe, target, destroyHook, monitor;
    private uint targetThread, targetProcess, dpi;
    private LayerSurface? surface;
    private CursorArt? art;
    private bool reduceMotion, visible, fading, quitting;
    private int frameInterval;
    private double shownAt, lastActivity, fadeAt, x, y, lastFrame, settleAt, settleAmp, settleAxis, vx, vy, lagX, lagY;
    private Move? move;

    private readonly record struct Command(Action Run, TaskCompletionSource? Completion);
    private sealed record Move(double FromX, double FromY, int ToX, int ToY, double Start, double Duration,
        TaskCompletionSource Completion, CancellationToken Cancellation);

    internal CursorOverlay()
    {
        wndProc = WindowMessage;
        destroyProc = WindowDestroyed;
        uiThread = new Thread(ThreadMain) { IsBackground = true, Name = "Fleet AI cursor" };
        uiThread.SetApartmentState(ApartmentState.STA);
        uiThread.Start();
        try { ready.Task.GetAwaiter().GetResult(); }
        catch { uiThread.Join(); throw; }
    }

    public void Track(IntPtr targetHwnd) => Enqueue(() => SetTarget(targetHwnd));
    public void Feedback(CursorFeedback kind) => Enqueue(() =>
    {
        if (!visible || fading) return;
        double now = Now;
        art!.Feedback(kind, now);
        lastActivity = now;
        Frame(now);
    });
    public void Hide(bool animated = true) => Enqueue(() => BeginHide(animated, Now));

    public Task MoveToAsync(int screenX, int screenY, CancellationToken ct = default)
    {
        if (ct.IsCancellationRequested) return Task.FromCanceled(ct);
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        try { Enqueue(() => StartMove(screenX, screenY, ct, completion), completion); }
        catch (Exception ex) { completion.TrySetException(ex); }
        return completion.Task;
    }

    private void Enqueue(Action action, TaskCompletionSource? completion = null)
    {
        lock (gate)
        {
            if (fault is not null) throw new InvalidOperationException("The cursor UI thread stopped.", fault);
            ObjectDisposedException.ThrowIf(closing || stopped, this);
            PostCommand(action, completion);
        }
    }

    // gate is held by the caller; at most one wake-up is outstanding.
    private void PostCommand(Action action, TaskCompletionSource? completion)
    {
        if (commands.Count == 0 && !PostMessage(window, WmCommands, 0, 0)) throw Error(nameof(PostMessage));
        commands.Add(new(action, completion));
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (!closing && !stopped)
            {
                PostCommand(StopLoop, null);
                closing = true;
            }
        }
        if (Thread.CurrentThread != uiThread) uiThread.Join();
    }

    private void ThreadMain()
    {
        nint oldDpi = 0;
        nuint gdiplus = 0;
        nint module = GetModuleHandle(null);
        bool registered = false;
        try
        {
            oldDpi = SetThreadDpiAwarenessContext(-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
            if (oldDpi == 0) throw Error(nameof(SetThreadDpiAwarenessContext));
            var startup = new GdiPlus.Startup { Version = 1, NoExternalCodecs = 1 };
            GdiPlus.Check(GdiPlus.GdiplusStartup(out gdiplus, startup, 0));
            art = new CursorArt();
            var wc = new WindowClass { ClassName = className, Instance = module, Procedure = wndProc };
            registered = RegisterClass(wc) != 0;
            if (!registered) throw Error(nameof(RegisterClass));
            // Keep the cursor visible in desktop captures and screen sharing;
            // the helper's window-only capture does not include this separate HWND.
            window = NewWindow(Layered | Transparent | NoActivate | ToolWindow, module);
            dpiProbe = NewWindow(NoActivate | ToolWindow, module);
            ReadMotionPreference();
            ready.TrySetResult();
            int result;
            while ((result = GetMessage(out var message, 0, 0, 0)) > 0) DispatchMessage(message);
            if (result < 0) throw Error(nameof(GetMessage));
        }
        catch (Exception ex) { SetFault(ex); ready.TrySetException(ex); }
        finally
        {
            lock (gate)
            {
                stopped = true;
                foreach (var cmd in commands) Fail(cmd.Completion);
                commands.Clear();
            }
            if (move is { } pending) Fail(pending.Completion);
            if (destroyHook != 0) UnhookWinEvent(destroyHook);
            if (dpiProbe != 0) DestroyWindow(dpiProbe);
            if (window != 0) DestroyWindow(window);
            if (registered) UnregisterClass(className, module);
            surface?.Dispose();
            art?.Dispose();
            if (gdiplus != 0) GdiPlus.GdiplusShutdown(gdiplus);
            if (oldDpi != 0) SetThreadDpiAwarenessContext(oldDpi);
        }
    }

    private nint NewWindow(uint style, nint module)
    {
        nint hwnd = CreateWindowEx(style, className, null, Popup, 0, 0, 1, 1, 0, 0, module, 0);
        return hwnd != 0 ? hwnd : throw Error(nameof(CreateWindowEx));
    }

    private nint WindowMessage(nint hwnd, uint message, nuint wParam, nint lParam)
    {
        if (message == WmMouseActivate) return 3; // MA_NOACTIVATE
        if (message == WmNcHitTest) return -1; // HTTRANSPARENT (layered WS_EX_TRANSPARENT also passes through cross-process)
        if (message == 0x02e0 && (hwnd == window || hwnd == dpiProbe)) // WM_DPICHANGED
            monitor = 0; // Do not apply the suggested rect; the hotspot defines our position.
        if (hwnd != window || quitting) return DefWindowProc(hwnd, message, wParam, lParam);
        try
        {
            switch (message)
            {
                case WmCommands:
                    DrainCommands();
                    return 0;
                case WmTimer when wParam == FrameTimer:
                    Frame(Now);
                    return 0;
                case WmTimer when wParam == ReorderTimer:
                    if (visible && (!TargetDrawable() || !OrderAboveTarget(false))) HideNow();
                    return 0;
                case 0x007e: // WM_DISPLAYCHANGE; recompute scale on the next frame.
                    monitor = 0;
                    break;
                case 0x001a: // WM_SETTINGCHANGE
                    ReadMotionPreference();
                    if (visible) Frame(Now);
                    break;
            }
        }
        catch (Exception ex) { SetFault(ex); StopLoop(); }
        return DefWindowProc(hwnd, message, wParam, lParam);
    }

    private void DrainCommands()
    {
        List<Command> batch;
        lock (gate) { batch = commands; commands = []; }
        foreach (var cmd in batch)
        {
            if (quitting) { Fail(cmd.Completion); continue; }
            try { cmd.Run(); }
            catch (Exception ex) { SetFault(ex); Fail(cmd.Completion); StopLoop(); }
        }
    }

    private void SetFault(Exception ex) { lock (gate) { fault ??= ex; } }
    private void StopLoop() { quitting = true; PostQuitMessage(0); }
    private void Fail(TaskCompletionSource? completion)
    {
        if (fault is { } ex) completion?.TrySetException(ex);
        else completion?.TrySetCanceled();
    }

    private void ReadMotionPreference() => reduceMotion = SystemParametersInfo(0x1042, 0, out int enabled, 0) && enabled == 0;

    private void SetTarget(nint hwnd)
    {
        nint root = hwnd == 0 ? 0 : GetAncestor(hwnd, AncestorRoot);
        if (root == window || root == dpiProbe) root = 0;
        uint pid = 0;
        uint thread = root == 0 ? 0 : GetWindowThreadProcessId(root, out pid);
        if (thread == 0) root = 0;
        if (root != target || pid != targetProcess || thread != targetThread)
        {
            HideNow();
            if (destroyHook != 0) UnhookWinEvent(destroyHook);
            target = root;
            targetProcess = pid;
            targetThread = thread;
            destroyHook = thread == 0 ? 0 : SetWinEventHook(DestroyEvent, DestroyEvent, 0, destroyProc, pid, thread, 0);
        }
        if (visible && (!TargetDrawable() || !OrderAboveTarget(false))) HideNow();
    }

    private void WindowDestroyed(nint hook, uint kind, nint hwnd, int objectId, int childId, uint thread, uint time)
    {
        if (!quitting && hook == destroyHook && objectId == 0 && childId == 0 && hwnd == target)
        {
            try { SetTarget(0); }
            catch (Exception ex) { SetFault(ex); StopLoop(); }
        }
    }

    private bool TargetDrawable() => target != 0 && GetWindowThreadProcessId(target, out uint pid) == targetThread &&
        pid == targetProcess && IsWindowVisible(target) && !IsIconic(target) &&
        DwmGetWindowAttribute(target, 14, out uint cloaked, sizeof(uint)) == 0 && cloaked == 0 && // DWMWA_CLOAKED
        GetWindowRect(target, out var rect) && MonitorFromRect(rect, 0) != 0;

    private static bool IsTopmost(nint hwnd) => (GetWindowLongPtr(hwnd, ExtendedStyle) & Topmost) != 0;

    private bool OrderAboveTarget(bool show)
    {
        // SetWindowPos inserts *after* the supplied window. Use the target's predecessor
        // in the same band. Match a TOPMOST target's band only while tracking that target;
        // a normal target never has a globally floating cursor.
        bool topmost = IsTopmost(target);
        nint previous = GetWindow(target, Previous);
        if (previous == window && IsTopmost(window) == topmost)
            return !show || Position(window, 0, 0, 0, 0, 0, NoMove | NoSize | NoZOrder | Show);
        if (previous == window) previous = GetWindow(window, Previous);
        bool bandHead = previous == 0 || IsTopmost(previous) != topmost;
        if (bandHead) previous = topmost ? -1 : IsTopmost(window) ? -2 : 0;
        if (!Position(window, previous, 0, 0, 0, 0, NoMove | NoSize)) return false;
        // HWND_TOP can leave a normal HWND behind a just-demoted target. Perform
        // the same demotion on our hidden overlay to reach the normal band's head.
        if (bandHead && !topmost && GetWindow(target, Previous) != window && TargetDrawable() && !IsTopmost(target))
        {
            ShowWindow(window, 0); // Never show the cursor in the wrong band, even during a fade.
            show = true;
            if (!Position(window, -1, 0, 0, 0, 0, NoMove | NoSize)) return false;
            if (!Position(window, -2, 0, 0, 0, 0, NoMove | NoSize)) return false;
        }
        // A foreign HWND may have changed bands or order between the check and SetWindowPos.
        // Do not display an overlay misplaced by the compositor's separate system bands.
        if (!TargetDrawable() || IsTopmost(target) != IsTopmost(window) || GetWindow(target, Previous) != window) return false;
        return !show || Position(window, 0, 0, 0, 0, 0, NoMove | NoSize | NoZOrder | Show);
    }

    private void StartMove(int screenX, int screenY, CancellationToken ct, TaskCompletionSource completion)
    {
        if (ct.IsCancellationRequested) { completion.TrySetCanceled(ct); return; }
        if (move is { } prior) prior.Completion.TrySetCanceled(prior.Cancellation);
        move = null;
        if (!TargetDrawable() || MonitorFromPoint(new Point(screenX, screenY), 0) == 0)
        {
            HideNow();
            completion.TrySetResult();
            return;
        }
        double now = Now;
        lastActivity = now;
        settleAt = double.NegativeInfinity;
        if (!visible || fading)
        {
            x = screenX;
            y = screenY;
            vx = vy = lagX = lagY = 0;
            shownAt = lastFrame = now;
            fading = false;
            visible = true;
            // First show is already at the requested pixel. Keep the task pending for
            // the short appear transition, as the macOS helper does before input.
            move = new Move(x, y, screenX, screenY, now, .14, completion, ct);
            Render(now);
            if (!OrderAboveTarget(true)) { HideNow(); return; }
            if (SetTimer(window, ReorderTimer, 160, 0) == 0) throw Error(nameof(SetTimer));
            UpdateTimer(AnimatedFrameMs);
            return;
        }
        double dx = screenX - x, dy = screenY - y;
        double distance = Math.Sqrt(dx * dx + dy * dy);
        double duration = reduceMotion || distance < .5 ? 0 : Math.Min(.335, .180 + distance / 2650);
        move = new Move(x, y, screenX, screenY, now, duration, completion, ct);
        Frame(now);
    }

    private void Frame(double now)
    {
        if (!visible) return;
        if (!TargetDrawable()) { HideNow(); return; }
        if (fading && now - fadeAt >= .22) { HideNow(); return; }
        if (!fading && move is null && now - lastActivity >= 4) BeginHide(true, now);
        double dt = Math.Clamp(now - lastFrame, 1.0 / 240, .1);
        lastFrame = now;
        bool arrived = false;
        if (move is { } m)
        {
            if (m.Cancellation.IsCancellationRequested)
            {
                m.Completion.TrySetCanceled(m.Cancellation);
                move = null;
            }
            else
            {
                double t = m.Duration == 0 ? 1 : Math.Clamp((now - m.Start) / m.Duration, 0, 1);
                double u = CursorArt.Spring(t);
                double nx = CursorArt.Lerp(m.FromX, m.ToX, u), ny = CursorArt.Lerp(m.FromY, m.ToY, u);
                double scale = Math.Max(1, dpi) / 96.0;
                vx = .45 * vx + .55 * (nx - x) / (dt * scale);
                vy = .45 * vy + .55 * (ny - y) / (dt * scale);
                x = nx;
                y = ny;
                if (t >= 1)
                {
                    double dx = m.ToX - m.FromX, dy = m.ToY - m.FromY;
                    settleAt = now;
                    settleAmp = -.2 * Math.Min(1, Math.Sqrt(dx * dx + dy * dy) / (140 * scale));
                    settleAxis = Math.Atan2(dy, dx);
                    vx = vy = 0;
                    arrived = true;
                }
            }
        }
        if (move is null) vx = vy = 0;
        double follow = Math.Min(1, dt * 16);
        lagX = CursorArt.Lerp(lagX, reduceMotion ? 0 : Math.Clamp(-vx * .012, -9, 9), follow);
        lagY = CursorArt.Lerp(lagY, reduceMotion ? 0 : Math.Clamp(-vy * .012, -9, 9), follow);
        Render(now);
        if (arrived) FinishMove();
        bool active = move is not null || fading || now - shownAt < .4 || (!reduceMotion && now - settleAt < .4) || art!.IsAnimating(now, reduceMotion);
        UpdateTimer(active ? AnimatedFrameMs : reduceMotion ? 160 : 30);
    }

    private void Render(double now)
    {
        SyncScale(new Point((int)Math.Round(x), (int)Math.Round(y)));
        float scale = dpi / 96f;
        double offset = CursorArt.Tip * scale;
        int ox = (int)Math.Floor(x - offset), oy = (int)Math.Floor(y - offset);
        double fadeAge = fading ? now - fadeAt : -1;
        double settleAge = now - settleAt;
        double settle = settleAge < .4 ? settleAmp * Math.Exp(-settleAge / .085) * Math.Cos(2 * Math.PI * settleAge / .21) : 0;
        double opacity = fading ? 1 - CursorArt.Soft(fadeAge / .22) : Math.Clamp((now - shownAt) / .14, 0, 1);
        art!.Draw(surface!.Graphics, scale, (float)(x - ox), (float)(y - oy), now, now - shownAt, fadeAge, reduceMotion, vx, vy, settle, settleAxis, lagX, lagY);
        surface.Present(window, new Point(ox, oy), (byte)Math.Round(opacity * 255));
    }

    private void SyncScale(Point tip)
    {
        nint newMonitor = MonitorFromPoint(tip, 2); // nearest for the gaps between monitors
        // The overlay rectangle may straddle monitors; measure DPI at its hotspot,
        // not at the largest intersection of the 148x116 sprite with the desktop.
        if (monitor == newMonitor && surface is not null) return;
        if (!Position(dpiProbe, 0, tip.X, tip.Y, 1, 1, NoZOrder)) throw Error("Position cursor DPI probe");
        uint newDpi = GetDpiForWindow(dpiProbe);
        if (newDpi == 0) newDpi = 96;
        if (newDpi != dpi || surface is null)
        {
            var replacement = new LayerSurface((int)Math.Ceiling(CursorArt.Width * newDpi / 96d), (int)Math.Ceiling(CursorArt.Height * newDpi / 96d));
            surface?.Dispose();
            surface = replacement;
            dpi = newDpi;
        }
        monitor = newMonitor;
    }

    private void UpdateTimer(int interval)
    {
        if (interval == frameInterval) return;
        if (interval == 0) KillTimer(window, FrameTimer);
        else if (SetTimer(window, FrameTimer, (uint)interval, 0) == 0) throw Error(nameof(SetTimer));
        frameInterval = interval;
    }

    private void BeginHide(bool animated, double now)
    {
        if (!animated) { HideNow(); return; }
        if (!visible || fading) return;
        FinishMove();
        fading = true;
        fadeAt = now;
        art!.Reset();
        vx = vy = lagX = lagY = 0;
        UpdateTimer(AnimatedFrameMs);
    }

    private void HideNow()
    {
        FinishMove();
        if (!visible) return;
        visible = fading = false;
        ShowWindow(window, 0); // SW_HIDE
        if (IsTopmost(window) && !Position(window, -2, 0, 0, 0, 0, NoMove | NoSize))
            throw Error("Demote hidden cursor from topmost band");
        art!.Reset();
        KillTimer(window, ReorderTimer);
        UpdateTimer(0);
    }

    private void FinishMove()
    {
        if (move is not { } m) return;
        move = null;
        if (m.Cancellation.IsCancellationRequested) m.Completion.TrySetCanceled(m.Cancellation);
        else m.Completion.TrySetResult();
    }
}
