using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using FleetComputerUse.Cursor;
using Windows.Win32.UI.Accessibility;
using static FleetComputerUse.Helper.Native;

namespace FleetComputerUse.Helper;

internal enum ActionName { Click, DoubleClick, RightClick, Type, SetValue, Key, Scroll, Drag, Select, AxAction }

internal sealed class ActionRequest
{
    public ActionName Name { get; }
    public string? Ref { get; }
    public (double X, double Y)? Point { get; }
    public JsonObject? End { get; }
    public string? Text { get; }
    public KeyStroke? Stroke { get; }
    public string? Direction { get; }
    public double Pages { get; } = 1;
    public string? AxName { get; }
    public bool RequireEditableFocus { get; }

    public ActionRequest(JsonObject p)
    {
        var raw = Json.Text(p["action"]);
        Name = raw switch
        {
            "click" => ActionName.Click, "double_click" => ActionName.DoubleClick, "right_click" => ActionName.RightClick,
            "type" => ActionName.Type, "set_value" => ActionName.SetValue, "key" => ActionName.Key, "scroll" => ActionName.Scroll,
            "drag" => ActionName.Drag, "select" => ActionName.Select, "ax_action" => ActionName.AxAction,
            _ => throw new HelperError("invalid_params", "action"),
        };
        var positioned = Name is ActionName.Click or ActionName.DoubleClick or ActionName.RightClick or ActionName.Scroll or ActionName.Drag;
        var allowed = Params.Keys("pid", "windowId", "processStartedAt", "expectedFrame", "action");
        switch (Name)
        {
            case ActionName.Click or ActionName.DoubleClick or ActionName.RightClick: allowed.UnionWith(["ref", "x", "y"]); break;
            case ActionName.Scroll: allowed.UnionWith(["ref", "x", "y", "direction", "pages"]); break;
            case ActionName.Drag: allowed.UnionWith(["ref", "x", "y", "to"]); break;
            case ActionName.Type or ActionName.SetValue or ActionName.Select: allowed.UnionWith(["ref", "text"]); break;
            case ActionName.Key: allowed.UnionWith(["key", "ref", "requireEditableFocus", "text"]); break;
            case ActionName.AxAction: allowed.UnionWith(["ref", "name"]); break;
        }
        Params.ValidateKeys(p, allowed);
        Ref = Params.OptionalRef(p["ref"]);
        if (p["x"] != null || p["y"] != null)
        {
            var x = Json.Number(p["x"]);
            var y = Json.Number(p["y"]);
            if (Ref != null || x == null || y == null) throw new HelperError("invalid_params", "ref OR x and y");
            Point = (x.Value, y.Value);
        }
        if (positioned && Ref == null && Point == null) throw new HelperError("invalid_params", "ref OR x and y required");
        if (Name is ActionName.SetValue or ActionName.Select or ActionName.AxAction && Ref == null) throw new HelperError("invalid_params", "ref required");
        Text = Params.OptionalString(p["text"], "text", 20_000);
        if (Name is ActionName.Type or ActionName.SetValue or ActionName.Select && Text == null) throw new HelperError("invalid_params", "text required");
        if (Name is ActionName.Type or ActionName.Select && Text?.Length == 0) throw new HelperError("invalid_params", "text must not be empty");
        End = p["to"] as JsonObject;
        if (Name == ActionName.Drag && End == null) throw new HelperError("invalid_params", "to must be a ref or point object");
        AxName = Params.OptionalString(p["name"], "name", 80);
        if (Name == ActionName.AxAction && string.IsNullOrEmpty(AxName)) throw new HelperError("invalid_name");
        if (Name == ActionName.Key)
        {
            var key = Params.OptionalString(p["key"], "key", 60) ?? throw new HelperError("invalid_params", "key required");
            Stroke = new KeyStroke(key);
        }
        RequireEditableFocus = Json.Bool(p["requireEditableFocus"]) ?? false;
        if ((p["requireEditableFocus"] != null && Json.Bool(p["requireEditableFocus"]) == null) ||
            (Name == ActionName.Key && RequireEditableFocus && Stroke?.Paste != true))
            throw new HelperError("invalid_params", "requireEditableFocus applies to cmd+v only");
        if (Name == ActionName.Key && Text != null && !RequireEditableFocus) throw new HelperError("invalid_params", "text applies to paste only");
        if (Name == ActionName.Scroll)
        {
            Direction = Json.Text(p["direction"]);
            if (Direction is not ("up" or "down" or "left" or "right")) throw new HelperError("invalid_params", "direction must be up, down, left or right");
        }
        if (p["pages"] != null)
        {
            var n = Json.Number(p["pages"]);
            if (n == null || n < 0.1 || n > 10) throw new HelperError("invalid_params", "pages must be between 0.1 and 10");
            Pages = n.Value;
        }
    }
}

/// <summary>Post-action check that the intended effect is visible in the accessibility tree (macOS `Verification`).</summary>
internal abstract class Verification
{
    public abstract string? Check();
    public virtual bool Unreadable() => false;

    protected static string Normalize(string s) => s.Replace("\r\n", "\n").Replace('\r', '\n');

    public static int Occurrences(string text, string value)
    {
        if (text.Length == 0) return 0;
        var count = 0;
        var from = 0;
        while (from < value.Length)
        {
            var found = value.IndexOf(text, from, StringComparison.Ordinal);
            if (found < 0) break;
            count++;
            from = found + text.Length;
        }
        return count;
    }

    public sealed class Contains(IUIAutomationElement element, string text) : Verification
    {
        public override string? Check() =>
            UiaSession.ReadText(element) is { } value && Normalize(value).Contains(Normalize(text), StringComparison.Ordinal) ? "value_contains_text" : null;
    }

    public sealed class Pasted(IUIAutomationElement element, string text, int prior) : Verification
    {
        public override string? Check() =>
            UiaSession.ReadText(element) is { } value && Occurrences(Normalize(text), Normalize(value)) > prior ? "value_contains_text" : null;
    }

    public sealed class ValueEquals(IUIAutomationElement element, object expected) : Verification
    {
        public override string? Check()
        {
            if (expected is double d)
                return UiaSession.Current<double>(element, UIA_PROPERTY_ID.UIA_RangeValueValuePropertyId) is var v && Math.Abs(v - d) < 1e-9 ? "value_equals" : null;
            return UiaSession.ReadText(element) is { } value && value == (string)expected ? "value_equals" : null;
        }
    }

    public sealed class SelectionMatches(IUIAutomationElement element, string expected) : Verification
    {
        public override string? Check() => UiaActions.SelectionText(element) == expected ? "selection_matches" : null;
    }

    public sealed class SelectsAll(IUIAutomationElement element) : Verification
    {
        public override string? Check()
        {
            var value = UiaSession.ReadText(element);
            var selected = UiaActions.SelectionText(element);
            return value is { Length: > 0 } && selected != null && Normalize(selected) == Normalize(value) ? "selection_covers_all" : null;
        }
        public override bool Unreadable() => UiaSession.ReadText(element) == null || UiaActions.SelectionText(element) == null;
    }
}

/// <summary>UI Automation pattern calls (the B route and readback). Foreign-window activation is the caller's `ForegroundGuard` concern.</summary>
internal static class UiaActions
{
    public static HelperError Failure(Exception error, string fallback)
    {
        if (error is HelperError h) return h;
        if (error is COMException com)
        {
            return unchecked((uint)com.HResult) switch
            {
                0x80040201 => new HelperError("stale_element"),
                0x80040200 => new HelperError(fallback, "element_not_enabled"),
                0x8001011F or 0x800706BE or 0x800706BA or 0x80010108 or 0x80131505 => new HelperError("timeout", "uia_delivery_unknown"),
                _ => new HelperError(fallback),
            };
        }
        return new HelperError(fallback);
    }

    private static T? Pattern<T>(IUIAutomationElement element, UIA_PATTERN_ID id) where T : class
    {
        try { return element.GetCurrentPattern(id) as T; } catch { return null; }
    }

    public static void Press(UiaNode node, ClickKind kind)
    {
        var e = node.El;
        try
        {
            if (kind == ClickKind.RightClick)
            {
                (e as IUIAutomationElement3 ?? throw new HelperError("background_unavailable", "no_context_menu")).ShowContextMenu();
                return;
            }
            if (node.Patterns.Invoke && Pattern<IUIAutomationInvokePattern>(e, UIA_PATTERN_ID.UIA_InvokePatternId) is { } invoke) { invoke.Invoke(); return; }
            if (node.Patterns.Toggle && Pattern<IUIAutomationTogglePattern>(e, UIA_PATTERN_ID.UIA_TogglePatternId) is { } toggle) { toggle.Toggle(); return; }
            if (node.Patterns.Selection && Pattern<IUIAutomationSelectionItemPattern>(e, UIA_PATTERN_ID.UIA_SelectionItemPatternId) is { } item) { item.Select(); return; }
            if (node.Patterns.Expand && Pattern<IUIAutomationExpandCollapsePattern>(e, UIA_PATTERN_ID.UIA_ExpandCollapsePatternId) is { } expand)
            {
                var state = UiaSession.Current<int>(e, UIA_PROPERTY_ID.UIA_ExpandCollapseExpandCollapseStatePropertyId);
                if (state == 0) expand.Expand(); else expand.Collapse();
                return;
            }
        }
        catch (Exception ex) when (ex is not HelperError) { UiaSession.Trace("press failed: " + ex); throw Failure(ex, "background_unavailable"); }
        throw new HelperError("background_unavailable", "no_pattern");
    }

    public static void Scroll(UiaNode scrollable, string direction, double pages)
    {
        var pattern = Pattern<IUIAutomationScrollPattern>(scrollable.El, UIA_PATTERN_ID.UIA_ScrollPatternId)
            ?? throw new HelperError("background_unavailable", "no_scroll_pattern");
        var large = pages >= 1;
        var count = large ? (int)Math.Round(pages) : 1;
        var forward = large ? ScrollAmount.ScrollAmount_LargeIncrement : ScrollAmount.ScrollAmount_SmallIncrement;
        var backward = large ? ScrollAmount.ScrollAmount_LargeDecrement : ScrollAmount.ScrollAmount_SmallDecrement;
        var none = ScrollAmount.ScrollAmount_NoAmount;
        try
        {
            for (var i = 0; i < Math.Max(1, count); i++)
            {
                switch (direction)
                {
                    case "down": pattern.Scroll(none, forward); break;
                    case "up": pattern.Scroll(none, backward); break;
                    case "right": pattern.Scroll(forward, none); break;
                    default: pattern.Scroll(backward, none); break;
                }
            }
        }
        catch (Exception ex) when (ex is not HelperError) { throw Failure(ex, "background_unavailable"); }
    }

    public static void SetText(UiaNode node, string text)
    {
        var pattern = Pattern<IUIAutomationValuePattern>(node.El, UIA_PATTERN_ID.UIA_ValuePatternId) ?? throw new HelperError("not_settable");
        var bstr = UiaSession.NewBstr(text);
        try { pattern.SetValue(bstr); }
        catch (Exception ex) { throw Failure(ex, "not_settable"); }
        finally { UiaSession.FreeBstr(bstr); }
    }

    public static void SetNumber(UiaNode node, double number)
    {
        var pattern = Pattern<IUIAutomationRangeValuePattern>(node.El, UIA_PATTERN_ID.UIA_RangeValuePatternId) ?? throw new HelperError("not_settable");
        try { pattern.SetValue(number); }
        catch (Exception ex) { throw Failure(ex, "not_settable"); }
    }

    public static void Step(UiaNode node, int direction)
    {
        var pattern = Pattern<IUIAutomationRangeValuePattern>(node.El, UIA_PATTERN_ID.UIA_RangeValuePatternId) ?? throw new HelperError("invalid_name");
        try
        {
            var current = UiaSession.Current<double>(node.El, UIA_PROPERTY_ID.UIA_RangeValueValuePropertyId);
            var step = UiaSession.Current<double>(node.El, UIA_PROPERTY_ID.UIA_RangeValueSmallChangePropertyId);
            if (!(step > 0)) step = 1;
            var min = UiaSession.Current<double>(node.El, UIA_PROPERTY_ID.UIA_RangeValueMinimumPropertyId);
            var max = UiaSession.Current<double>(node.El, UIA_PROPERTY_ID.UIA_RangeValueMaximumPropertyId);
            var next = current + direction * step;
            if (max > min) next = Math.Clamp(next, min, max);
            pattern.SetValue(next);
        }
        catch (Exception ex) when (ex is not HelperError) { throw Failure(ex, "invalid_name"); }
    }

    /// <summary>Selects the first occurrence of `text` in the element's document. Returns false when the text is not present.</summary>
    public static bool SelectText(UiaNode node, string text)
    {
        var pattern = Pattern<IUIAutomationTextPattern>(node.El, UIA_PATTERN_ID.UIA_TextPatternId) ?? throw new HelperError("not_settable");
        var bstr = UiaSession.NewBstr(text);
        try
        {
            var range = pattern.DocumentRange.FindText(bstr, false, false);
            if (range == null) return false;
            range.Select();
            return true;
        }
        catch (Exception ex) when (ex is not HelperError) { throw Failure(ex, "text_not_found"); }
        finally { UiaSession.FreeBstr(bstr); }
    }

    public static string? SelectionText(IUIAutomationElement element)
    {
        try
        {
            if (element.GetCurrentPattern(UIA_PATTERN_ID.UIA_TextPatternId) is not IUIAutomationTextPattern pattern) return null;
            var ranges = pattern.GetSelection();
            if (ranges.Length == 0) return "";
            return UiaSession.BstrText(ranges.GetElement(0).GetText(2_000_000));
        }
        catch { return null; }
    }
}

internal sealed partial class HelperService
{
    private static Frame? ExpectedFrame(JsonObject p)
    {
        if (p["expectedFrame"] == null) return null;
        if (p["expectedFrame"] is not JsonObject f || Json.Number(f["x"]) is not { } x || Json.Number(f["y"]) is not { } y ||
            Json.Number(f["w"]) is not { } w || Json.Number(f["h"]) is not { } h || w <= 0 || h <= 0)
            throw new HelperError("invalid_params", "expectedFrame");
        return new Frame(x, y, w, h);
    }

    private static (double X, double Y) LocalPoint(UiaNode? node, (double X, double Y)? explicitPoint, WindowInfo win)
    {
        (double X, double Y) point;
        if (explicitPoint is { } given) point = given;
        else if (node?.Frame is { } frame)
        {
            var visible = frame.Intersect(win.LocalFrame);
            if (visible.IsEmpty) throw HelperError.Unavailable(message: "element_outside_window");
            point = (visible.MidX, visible.MidY);
        }
        else throw new HelperError("invalid_params", "target has no position");
        if (!win.LocalFrame.Contains(point.X, point.Y)) throw new HelperError("invalid_params", "position outside window");
        return point;
    }

    private static bool ElementAlive(UiaNode node) =>
        UiaSession.Current<int>(node.El, UIA_PROPERTY_ID.UIA_ControlTypePropertyId) != 0;

    private Obj Act(JsonObject p, DispatchRecord record, CancellationToken ct)
    {
        var actionStart = Clock.Now;
        var request = new ActionRequest(p);
        var requiredFrame = ExpectedFrame(p);
        var (pid, id, started) = WindowAddress(p);
        var win = Window(pid, id, started);
        if (check.GetValueOrDefault("ok") is not true) throw new HelperError("self_check_failed", check.GetValueOrDefault("reason") as string ?? "");
        var notVisible = NeedsVisible(win);
        if (!win.Onscreen && request.Name is ActionName.Type or ActionName.Key or ActionName.Drag) throw notVisible;
        var before = ReadPrepared(win, ct);
        var node = request.Ref == null ? null : Uia.Resolve(request.Ref, before, win);
        var beforeWindows = Catalog.All(pid, visibleOnly: true);
        var notes = new List<string>();
        var via = "message";
        CursorFeedback? pulse = null;
        (double X, double Y)? cursorPoint = null;
        Verification? verification = null;

        void Revalidate()
        {
            ct.ThrowIfCancellationRequested();
            var current = Window(pid, id, started);
            if (current.Key != win.Key) throw HelperError.Unavailable("closed");
            if (requiredFrame is { } wanted)
            {
                var a = current.Frame;
                if (new[] { a.X - wanted.X, a.Y - wanted.Y, a.W - wanted.W, a.H - wanted.H }.Any(d => Math.Abs(d) >= 1)) throw new HelperError("coordinates_need_image");
            }
            else if (current.Frame != win.Frame) throw HelperError.Unavailable();
            if (win.Onscreen && !current.Onscreen) throw HelperError.Unavailable(WindowCatalog.UnavailableReason(current));
            if (node != null && !ElementAlive(node)) throw new HelperError("stale_element");
        }

        // Pointer-style actions need a screen position; windows that are not drawn have none.
        (double X, double Y)? local = null;
        if (request.Name is ActionName.Click or ActionName.DoubleClick or ActionName.RightClick or ActionName.Scroll or ActionName.Drag)
        {
            if (!win.Onscreen && request.Point != null) throw notVisible;
            if (win.Onscreen || request.Point != null) local = LocalPoint(node, request.Point, win);
        }

        switch (request.Name)
        {
            case ActionName.Click or ActionName.DoubleClick or ActionName.RightClick:
            {
                var kind = request.Name switch { ActionName.DoubleClick => ClickKind.DoubleClick, ActionName.RightClick => ClickKind.RightClick, _ => ClickKind.Click };
                pulse = kind switch { ClickKind.DoubleClick => CursorFeedback.DoubleClick, ClickKind.RightClick => CursorFeedback.RightClick, _ => CursorFeedback.Click };
                var (sx, sy) = local is { } l ? win.Screen(l.X, l.Y) : (0, 0);
                if (local != null) cursorPoint = (sx, sy);
                nint target = 0;
                var message = false;
                if (win.Onscreen && local != null)
                {
                    target = MessageInput.PointerTarget(win, (int)Math.Round(sx), (int)Math.Round(sy));
                    message = win.IsChromium || MessageInput.MessageSurface(ClassName(target));
                }
                UiaNode? actionable = null;
                if (!message)
                {
                    actionable = PickActionable(before, node, kind, local, request.Ref != null);
                    if (actionable == null || kind == ClickKind.DoubleClick) throw new HelperError("background_unavailable", "no_message_or_uia_path");
                }
                Revalidate();
                if (win.Onscreen && cursorPoint is { } cp) CursorTo(win, cp, ct);
                Revalidate();
                if (message)
                {
                    MessageInput.Click(target, (int)Math.Round(sx), (int)Math.Round(sy), kind, ct);
                    via = "message";
                }
                else
                {
                    ForegroundGuard.Run(win, notes, ct, () => UiaActions.Press(actionable!, kind));
                    via = "uia";
                }
                break;
            }
            case ActionName.Scroll:
            {
                var direction = request.Direction!;
                pulse = direction switch { "up" => CursorFeedback.ScrollUp, "down" => CursorFeedback.ScrollDown, "left" => CursorFeedback.ScrollLeft, _ => CursorFeedback.ScrollRight };
                var (sx, sy) = local is { } l ? win.Screen(l.X, l.Y) : (0, 0);
                if (local != null) cursorPoint = (sx, sy);
                nint target = 0;
                var message = false;
                if (win.Onscreen && local != null)
                {
                    target = MessageInput.PointerTarget(win, (int)Math.Round(sx), (int)Math.Round(sy));
                    message = win.IsChromium || MessageInput.MessageSurface(ClassName(target));
                    // A covered point never reaches Chromium's wheel handling; only message the point the target itself owns.
                    if (message && win.IsChromium && !PointOwnedBy(win, (int)Math.Round(sx), (int)Math.Round(sy))) message = false;
                }
                UiaNode? scrollable = null;
                if (!message)
                {
                    var hit = node ?? (local is { } hl ? before.HitTest(hl.X, hl.Y) : null);
                    for (var n = hit; n != null; n = before.Parent(n)) if (n.Patterns.Scroll) { scrollable = n; break; }
                    if (scrollable == null) throw new HelperError("background_unavailable", "no_message_or_uia_path");
                }
                Revalidate();
                if (win.Onscreen && cursorPoint is { } cp) CursorTo(win, cp, ct);
                Revalidate();
                if (message)
                {
                    var notches = Math.Max(1, (int)Math.Round(request.Pages * 7));
                    var horizontal = direction is "left" or "right";
                    MessageInput.Wheel(target, (int)Math.Round(sx), (int)Math.Round(sy), direction is "up" or "right" ? notches : -notches, horizontal, ct);
                    via = "message";
                }
                else
                {
                    ForegroundGuard.Run(win, notes, ct, () => UiaActions.Scroll(scrollable!, direction, request.Pages));
                    via = "uia";
                }
                break;
            }
            case ActionName.Drag:
            {
                if (win.IsChromium)
                {
                    var slider = (node?.Role == "AXSlider" && node.Settable) ||
                        (request.Point is { } pt && before.HitTest(pt.X, pt.Y) is { Role: "AXSlider", Settable: true });
                    throw new HelperError("drag_unsupported", "", new Obj(("settableSlider", slider)));
                }
                var start = local!.Value;
                var end = request.End!;
                (double X, double Y) destination;
                if (Params.OptionalRef(end["ref"]) is { } endRef)
                {
                    Params.ValidateKeys(end, Params.Keys("ref"));
                    destination = LocalPoint(Uia.Resolve(endRef, before, win), null, win);
                }
                else
                {
                    Params.ValidateKeys(end, Params.Keys("x", "y"));
                    if (Json.Number(end["x"]) is not { } ex || Json.Number(end["y"]) is not { } ey) throw new HelperError("invalid_params", "to must be ref or x,y");
                    destination = LocalPoint(null, (ex, ey), win);
                }
                var (sx, sy) = win.Screen(start.X, start.Y);
                var (dx, dy) = win.Screen(destination.X, destination.Y);
                var target = MessageInput.PointerTarget(win, (int)Math.Round(sx), (int)Math.Round(sy));
                if (!MessageInput.MessageSurface(ClassName(target)))
                    throw new HelperError("drag_unsupported", "", new Obj(("settableSlider", node?.Role == "AXSlider" && node.Settable)));
                cursorPoint = (sx, sy);
                Revalidate();
                CursorTo(win, (sx, sy), ct);
                Revalidate();
                Pulse(CursorFeedback.DragBegin);
                var moving = Task.Run(() => CursorTo(win, (dx, dy), ct), ct);
                try { MessageInput.Drag(target, (int)Math.Round(sx), (int)Math.Round(sy), (int)Math.Round(dx), (int)Math.Round(dy), ct); }
                finally { try { moving.Wait(1_000, CancellationToken.None); } catch { } }
                Pulse(CursorFeedback.DragEnd);
                via = "message";
                break;
            }
            case ActionName.Type:
            {
                Revalidate();
                var focus = SettleEditableFocus(node, win, before, mayFocus: true, notes, ct) ?? throw new HelperError("no_editable_focus");
                if (focus.Node != null) { verification = new Verification.Contains(focus.Node.El, request.Text!); }
                if (focus.Node?.Frame is { } fr && fr.Intersect(win.LocalFrame) is { IsEmpty: false } vis) cursorPoint = win.Screen(vis.MidX, vis.MidY);
                Revalidate();
                if (win.Onscreen && cursorPoint is { } cp) CursorTo(win, cp, ct);
                Pulse(CursorFeedback.TypingOn);
                try { MessageInput.Chars(focus.Hwnd, request.Text!, ct); }
                finally { Pulse(CursorFeedback.TypingOff); }
                via = "message";
                break;
            }
            case ActionName.Key:
            {
                var stroke = request.Stroke!;
                FocusInfo? editable = null;
                if (request.RequireEditableFocus)
                {
                    editable = SettleEditableFocus(node, win, before, mayFocus: false, notes, ct) ?? throw new HelperError("no_editable_focus");
                    if (request.Text is { Length: > 0 } pasteText && editable.Node != null && UiaSession.ReadText(editable.Node.El) is { } existing)
                        verification = new Verification.Pasted(editable.Node.El, pasteText, Verification.Occurrences(pasteText.Replace("\r\n", "\n"), existing.Replace("\r\n", "\n")));
                }
                else if (node != null)
                {
                    Revalidate();
                    editable = node.Editable ? SettleEditableFocus(node, win, before, mayFocus: true, notes, ct) : null;
                    if (editable == null && !node.Editable && !HasKeyboardFocus(node)) FocusElement(node, win, notes, ct);
                }
                else editable = SettleEditableFocus(null, win, before, mayFocus: false, notes, ct);
                if (stroke.SelectAll && editable?.Node != null) verification = new Verification.SelectsAll(editable.Node.El);
                var focusNode = editable?.Node ?? node;
                if (focusNode?.Frame is { } fr && fr.Intersect(win.LocalFrame) is { IsEmpty: false } vis) cursorPoint = win.Screen(vis.MidX, vis.MidY);
                Revalidate();
                if (win.Onscreen && cursorPoint is { } cp) CursorTo(win, cp, ct);
                if (editable?.Node != null) Pulse(CursorFeedback.TypingOn);
                try { via = MessageInput.Key(editable?.Hwnd ?? MessageInput.FocusWindow(win), stroke, ct); }
                finally { if (editable?.Node != null) Pulse(CursorFeedback.TypingOff); }
                break;
            }
            case ActionName.SetValue:
            {
                var target = node ?? throw new HelperError("stale_element");
                if (!target.Settable) throw new HelperError("not_settable");
                var text = request.Text!;
                if (target.Value is double)
                {
                    if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || !double.IsFinite(number))
                        throw new HelperError("invalid_params", "numeric value required");
                    verification = new Verification.ValueEquals(target.El, number);
                    cursorPoint = CenterOf(target, win);
                    Revalidate();
                    if (win.Onscreen && cursorPoint is { } c1) CursorTo(win, c1, ct);
                    ForegroundGuard.Run(win, notes, ct, () => UiaActions.SetNumber(target, number));
                }
                else
                {
                    verification = new Verification.ValueEquals(target.El, text);
                    cursorPoint = CenterOf(target, win);
                    Revalidate();
                    if (win.Onscreen && cursorPoint is { } c2) CursorTo(win, c2, ct);
                    ForegroundGuard.Run(win, notes, ct, () => UiaActions.SetText(target, text));
                }
                notes.Add("uia_value_set");
                via = "uia";
                break;
            }
            case ActionName.Select:
            {
                var target = node ?? throw new HelperError("stale_element");
                if (!target.Patterns.Text) throw new HelperError("not_settable");
                var text = request.Text!;
                var content = UiaSession.ReadText(target.El) ?? throw new HelperError("text_not_found");
                if (!content.Contains(text, StringComparison.Ordinal)) throw new HelperError("text_not_found");
                verification = new Verification.SelectionMatches(target.El, text);
                cursorPoint = CenterOf(target, win);
                Revalidate();
                if (win.Onscreen && cursorPoint is { } c) CursorTo(win, c, ct);
                var found = true;
                ForegroundGuard.Run(win, notes, ct, () => found = UiaActions.SelectText(target, text));
                if (!found) throw new HelperError("text_not_found");
                via = "uia";
                break;
            }
            case ActionName.AxAction:
            {
                var name = request.AxName!;
                if (node == null || !Uia.Offered(name, node.Ref, win.Key) || !node.Actions.Contains(name)) throw new HelperError("invalid_name");
                cursorPoint = CenterOf(node, win);
                Revalidate();
                if (win.Onscreen && cursorPoint is { } c) CursorTo(win, c, ct);
                ForegroundGuard.Run(win, notes, ct, () =>
                {
                    switch (name)
                    {
                        case "AXPress": UiaActions.Press(node, ClickKind.Click); break;
                        case "AXShowMenu": UiaActions.Press(node, ClickKind.RightClick); break;
                        case "AXIncrement": UiaActions.Step(node, 1); break;
                        case "AXDecrement": UiaActions.Step(node, -1); break;
                        default: throw new HelperError("invalid_name");
                    }
                });
                via = "uia";
                break;
            }
        }

        record.Confirmed(via, notes);
        if (pulse is { } feedback) Pulse(feedback);
        return Observe(win, before, beforeWindows, via, notes, verification, actionStart, ct);
    }

    private static (double X, double Y)? CenterOf(UiaNode node, WindowInfo win)
    {
        if (node.Frame is not { } f) return null;
        var visible = f.Intersect(win.LocalFrame);
        return visible.IsEmpty ? null : win.Screen(visible.MidX, visible.MidY);
    }

    /// <summary>The UIA element for a B-route click: the referenced element, or the actionable element at/above a coordinate hit.</summary>
    private static UiaNode? PickActionable(UiaTree tree, UiaNode? node, ClickKind kind, (double X, double Y)? local, bool byRef)
    {
        bool Fits(UiaNode n) => kind == ClickKind.RightClick ? n.Actions.Contains("AXShowMenu") : n.Patterns.Invoke || n.Patterns.Toggle || n.Patterns.Selection || n.Patterns.Expand;
        if (node != null) return Fits(node) ? node : null;
        if (byRef || local is not { } l) return null;
        var hit = tree.HitTest(l.X, l.Y);
        for (var i = 0; hit != null && i < 4; i++, hit = tree.Parent(hit)) if (Fits(hit)) return hit;
        return null;
    }

    /// <summary>True when the topmost window at the screen point is the target itself (or this process's own click-through overlay).</summary>
    private static bool PointOwnedBy(WindowInfo win, int sx, int sy)
    {
        var hit = WindowFromPoint(new POINT { X = sx, Y = sy });
        if (hit == 0) return false;
        return GetAncestor(hit, GA_ROOT) == win.Hwnd || Owner(hit).Pid == (int)GetCurrentProcessId();
    }

    // ---- observation -----------------------------------------------------------------------------------------------

    private Obj Observe(WindowInfo win, UiaTree before, List<WindowInfo> windows, string via, List<string> notes, Verification? verification,
        double actionStart, CancellationToken ct)
    {
        var start = Clock.Now;
        var maxObservation = Math.Min(1_500, Math.Max(1, 1_950 - Clock.MillisSince(actionStart)));
        var old = before.Nodes.Where(n => n.Visible).ToDictionary(n => n.Ref);
        var oldWindows = windows.ToDictionary(w => w.Key);
        var result = new Obj(("sent", true), ("via", via), ("observation", "unobservable"), ("changes", new List<object?>()), ("notes", notes));
        var reported = new List<UiaNode>();
        try
        {
            while (true)
            {
                Clock.Pause(Math.Min(80, Math.Max(1, maxObservation - Clock.MillisSince(start))), ct);
                var currentWindows = Catalog.All(win.Key.Pid, visibleOnly: true);
                var currentKeys = currentWindows.Select(w => w.Key).ToHashSet();
                var windowsChanged = currentWindows.Where(w => !oldWindows.ContainsKey(w.Key)).Select(w => new Obj(("op", "+"), ("window", w.Json()))).ToList();
                foreach (var gone in windows.Where(w => !currentKeys.Contains(w.Key)))
                {
                    var closed = false;
                    try { closed = Catalog.Available(gone.Key.Pid, gone.Key.Id).Key != gone.Key; }
                    catch (HelperError e) { closed = (e.Details?.GetValueOrDefault("reason") as string) == "closed"; }
                    catch { }
                    if (closed) windowsChanged.Add(new Obj(("op", "-"), ("window", gone.Json())));
                }
                if (windowsChanged.Count > 0) { result["windowsChanged"] = windowsChanged; result["observation"] = "changes"; }
                WindowInfo fresh;
                try { fresh = Window(win.Key.Pid, win.Key.Id, win.Key.Started); }
                catch (HelperError) { return result; }
                if (fresh.Key != win.Key) return result;
                var tree = Read(fresh, Math.Max(60, Math.Min(400, maxObservation - Clock.MillisSince(start))));
                var current = tree.Nodes.Where(n => n.Visible).ToDictionary(n => n.Ref);
                var changes = new List<Obj>();
                foreach (var node in tree.Nodes.Where(n => n.Visible))
                {
                    if (old.TryGetValue(node.Ref, out var prior))
                    {
                        if (node.ChangedFrom(prior) || node.Frame != prior.Frame) changes.Add(new Obj(("op", "~"), ("element", node.Json(80))));
                    }
                    else if (before.Complete) changes.Add(new Obj(("op", "+"), ("element", node.Json(80))));
                }
                if (tree.Complete)
                    foreach (var node in before.Nodes.Where(n => n.Visible && !current.ContainsKey(n.Ref)))
                        changes.Add(new Obj(("op", "-"), ("element", node.Json(80))));
                if (changes.Count > 0)
                {
                    var shown = changes.Take(30).ToList();
                    result["changes"] = shown;
                    reported = shown.Where(c => (string?)c["op"] != "-").Select(c => current.GetValueOrDefault((string)((Obj)c["element"]!)["ref"]!)).Where(n => n != null).Select(n => n!).ToList();
                    if (changes.Count > 30) result["changesMore"] = changes.Count - 30;
                }
                if (changes.Count > 0 || windowsChanged.Count > 0) result["observation"] = "changes";
                else if (result["observation"] as string != "changes" && tree.Observable && before.Observable && tree.Complete && before.Complete) result["observation"] = "none";
                if (verification?.Check() is { } fact) { result["verified"] = fact; return result; }
                if (verification == null && (changes.Count > 0 || windowsChanged.Count > 0 || !tree.Observable)) return result;
                if (Clock.MillisSince(start) >= maxObservation)
                {
                    if (maxObservation < 1_500 && result["observation"] as string == "none") result["observation"] = "timeout";
                    if (result["observation"] as string == "none" && verification?.Unreadable() == true) result["observation"] = "unobservable";
                    return result;
                }
            }
        }
        finally { Uia.Publish(reported, win.Key); }
    }
}
