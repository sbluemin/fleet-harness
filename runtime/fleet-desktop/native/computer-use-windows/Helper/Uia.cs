using System.Runtime.InteropServices;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.UI.Accessibility;
using static FleetComputerUse.Helper.Native;

namespace FleetComputerUse.Helper;

internal sealed record PatternSet(bool Invoke, bool Toggle, bool Selection, bool Expand, bool Range, bool Scroll, bool Text, bool Value);

internal sealed class UiaNode
{
    public required string Ref { get; init; }
    public required string Identity { get; init; }
    public required IUIAutomationElement El { get; init; }
    public int? ParentIndex { get; init; }
    public int Depth { get; init; }
    public required string Role { get; init; }
    public string? Label { get; init; }
    /// <summary>string, double (toggle/range) or null.</summary>
    public object? Value { get; init; }
    public required List<string> Actions { get; init; }
    public bool Settable { get; init; }
    public bool Editable { get; init; }
    public bool? Focused { get; init; }
    public bool? Enabled { get; init; }
    public bool? Selected { get; init; }
    public Frame? Frame { get; init; }
    public bool Visible { get; init; }
    public bool Web { get; init; }
    public int ControlType { get; init; }
    public string ClassName { get; init; } = "";
    public nint NativeHwnd { get; init; }
    public bool Focusable { get; init; }
    public bool ReadOnly { get; init; }
    public required PatternSet Patterns { get; init; }

    public Obj Json(int valueLimit, int moreOutside = 0)
    {
        var o = new Obj(("ref", Ref), ("depth", Depth), ("role", Role), ("settable", Settable), ("editable", Editable));
        if (moreOutside > 0) o["moreOutside"] = moreOutside;
        if (Label != null) o["label"] = Label;
        if (Value is string text)
        {
            var infos = new System.Globalization.StringInfo(text);
            if (infos.LengthInTextElements > valueLimit)
            {
                o["value"] = infos.SubstringByTextElements(0, valueLimit);
                o["valueMore"] = infos.LengthInTextElements - valueLimit;
            }
            else o["value"] = text;
        }
        else if (Value != null) o["value"] = Value;
        if (Actions.Count > 0) o["actions"] = Actions;
        if (Focused != null) o["focused"] = Focused;
        if (Enabled != null) o["enabled"] = Enabled;
        if (Selected != null) o["selected"] = Selected;
        if (Frame is { } f) o["frame"] = f.ToJson();
        return o;
    }

    public bool ChangedFrom(UiaNode other) =>
        Role != other.Role || Label != other.Label || !ValueEquals(Value, other.Value) || !Actions.SequenceEqual(other.Actions) ||
        Settable != other.Settable || Editable != other.Editable || Focused != other.Focused || Enabled != other.Enabled || Selected != other.Selected;

    public static bool ValueEquals(object? a, object? b) => a == null || b == null ? a == null && b == null : a.Equals(b);
}

internal sealed class UiaTree
{
    public static readonly UiaTree Empty = new(null, new List<UiaNode>(), false, null);
    public UiaTree(IUIAutomationElement? root, List<UiaNode> nodes, bool complete, string? title)
    {
        Root = root; Nodes = nodes; Complete = complete; WindowTitle = title;
    }
    public IUIAutomationElement? Root { get; }
    public List<UiaNode> Nodes { get; }
    public bool Complete { get; }
    public string? WindowTitle { get; }
    public bool Observable => Nodes.Any(n => n.Visible && (n.Value != null || n.Label != null || n.Editable || n.Actions.Count > 0));
    public bool Web => Nodes.Any(n => n.Web);
    public bool HasWebContents => Nodes.Any(n => n.Web && n.Role != "AXWebArea");

    public UiaTree With(bool complete) => new(Root, Nodes, complete, WindowTitle);

    /// <summary>Deepest visible node whose local frame contains the point (window-local coordinates).</summary>
    public UiaNode? HitTest(double x, double y)
    {
        UiaNode? best = null;
        double bestArea = double.MaxValue;
        foreach (var node in Nodes)
        {
            if (!node.Visible || node.Frame is not { } f || !f.Contains(x, y)) continue;
            var area = f.W * f.H;
            if (best == null || node.Depth > best.Depth || (node.Depth == best.Depth && area <= bestArea)) { best = node; bestArea = area; }
        }
        return best;
    }

    public UiaNode? Parent(UiaNode node) => node.ParentIndex is { } i ? Nodes[i] : null;

    public (List<Obj> Elements, Dictionary<string, UiaNode> Shown, int Omitted, int RootOutside, bool HasOutside) Snapshot(
        string? find, UiaNode? expand, int limit, int valueLimit)
    {
        var include = new SortedSet<int>();
        void AddChain(int start)
        {
            int? index = start;
            while (index is { } j && include.Add(j)) index = Nodes[j].ParentIndex;
        }
        for (var i = 0; i < Nodes.Count; i++)
        {
            var node = Nodes[i];
            if (!node.Visible) continue;
            if (find != null && !new[] { node.Role, node.Label, node.Value as string ?? (node.Value is double d ? d.ToString(System.Globalization.CultureInfo.InvariantCulture) : null) }
                    .Any(s => s != null && s.Contains(find, StringComparison.CurrentCultureIgnoreCase))) continue;
            AddChain(i);
        }
        var expandIndex = expand == null ? -1 : Nodes.FindIndex(n => n.Ref == expand.Ref);
        if (expandIndex >= 0) AddChain(expandIndex);
        var outside = new Dictionary<int, int>();
        var rootOutside = 0;
        for (var i = 0; i < Nodes.Count; i++)
        {
            var node = Nodes[i];
            if (node.Visible || include.Contains(i)) continue;
            if (node.ParentIndex is { } parent) { if (include.Contains(parent)) outside[parent] = outside.GetValueOrDefault(parent) + 1; }
            else if (find == null) rootOutside++;
        }
        var ordered = include.ToList();
        var reserve = expand != null && expandIndex < 0 ? 1 : 0;
        var selected = ordered.Take(Math.Max(0, limit - reserve)).ToList();
        if (expandIndex >= 0 && !selected.Contains(expandIndex) && selected.Count > 0) selected[^1] = expandIndex;
        var shown = new Dictionary<string, UiaNode>();
        var items = new List<Obj>();
        foreach (var i in selected)
        {
            var node = Nodes[i];
            shown[node.Ref] = node;
            items.Add(node.Json(node.Ref == expand?.Ref ? 20_000 : valueLimit, outside.GetValueOrDefault(i)));
        }
        if (expand != null && expandIndex < 0)
        {
            items.Add(expand.Json(20_000));
            shown[expand.Ref] = expand;
        }
        return (items, shown, Math.Max(0, ordered.Count - selected.Count), rootOutside, rootOutside != 0 || outside.Count != 0);
    }
}

internal static class UiaRoles
{
    /// <summary>UIA ControlType → macOS AX role vocabulary (the Console renders and reverse-maps AX roles).</summary>
    public static string Role(int controlType, bool web, bool chromium) => controlType switch
    {
        50000 => "AXButton",
        50001 => "AXGroup",
        50002 => "AXCheckBox",
        50003 => "AXComboBox",
        50004 => "AXTextField",
        50005 => "AXLink",
        50006 => "AXImage",
        50007 => "AXRow",
        50008 => "AXList",
        50009 => "AXMenu",
        50010 => "AXMenuBar",
        50011 => "AXMenuItem",
        50012 => "AXProgressIndicator",
        50013 => "AXRadioButton",
        50014 => "AXScrollBar",
        50015 => "AXSlider",
        50016 => "AXIncrementor",
        50017 => "AXGroup",
        50018 => "AXTabGroup",
        50019 => "AXRadioButton",
        50020 => "AXStaticText",
        50021 => "AXToolbar",
        50022 => "AXGroup",
        50023 => "AXOutline",
        50024 => "AXRow",
        50025 => "AXGroup",
        50026 => "AXGroup",
        50027 => "AXSplitter",
        50028 => "AXTable",
        50029 => "AXRow",
        50030 => chromium ? "AXWebArea" : "AXTextArea",
        50031 => "AXPopUpButton",
        50032 => "AXGroup",
        50033 => "AXGroup",
        50034 => "AXGroup",
        50035 => "AXColumn",
        50036 => "AXTable",
        50037 => "AXGroup",
        50038 => "AXSplitter",
        50039 => "AXGroup",
        50040 => "AXToolbar",
        _ => "AXUnknown",
    };
}

internal sealed class UiaSession
{
    private sealed class Exposure
    {
        public required string Identity { get; init; }
        public required HashSet<string> Actions { get; init; }
    }

    private readonly IUIAutomation auto;
    private readonly IUIAutomationCacheRequest request;
    private long counter;
    private readonly Dictionary<WindowKey, Dictionary<string, string>> identities = new();
    private readonly Dictionary<WindowKey, Dictionary<string, Exposure>> exposed = new();

    public UiaSession()
    {
        auto = (IUIAutomation)new CUIAutomation8();
        request = auto.CreateCacheRequest();
        foreach (var property in CachedProperties) request.AddProperty(property);
        request.TreeScope = TreeScope.TreeScope_Element | TreeScope.TreeScope_Children;
        request.TreeFilter = auto.ControlViewCondition;
        request.AutomationElementMode = AutomationElementMode.AutomationElementMode_Full;
    }

    public IUIAutomation Automation => auto;

    private static readonly bool Debug = Environment.GetEnvironmentVariable("FLEET_COMPUTER_USE_TRACE") == "1";
    internal static void Trace(string message) { if (Debug) Console.Error.WriteLine("[uia] " + message); }

    private static readonly UIA_PROPERTY_ID[] CachedProperties =
    [
        UIA_PROPERTY_ID.UIA_RuntimeIdPropertyId, UIA_PROPERTY_ID.UIA_BoundingRectanglePropertyId, UIA_PROPERTY_ID.UIA_ControlTypePropertyId,
        UIA_PROPERTY_ID.UIA_NamePropertyId, UIA_PROPERTY_ID.UIA_AutomationIdPropertyId, UIA_PROPERTY_ID.UIA_ClassNamePropertyId,
        UIA_PROPERTY_ID.UIA_HasKeyboardFocusPropertyId, UIA_PROPERTY_ID.UIA_IsKeyboardFocusablePropertyId, UIA_PROPERTY_ID.UIA_IsEnabledPropertyId,
        UIA_PROPERTY_ID.UIA_IsOffscreenPropertyId, UIA_PROPERTY_ID.UIA_NativeWindowHandlePropertyId, UIA_PROPERTY_ID.UIA_HelpTextPropertyId,
        UIA_PROPERTY_ID.UIA_IsPasswordPropertyId,
        UIA_PROPERTY_ID.UIA_IsInvokePatternAvailablePropertyId, UIA_PROPERTY_ID.UIA_IsTogglePatternAvailablePropertyId,
        UIA_PROPERTY_ID.UIA_IsSelectionItemPatternAvailablePropertyId, UIA_PROPERTY_ID.UIA_IsExpandCollapsePatternAvailablePropertyId,
        UIA_PROPERTY_ID.UIA_IsRangeValuePatternAvailablePropertyId, UIA_PROPERTY_ID.UIA_IsScrollPatternAvailablePropertyId,
        UIA_PROPERTY_ID.UIA_IsTextPatternAvailablePropertyId, UIA_PROPERTY_ID.UIA_IsValuePatternAvailablePropertyId,
        UIA_PROPERTY_ID.UIA_ValueValuePropertyId, UIA_PROPERTY_ID.UIA_ValueIsReadOnlyPropertyId,
        UIA_PROPERTY_ID.UIA_RangeValueValuePropertyId, UIA_PROPERTY_ID.UIA_RangeValueIsReadOnlyPropertyId,
        UIA_PROPERTY_ID.UIA_ToggleToggleStatePropertyId, UIA_PROPERTY_ID.UIA_SelectionItemIsSelectedPropertyId,
    ];

    // ---- property helpers -------------------------------------------------------------------------------------------

    private static T? Cached<T>(IUIAutomationElement e, UIA_PROPERTY_ID id)
    {
        try { return e.GetCachedPropertyValue(id) is T value ? value : default; } catch { return default; }
    }

    public static T? Current<T>(IUIAutomationElement e, UIA_PROPERTY_ID id)
    {
        try { return e.GetCurrentPropertyValue(id) is T value ? value : default; } catch { return default; }
    }

    private static Frame? RectFrom(object? raw) =>
        raw is double[] { Length: 4 } r && r.All(double.IsFinite) && r[2] >= 0 && r[3] >= 0 ? new Frame(r[0], r[1], r[2], r[3]) : null;

    public static Frame? CurrentFrame(IUIAutomationElement e) => RectFrom(Current<double[]>(e, UIA_PROPERTY_ID.UIA_BoundingRectanglePropertyId));

    private static string RuntimeIdKey(IUIAutomationElement e)
    {
        var id = Cached<int[]>(e, UIA_PROPERTY_ID.UIA_RuntimeIdPropertyId);
        return id is { Length: > 0 } ? string.Join('.', id) : "";
    }

    // ---- tree --------------------------------------------------------------------------------------------------------

    public IUIAutomationElement? RootFor(WindowInfo win)
    {
        try { return auto.ElementFromHandle(new HWND(win.Hwnd)); } catch { return null; }
    }

    public UiaTree Read(WindowInfo win, int budgetMs)
    {
        IUIAutomationElement? rootCurrent = RootFor(win);
        if (rootCurrent == null) return UiaTree.Empty;
        IUIAutomationElement root;
        try { root = rootCurrent.BuildUpdatedCache(request); } catch { return UiaTree.Empty; }
        var start = Clock.Now;
        var old = identities.GetValueOrDefault(win.Key) ?? new Dictionary<string, string>();
        var next = new Dictionary<string, string>();
        var visited = new HashSet<string>();
        var nodes = new List<UiaNode>();
        var complete = true;
        var title = Cached<string>(root, UIA_PROPERTY_ID.UIA_NamePropertyId);
        var chromium = win.IsChromium;

        IUIAutomationElementArray? Children(IUIAutomationElement e)
        {
            try { return e.GetCachedChildren(); } catch { return null; }
        }

        void Walk(IUIAutomationElement parentWithChildren, int parentIndex, int depth, Frame clip, bool web, string parentKey)
        {
            var array = Children(parentWithChildren);
            if (array == null) return;
            int count;
            try { count = array.Length; } catch { complete = false; return; }
            for (var i = 0; i < count; i++)
            {
                if (nodes.Count >= 4_000 || Clock.MillisSince(start) >= budgetMs || depth >= 64) { complete = false; Trace($"budget nodes={nodes.Count} ms={Clock.MillisSince(start)} depth={depth}"); return; }
                IUIAutomationElement child;
                try { child = array.GetElement(i); } catch { complete = false; continue; }
                var key = RuntimeIdKey(child);
                if (key.Length == 0) key = parentKey + "/" + i + ":" + (Cached<int>(child, UIA_PROPERTY_ID.UIA_ControlTypePropertyId)) + ":" + Cached<string>(child, UIA_PROPERTY_ID.UIA_AutomationIdPropertyId);
                if (!visited.Add(key)) continue;
                string reference;
                if (old.TryGetValue(key, out var existing)) reference = existing;
                else reference = "e" + (++counter).ToString(System.Globalization.CultureInfo.InvariantCulture);
                var node = MakeNode(child, reference, key, win, parentIndex, depth, clip, web, chromium);
                if (node == null) { complete = false; Trace("node_null " + key + " ct=" + Cached<int>(child, UIA_PROPERTY_ID.UIA_ControlTypePropertyId)); continue; }
                next[key] = reference;
                var index = nodes.Count;
                nodes.Add(node);
                if (LeafLike(node.ControlType)) continue;
                IUIAutomationElement withChildren;
                try { withChildren = child.BuildUpdatedCache(request); } catch { complete = false; continue; }
                var nextClip = node.Role == "AXScrollArea" && node.Frame is { } f ? clip.Intersect(f) : clip;
                Walk(withChildren, index, depth + 1, nextClip, node.Web, key);
            }
        }

        Walk(root, -1, 0, win.LocalFrame, false, "");
        // Parent index -1 means "top-level control" (the window itself is separate metadata).
        for (var i = 0; i < nodes.Count; i++) { }
        if (complete)
        {
            var issued = exposed.GetValueOrDefault(win.Key);
            old = old.Where(kv => issued != null && issued.Values.Any(x => x.Identity == kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value);
        }
        foreach (var kv in next) old[kv.Key] = kv.Value;
        identities[win.Key] = old;
        return new UiaTree(root, nodes, complete, title);
    }

    private static bool LeafLike(int controlType) => controlType is 50020 or 50006 or 50038 or 50027 or 50014 or 50012 or 50004 or 50002 or 50013;

    private UiaNode? MakeNode(IUIAutomationElement e, string reference, string identity, WindowInfo win, int parentIndex, int depth,
        Frame clip, bool inWeb, bool chromium)
    {
        var controlType = Cached<int>(e, UIA_PROPERTY_ID.UIA_ControlTypePropertyId);
        if (controlType == 0) return null;
        var rect = RectFrom(Cached<double[]>(e, UIA_PROPERTY_ID.UIA_BoundingRectanglePropertyId));
        var local = rect?.Offset(-win.Frame.X, -win.Frame.Y);
        var offscreen = Cached<bool>(e, UIA_PROPERTY_ID.UIA_IsOffscreenPropertyId);
        var name = Cached<string>(e, UIA_PROPERTY_ID.UIA_NamePropertyId);
        var help = Cached<string>(e, UIA_PROPERTY_ID.UIA_HelpTextPropertyId);
        var label = !string.IsNullOrEmpty(name) ? name : !string.IsNullOrEmpty(help) ? help : null;
        var patterns = new PatternSet(
            Cached<bool>(e, UIA_PROPERTY_ID.UIA_IsInvokePatternAvailablePropertyId),
            Cached<bool>(e, UIA_PROPERTY_ID.UIA_IsTogglePatternAvailablePropertyId),
            Cached<bool>(e, UIA_PROPERTY_ID.UIA_IsSelectionItemPatternAvailablePropertyId),
            Cached<bool>(e, UIA_PROPERTY_ID.UIA_IsExpandCollapsePatternAvailablePropertyId),
            Cached<bool>(e, UIA_PROPERTY_ID.UIA_IsRangeValuePatternAvailablePropertyId),
            Cached<bool>(e, UIA_PROPERTY_ID.UIA_IsScrollPatternAvailablePropertyId),
            Cached<bool>(e, UIA_PROPERTY_ID.UIA_IsTextPatternAvailablePropertyId),
            Cached<bool>(e, UIA_PROPERTY_ID.UIA_IsValuePatternAvailablePropertyId));
        var password = Cached<bool>(e, UIA_PROPERTY_ID.UIA_IsPasswordPropertyId);
        object? value = null;
        var readOnly = false;
        var settable = false;
        if (patterns.Value)
        {
            var text = password ? null : Cached<string>(e, UIA_PROPERTY_ID.UIA_ValueValuePropertyId);
            if (text != null) value = text;
            readOnly = Cached<bool>(e, UIA_PROPERTY_ID.UIA_ValueIsReadOnlyPropertyId);
            settable = !readOnly;
        }
        else if (patterns.Range)
        {
            var number = Cached<double>(e, UIA_PROPERTY_ID.UIA_RangeValueValuePropertyId);
            if (double.IsFinite(number)) value = number;
            readOnly = Cached<bool>(e, UIA_PROPERTY_ID.UIA_RangeValueIsReadOnlyPropertyId);
            settable = !readOnly;
        }
        else if (patterns.Toggle)
        {
            var state = Cached<int>(e, UIA_PROPERTY_ID.UIA_ToggleToggleStatePropertyId);
            value = state switch { 1 => 1.0, 2 => 2.0, _ => 0.0 }; // On=1, Indeterminate=2 like macOS "mixed"
        }
        bool? selected = patterns.Selection ? Cached<bool>(e, UIA_PROPERTY_ID.UIA_SelectionItemIsSelectedPropertyId) : null;
        var focusable = Cached<bool>(e, UIA_PROPERTY_ID.UIA_IsKeyboardFocusablePropertyId);
        var isWebDocument = controlType == 50030 && chromium;
        var web = inWeb || isWebDocument;
        var editable = !readOnly && focusable && !password && (controlType == 50004 || (controlType == 50030 && !chromium && (patterns.Value || patterns.Text)));
        if (controlType == 50004 && !patterns.Value && !patterns.Text) editable = false;
        var actions = new List<string>();
        if (patterns.Invoke || patterns.Toggle || patterns.Selection || patterns.Expand) actions.Add("AXPress");
        if (patterns.Range && !readOnly) { actions.Add("AXIncrement"); actions.Add("AXDecrement"); }
        if (controlType is 50004 or 50030 or 50007 or 50024 or 50029 or 50019 && !isWebDocument) actions.Add("AXShowMenu");
        var visible = local is { } l ? !l.IsEmpty && clip.Intersects(l) && !offscreen : true;
        return new UiaNode
        {
            Ref = reference, Identity = identity, El = e, ParentIndex = parentIndex < 0 ? null : parentIndex, Depth = depth,
            Role = UiaRoles.Role(controlType, web, chromium), Label = label, Value = value, Actions = actions, Settable = settable,
            Editable = editable, Focused = Cached<bool>(e, UIA_PROPERTY_ID.UIA_HasKeyboardFocusPropertyId),
            Enabled = Cached<bool>(e, UIA_PROPERTY_ID.UIA_IsEnabledPropertyId), Selected = selected, Frame = local, Visible = visible,
            Web = web, ControlType = controlType, ClassName = Cached<string>(e, UIA_PROPERTY_ID.UIA_ClassNamePropertyId) ?? "",
            NativeHwnd = (nint)Cached<int>(e, UIA_PROPERTY_ID.UIA_NativeWindowHandlePropertyId), Focusable = focusable, ReadOnly = readOnly,
            Patterns = patterns,
        };
    }

    // ---- exposure / refs ---------------------------------------------------------------------------------------------

    public void Publish(IEnumerable<UiaNode> nodes, WindowKey key)
    {
        if (!exposed.TryGetValue(key, out var map)) exposed[key] = map = new Dictionary<string, Exposure>();
        foreach (var node in nodes)
        {
            if (map.TryGetValue(node.Ref, out var existing)) existing.Actions.UnionWith(node.Actions);
            else map[node.Ref] = new Exposure { Identity = node.Identity, Actions = new HashSet<string>(node.Actions) };
        }
    }

    public bool Offered(string action, string reference, WindowKey key) =>
        exposed.GetValueOrDefault(key)?.GetValueOrDefault(reference)?.Actions.Contains(action) == true;

    public UiaNode Resolve(string reference, UiaTree tree, WindowInfo win)
    {
        var prior = exposed.GetValueOrDefault(win.Key)?.GetValueOrDefault(reference);
        if (prior == null || tree.Root == null) throw new HelperError("stale_element");
        var current = tree.Nodes.FirstOrDefault(n => n.Ref == reference && n.Identity == prior.Identity);
        return current ?? throw new HelperError("stale_element");
    }

    public void Prune(HashSet<WindowKey> alive)
    {
        foreach (var key in identities.Keys.Where(k => !alive.Contains(k)).ToList()) identities.Remove(key);
        foreach (var key in exposed.Keys.Where(k => !alive.Contains(k)).ToList()) exposed.Remove(key);
    }

    // ---- value / text readback --------------------------------------------------------------------------------------

    /// <summary>Current text of an element: ValuePattern value, else TextPattern document text.</summary>
    public static string? ReadText(IUIAutomationElement element)
    {
        var value = Current<string>(element, UIA_PROPERTY_ID.UIA_ValueValuePropertyId);
        if (value != null) return value;
        try
        {
            if (element.GetCurrentPattern(UIA_PATTERN_ID.UIA_TextPatternId) is IUIAutomationTextPattern text)
                return BstrText(text.DocumentRange.GetText(2_000_000));
        }
        catch { }
        return null;
    }

    public static string? BstrText(BSTR value)
    {
        unsafe
        {
            if (value.Value == null) return null;
            var s = Marshal.PtrToStringBSTR((nint)value.Value);
            Marshal.FreeBSTR((nint)value.Value);
            return s;
        }
    }

    public static BSTR NewBstr(string s)
    {
        unsafe { return new BSTR((char*)Marshal.StringToBSTR(s)); }
    }

    public static void FreeBstr(BSTR value)
    {
        unsafe { if (value.Value != null) Marshal.FreeBSTR((nint)value.Value); }
    }
}
