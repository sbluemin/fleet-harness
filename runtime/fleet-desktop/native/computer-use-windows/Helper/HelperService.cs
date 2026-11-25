using System.Globalization;
using System.Text.Json.Nodes;
using FleetComputerUse.Cursor;
using Windows.Win32.UI.Accessibility;
using static FleetComputerUse.Helper.Native;

namespace FleetComputerUse.Helper;

/// <summary>Windows has no TCC: accessibility is always available; capture depends on Windows.Graphics.Capture support.</summary>
internal static class HelperPermissions
{
    public static Obj Json() => new(("accessibility", true), ("screenRecording", WindowCapture.Supported));
}

/// <summary>Startup self-check retry policy; identical to the macOS helper (same transient reason names).</summary>
internal static class SelfCheckPolicy
{
    public const int Attempts = 3;
    public const int RetryDelayMs = 150;
    private static readonly HashSet<string> Transient = new(StringComparer.Ordinal)
    {
        "front_changed", "pointer_changed", "helper_activated", "probe_window_unavailable", "probe_click_not_received", "probe_failed",
    };

    public static bool Retryable(Obj check) =>
        !(check.GetValueOrDefault("ok") is true) && check.GetValueOrDefault("reason") is string reason && Transient.Contains(reason);
}

internal sealed partial class HelperService : IDisposable
{
    private enum Fault { None, SelfCheck, Symbols, Hang, HangAfterSend }

    internal readonly WindowCatalog Catalog = new();
    internal UiaSession? UiaOrNull;
    private IAICursor? cursor;
    private bool cursorFailed;
    private Obj check = new(("ok", false), ("reason", "not_ready"), ("ms", 0));
    private readonly Fault fault;
    private readonly HashSet<WindowKey> webProbed = new();

    public HelperService()
    {
        fault = Environment.GetEnvironmentVariable("FLEET_COMPUTER_USE_FAULT") switch
        {
            "self_check" => Fault.SelfCheck,
            "symbols" => Fault.Symbols,
            // Test-only: block the next request to exercise the 15 s watchdog (`hang`) or its "sent but unobserved" result (`hang_after_send`).
            "hang" => Fault.Hang,
            "hang_after_send" => Fault.HangAfterSend,
            _ => Fault.None,
        };
    }

    internal UiaSession Uia => UiaOrNull ??= new UiaSession();

    public Obj Initialize(CancellationToken ct)
    {
        if (fault == Fault.SelfCheck) check = new Obj(("ok", false), ("reason", "fault_injected_self_check"), ("ms", 0), ("retryable", false));
        else if (fault == Fault.Symbols) check = new Obj(("ok", false), ("reason", "window_location_unavailable"), ("ms", 0), ("retryable", false));
        else check = RunSelfCheck(ct);
        return check;
    }

    private Obj RunSelfCheck(CancellationToken ct)
    {
        var result = new Obj();
        for (var attempt = 1; attempt <= SelfCheckPolicy.Attempts; attempt++)
        {
            result = SelfCheck.Run(this, ct);
            result["attempts"] = attempt;
            if (!SelfCheckPolicy.Retryable(result) || attempt >= SelfCheckPolicy.Attempts) break;
            Clock.Pause(SelfCheckPolicy.RetryDelayMs, ct);
        }
        result["retryable"] = SelfCheckPolicy.Retryable(result);
        return result;
    }

    private Obj Recheck(CancellationToken ct)
    {
        if (fault == Fault.SelfCheck || check.GetValueOrDefault("ok") is true || !SelfCheckPolicy.Retryable(check)) return check;
        check = RunSelfCheck(ct);
        return check;
    }

    public Obj Handle(string method, JsonObject p, DispatchRecord record, CancellationToken ct)
    {
        switch (method)
        {
            case "hello":
            {
                Params.ValidateKeys(p, Params.Keys());
                var os = Environment.OSVersion.Version;
                var version = $"{os.Major}.{os.Minor}" + (os.Build == 0 ? "" : "." + os.Build.ToString(CultureInfo.InvariantCulture));
                return new Obj(("protocol", 1), ("helperVersion", 1), ("os", version), ("permissions", HelperPermissions.Json()),
                    ("symbols", fault != Fault.Symbols), ("selfCheck", check), ("activationYields", false));
            }
            case "requestPermissions":
            {
                Params.ValidateKeys(p, Params.Keys("permissions"));
                if (p["permissions"] is not JsonArray array || array.Count == 0 ||
                    !array.All(n => Json.Text(n) is "accessibility" or "screenRecording"))
                    throw new HelperError("invalid_params", "permissions");
                // Nothing to request on Windows: there is no per-app privacy gate for UI Automation or window capture.
                return new Obj(("requested", new List<string>()), ("deferred", new List<string>()), ("permissions", HelperPermissions.Json()));
            }
            case "windows" when fault == Fault.Hang:
                Clock.Pause(int.MaxValue, ct);
                return new Obj();
            case "windows": return Windows(p);
            case "snapshot": return Snapshot(p, ct);
            case "act" when fault == Fault.HangAfterSend:
                record.Confirmed("message", new List<string>());
                Clock.Pause(int.MaxValue, ct);
                return new Obj();
            case "act":
                if (fault is Fault.SelfCheck or Fault.Symbols) throw new HelperError("self_check_failed", check.GetValueOrDefault("reason") as string ?? "");
                return Act(p, record, ct);
            case "focus": return Focus(p, ct);
            case "recheck":
                Params.ValidateKeys(p, Params.Keys());
                return Recheck(ct);
            case "verify": return Verify(p, ct);
            case "cursor":
                Params.ValidateKeys(p, Params.Keys("op"));
                if (Json.Text(p["op"]) != "hide") throw new HelperError("invalid_params", "op must be hide");
                HideCursor(true);
                return new Obj();
            case "shutdown":
                Params.ValidateKeys(p, Params.Keys());
                HideCursor(false);
                return new Obj();
            default: throw new HelperError("invalid_params", "unknown method");
        }
    }

    // ---- cursor ----------------------------------------------------------------------------------------------------

    private IAICursor? EnsureCursor()
    {
        if (cursor != null || cursorFailed) return cursor;
        try { cursor = AICursor.Create(); UiaSession.Trace("cursor created"); }
        catch (Exception ex) { cursorFailed = true; UiaSession.Trace("cursor unavailable: " + ex.Message); }
        return cursor;
    }

    public void HideCursor(bool animated)
    {
        try { cursor?.Hide(animated); } catch { }
    }

    private void CursorTo(WindowInfo win, (double X, double Y) screen, CancellationToken ct)
    {
        var c = EnsureCursor();
        if (c == null) return;
        try
        {
            UiaSession.Trace($"cursor track {win.Hwnd:X} -> {screen.X:F0},{screen.Y:F0}");
            c.Track(win.Hwnd);
            c.MoveToAsync((int)Math.Round(screen.X), (int)Math.Round(screen.Y), ct).Wait(1_000, ct);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { UiaSession.Trace("cursor move: " + ex.GetType().Name + " " + ex.Message); }
    }

    private void Pulse(CursorFeedback kind)
    {
        try { cursor?.Feedback(kind); } catch { }
    }

    // ---- windows ---------------------------------------------------------------------------------------------------

    private void Prune(IEnumerable<WindowInfo> windows)
    {
        var keys = windows.Select(w => w.Key).ToHashSet();
        UiaOrNull?.Prune(Catalog.Prune(keys));
        webProbed.IntersectWith(keys);
    }

    private static bool MatchesStart(double? actual, double requested) => actual is { } a && Math.Abs(a - requested) < 0.000_001;

    private static (int Pid, uint Id, double? Started) WindowAddress(JsonObject p)
    {
        if (p["pid"] == null || p["windowId"] == null) throw new HelperError("invalid_params", "pid and windowId required");
        var pid = Params.BoundedInt(p["pid"], "pid", 0, 1, int.MaxValue);
        var id = (uint)Params.BoundedInt(p["windowId"], "windowId", 0, 1, uint.MaxValue);
        double? started = null;
        if (p["processStartedAt"] != null)
        {
            started = Json.Number(p["processStartedAt"]);
            if (started == null) throw new HelperError("invalid_params", "processStartedAt");
        }
        return (pid, id, started);
    }

    private WindowInfo Window(int pid, uint id, double? started, bool allowOtherSpace = false)
    {
        try
        {
            if (started is { } s && !MatchesStart(Catalog.LaunchDate(pid), s)) throw HelperError.Unavailable("closed");
            var found = Catalog.Available(pid, id, allowOtherSpace);
            if (started is { } s2 && !MatchesStart(found.Key.Started, s2)) throw HelperError.Unavailable("closed");
            return found;
        }
        catch (HelperError)
        {
            HideCursor(false);
            Prune(Catalog.All());
            throw;
        }
    }

    private Obj Windows(JsonObject p)
    {
        Params.ValidateKeys(p, Params.Keys("query"));
        var query = Params.OptionalString(p["query"], "query", 300);
        var windows = Catalog.All();
        Prune(windows);
        var filtered = windows.Where(w => string.IsNullOrEmpty(query) ||
            new[] { w.Title, w.App, w.BundleId, w.BundlePath }.Any(s => s.Contains(query, StringComparison.CurrentCultureIgnoreCase))).ToList();
        var result = new Obj(("windows", filtered.Select(w => w.Json()).ToList()));
        if (!string.IsNullOrEmpty(query)) result["installed"] = InstalledApps.Query(query);
        return result;
    }

    // ---- reading ---------------------------------------------------------------------------------------------------

    private const int ReadBudgetMs = 900;

    private UiaTree Read(WindowInfo win, int budgetMs = ReadBudgetMs)
    {
        var tree = Uia.Read(win, budgetMs);
        if (tree.WindowTitle is { Length: > 0 } title && win.Title.Length == 0) win.Title = title;
        return tree;
    }

    /// <summary>Chromium builds its web accessibility tree lazily after the first UIA request; wait for it like the macOS helper does.</summary>
    private UiaTree ReadPrepared(WindowInfo win, CancellationToken ct)
    {
        var start = Clock.Now;
        var tree = Read(win);
        if (!win.IsChromium) return tree;
        var first = webProbed.Add(win.Key);
        var deadline = first ? 2_500 : 1_000;
        while (!tree.HasWebContents && Clock.MillisSince(start) < deadline - 80)
        {
            Clock.Pause(80, ct);
            var remaining = deadline - Clock.MillisSince(start);
            if (remaining <= 0) break;
            tree = Read(win, Math.Min(ReadBudgetMs, Math.Max(200, remaining)));
        }
        return tree.HasWebContents ? tree : tree.With(false);
    }

    private static HelperError NeedsVisible(WindowInfo win) =>
        new("needs_visible_window", "", new Obj(("reason", win.Minimized ? "minimized" : win.Hidden ? "hidden" : "offscreen")));

    private Obj Snapshot(JsonObject p, CancellationToken ct)
    {
        Params.ValidateKeys(p, Params.Keys("pid", "windowId", "processStartedAt", "find", "expand", "limit", "valueLimit", "image"));
        var (pid, id, started) = WindowAddress(p);
        var find = Params.OptionalString(p["find"], "find", 500);
        if (find?.Length == 0) find = null;
        var expand = Params.OptionalRef(p["expand"]);
        var limit = Params.BoundedInt(p["limit"], "limit", 200, 1, 4_000);
        var valueLimit = Params.BoundedInt(p["valueLimit"], "valueLimit", 80, 0, 20_000);
        if (p["image"] != null && Json.Bool(p["image"]) == null) throw new HelperError("invalid_params", "image");
        var image = Json.Bool(p["image"]) == true;
        var win = Window(pid, id, started, image);
        var viewOnly = !win.InActiveDesktop || !win.OnCurrentSpace;
        var tree = viewOnly ? UiaTree.Empty : ReadPrepared(win, ct);
        var expanded = expand == null ? null : Uia.Resolve(expand, tree, win);
        var output = tree.Snapshot(find, expanded, limit, valueLimit);
        var result = new Obj(("window", win.SnapshotJson()), ("elements", output.Elements), ("omitted", output.Omitted),
            ("complete", tree.Complete && find == null && output.Omitted == 0 && !output.HasOutside));
        if (output.RootOutside > 0) result["omittedOutside"] = output.RootOutside;
        if (viewOnly) result["viewOnly"] = true;
        if (image)
        {
            try
            {
                var captured = WindowCapture.Capture(win, null, ct);
                result["image"] = captured.ToJson();
                if (win.IsChromium && WindowCapture.FullyOccluded(win)) result["imageNote"] = "occluded_chromium_may_be_stale";
            }
            catch { HideCursor(false); throw; }
        }
        ct.ThrowIfCancellationRequested();
        var fresh = Window(pid, id, started, image);
        if (fresh.Key != win.Key || fresh.Frame != win.Frame) throw HelperError.Unavailable();
        Uia.Publish(output.Shown.Values, win.Key);
        return result;
    }

    // ---- verify ----------------------------------------------------------------------------------------------------

    private sealed class Expectation
    {
        public JsonObject Raw { get; }
        public string? Ref { get; }
        public string? Role { get; }
        public string? Label { get; }
        public bool Exists { get; }

        public Expectation(JsonObject raw)
        {
            Params.ValidateKeys(raw, Params.Keys("ref", "role", "label", "exists", "value", "valueContains", "enabled", "selected", "focused"));
            Ref = Params.OptionalRef(raw["ref"]);
            Role = Params.OptionalString(raw["role"], "role", 40);
            Label = Params.OptionalString(raw["label"], "label", 200);
            if (Ref == null && string.IsNullOrEmpty(Role) && string.IsNullOrEmpty(Label)) throw new HelperError("invalid_params", "verify needs ref or role/label");
            foreach (var key in new[] { "exists", "enabled", "selected", "focused" })
                if (raw[key] != null && Json.Bool(raw[key]) == null) throw new HelperError("invalid_params", key);
            Params.OptionalString(raw["value"], "value", 2_000);
            Params.OptionalString(raw["valueContains"], "valueContains", 2_000);
            Raw = raw;
            Exists = Json.Bool(raw["exists"]) ?? true;
        }

        public Obj? Mismatch(UiaTree tree, Func<string, UiaNode> resolve)
        {
            UiaNode node;
            if (tree.Root == null) return new Obj(("reason", "incomplete"));
            if (Ref != null)
            {
                try { node = resolve(Ref); } catch (HelperError) { return new Obj(("reason", "stale_element")); }
            }
            else
            {
                var matches = tree.Nodes.Where(n => (Role == null || string.Equals(n.Role, Role, StringComparison.OrdinalIgnoreCase)) &&
                                                    (Label == null || n.Label == Label)).ToList();
                if (matches.Count > 1) return new Obj(("reason", "ambiguous"));
                if (!tree.Complete) return new Obj(("reason", "incomplete"));
                if (matches.Count == 0) return Exists ? new Obj(("field", "exists"), ("value", false)) : null;
                node = matches[0];
            }
            if (!Exists) return new Obj(("field", "exists"), ("value", true));
            var text = ValueText(node.Value);
            if (Json.Text(Raw["value"]) is { } value && text != value) return new Obj(("field", "value"), ("value", text));
            if (Json.Text(Raw["valueContains"]) is { } contains && text?.Contains(contains, StringComparison.Ordinal) != true) return new Obj(("field", "valueContains"), ("value", text));
            if (Json.Bool(Raw["focused"]) is { } focused && focused != node.Focused) return new Obj(("field", "focused"), ("value", node.Focused));
            if (Json.Bool(Raw["enabled"]) is { } enabled && enabled != node.Enabled) return new Obj(("field", "enabled"), ("value", node.Enabled));
            if (Json.Bool(Raw["selected"]) is { } selected && selected != node.Selected) return new Obj(("field", "selected"), ("value", node.Selected));
            return null;
        }
    }

    internal static string? ValueText(object? value) => value switch
    {
        string s => s,
        double d => d % 1 == 0 && Math.Abs(d) < 1e15 ? ((long)d).ToString(CultureInfo.InvariantCulture) : d.ToString("R", CultureInfo.InvariantCulture),
        _ => null,
    };

    private Obj Verify(JsonObject p, CancellationToken ct)
    {
        Params.ValidateKeys(p, Params.Keys("pid", "windowId", "processStartedAt", "expect", "timeoutMs"));
        var (pid, id, started) = WindowAddress(p);
        if (p["expect"] is not JsonArray raw || raw.Count is < 1 or > 8 || raw.Any(n => n is not JsonObject))
            throw new HelperError("invalid_params", "expect must contain 1 to 8 conditions");
        var expect = raw.Select(n => new Expectation((JsonObject)n!)).ToList();
        var timeout = Params.BoundedInt(p["timeoutMs"], "timeoutMs", 0, 0, 10_000);
        var start = Clock.Now;
        Obj Result(int index, Obj actual)
        {
            var result = new Obj(("index", index), ("expected", expect[index].Raw), ("waitedMs", Clock.MillisSince(start)));
            if (actual.TryGetValue("reason", out var reason)) { result["status"] = "unknown"; result["reason"] = reason; }
            else { result["status"] = "unsatisfied"; result["actual"] = actual; }
            return result;
        }
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            WindowInfo win;
            try { win = Window(pid, id, started); }
            catch (HelperError)
            {
                if (started is { } s && !MatchesStart(Catalog.LaunchDate(pid), s)) throw;
                return Result(0, new Obj(("reason", "window_unavailable")));
            }
            var tree = ReadPrepared(win, ct);
            (int Index, Obj Actual)? mismatch = null;
            for (var i = 0; i < expect.Count; i++)
            {
                var actual = expect[i].Mismatch(tree, r => Uia.Resolve(r, tree, win));
                if (actual != null) { mismatch = (i, actual); break; }
            }
            if (mismatch is not { } m) return new Obj(("status", "satisfied"), ("waitedMs", Clock.MillisSince(start)));
            if (m.Actual.GetValueOrDefault("reason") as string == "stale_element" || Clock.MillisSince(start) >= timeout) return Result(m.Index, m.Actual);
            Clock.Pause(Math.Min(80, Math.Max(1, timeout - Clock.MillisSince(start))), ct);
        }
    }

    // ---- focus -----------------------------------------------------------------------------------------------------

    internal sealed record FocusInfo(UiaNode? Node, nint Hwnd);

    private Obj Focus(JsonObject p, CancellationToken ct)
    {
        Params.ValidateKeys(p, Params.Keys("pid", "windowId", "processStartedAt", "ref"));
        var (pid, id, started) = WindowAddress(p);
        var win = Window(pid, id, started);
        // Focus is for the paste that follows: a window that is not on screen cannot receive it.
        if (!win.Onscreen) throw NeedsVisible(win);
        var tree = Read(win);
        var reference = Params.OptionalRef(p["ref"]);
        var node = reference == null ? null : Uia.Resolve(reference, tree, win);
        ct.ThrowIfCancellationRequested();
        var current = Window(pid, id, started);
        if (current.Key != win.Key) throw HelperError.Unavailable("closed");
        var focused = SettleEditableFocus(node, win, tree, mayFocus: true, new List<string>(), ct);
        if (focused == null) return new Obj(("editable", false));
        var result = new Obj(("editable", true));
        if (node != null) result["focusedRef"] = node.Ref;
        else if (focused.Node != null && tree.Nodes.Any(n => n.Ref == focused.Node.Ref)) result["focusedRef"] = focused.Node.Ref;
        if (focused.Node != null) result["role"] = focused.Node.Role;
        return result;
    }

    internal static bool HasKeyboardFocus(UiaNode node) => UiaSession.Current<bool>(node.El, UIA_PROPERTY_ID.UIA_HasKeyboardFocusPropertyId);

    /// <summary>
    /// Establishes where text/keys for an element go, without activating the window or touching the physical pointer:
    /// controls that own a window handle take messages directly (no focus change needed), Chromium and other message-capable surfaces
    /// get a posted click, and only surfaces with no message path fall back to UIA SetFocus under the foreground guard.
    /// </summary>
    private void FocusElement(UiaNode node, WindowInfo win, List<string> notes, CancellationToken ct)
    {
        if (node.Frame is not { } frame) return;
        var visible = frame.Intersect(win.LocalFrame);
        if (visible.IsEmpty) return;
        // A single-line field gets the click near its right edge so the caret lands at the end of the text (typing/paste append).
        var clickX = node.Role == "AXTextField" && frame.H < 60 && visible.W > 24 ? visible.Right - 6 : visible.MidX;
        var (sx, sy) = win.Screen(clickX, visible.MidY);
        var target = MessageInput.PointerTarget(win, (int)sx, (int)sy);
        if (win.IsChromium || MessageInput.MessageSurface(ClassName(target)))
        {
            MessageInput.Click(target, (int)sx, (int)sy, ClickKind.Click, ct);
            return;
        }
        ForegroundGuard.Run(win, notes, ct, () =>
        {
            try { node.El.SetFocus(); } catch (Exception ex) { throw UiaActions.Failure(ex, "no_editable_focus"); }
        });
    }

    /// <summary>Finds (and, when allowed, establishes) the editable element that will receive typing or a paste.</summary>
    private FocusInfo? SettleEditableFocus(UiaNode? node, WindowInfo win, UiaTree tree, bool mayFocus, List<string> notes, CancellationToken ct)
    {
        if (node != null)
        {
            if (!node.Editable) return null;
            // A control with its own window handle receives key/char messages directly; its focus state is irrelevant.
            if (!win.IsChromium && node.NativeHwnd != 0 && IsWindow(node.NativeHwnd) && MessageInput.MessageSurface(ClassName(node.NativeHwnd)))
                return new FocusInfo(node, node.NativeHwnd);
            // Chromium reports page focus even when its renderer is not receiving keys (window inactive): click to be sure.
            if (win.IsChromium && mayFocus) { FocusElement(node, win, notes, ct); return new FocusInfo(node, win.Hwnd); }
            if (HasKeyboardFocus(node)) return new FocusInfo(node, MessageInput.FocusWindow(win));
            if (!mayFocus) return null;
            FocusElement(node, win, notes, ct);
            var deadline = Clock.Now + 0.4;
            while (Clock.Now < deadline)
            {
                if (HasKeyboardFocus(node)) return new FocusInfo(node, MessageInput.FocusWindow(win));
                Clock.Pause(25, ct);
            }
            // A background Chromium page may keep reporting no keyboard focus although the click reached it; its readback still verifies typing.
            return win.IsChromium ? new FocusInfo(node, win.Hwnd) : null;
        }
        var focused = tree.Nodes.FirstOrDefault(n => n.Focused == true && n.Editable);
        if (focused != null && HasKeyboardFocus(focused))
            return new FocusInfo(focused, !win.IsChromium && focused.NativeHwnd != 0 && IsWindow(focused.NativeHwnd) && MessageInput.MessageSurface(ClassName(focused.NativeHwnd)) ? focused.NativeHwnd : MessageInput.FocusWindow(win));
        // Classic controls that do not report UIA focus: the target thread own focus window decides.
        if (!win.IsChromium)
        {
            var hwnd = MessageInput.FocusWindow(win);
            if (hwnd != win.Hwnd && MessageInput.EditLikeClass(ClassName(hwnd))) return new FocusInfo(null, hwnd);
        }
        return null;
    }

    public void Dispose()
    {
        try { cursor?.Dispose(); } catch { }
    }
}
