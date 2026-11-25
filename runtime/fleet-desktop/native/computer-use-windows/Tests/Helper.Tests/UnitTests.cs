using System.Text;
using System.Text.Json.Nodes;
using FleetComputerUse.Helper;
using Xunit;

namespace FleetComputerUse.Helper.Tests;

public class JsonTests
{
    [Fact]
    public void SerializesKeysInOrdinalOrderAndTypes()
    {
        var text = Json.SerializeString(new Obj(("b", 1), ("a", "x"), ("c", new List<object?> { true, null, 1.5 }), ("d", new Obj(("z", 0.0), ("y", 2u)))));
        Assert.Equal("{\"a\":\"x\",\"b\":1,\"c\":[true,null,1.5],\"d\":{\"y\":2,\"z\":0}}", text);
    }

    [Fact]
    public void NonFiniteNumbersBecomeNull() => Assert.Equal("[null]", Json.SerializeString(new List<object?> { double.NaN }));

    [Fact]
    public void KeepsNonAsciiText() => Assert.Equal("\"한글✓\"", Json.SerializeString("한글✓"));

    [Fact]
    public void EpochSecondsRoundTripExactly()
    {
        var started = 1764000000.123456;
        var parsed = Json.ParseObject(Json.Serialize(new Obj(("t", started))))!;
        Assert.Equal(started, Json.Number(parsed["t"]));
    }

    [Fact]
    public void NumberRejectsBooleansAndStrings()
    {
        var o = Json.ParseObject("{\"a\":true,\"b\":\"1\",\"c\":2,\"d\":null}"u8)!;
        Assert.Null(Json.Number(o["a"]));
        Assert.Null(Json.Number(o["b"]));
        Assert.Equal(2, Json.Number(o["c"]));
        Assert.Null(Json.Number(o["d"]));
        Assert.True(Json.Bool(o["a"]));
        Assert.Null(Json.Bool(o["c"]));
    }
}

public class ParamsTests
{
    private static JsonObject Obj(string json) => Json.ParseObject(Encoding.UTF8.GetBytes(json))!;

    [Fact]
    public void RejectsUnexpectedKeys()
    {
        var e = Assert.Throws<HelperError>(() => Params.ValidateKeys(Obj("{\"pid\":1,\"zzz\":2}"), Params.Keys("pid")));
        Assert.Equal("invalid_params", e.Code);
    }

    [Theory]
    [InlineData("e1", true)]
    [InlineData("e123456789", true)]
    [InlineData("e", false)]
    [InlineData("x1", false)]
    [InlineData("e1a", false)]
    public void RefShape(string value, bool valid) => Assert.Equal(valid, Params.IsRef(value));

    [Fact]
    public void RefLongerThan24IsInvalid() =>
        Assert.Throws<HelperError>(() => Params.OptionalRef(JsonValue.Create("e" + new string('1', 24))));

    [Fact]
    public void BoundedIntRules()
    {
        Assert.Equal(7, Params.BoundedInt(JsonValue.Create(7), "n", 0, 1, 10));
        Assert.Equal(3, Params.BoundedInt(null, "n", 3, 1, 10));
        Assert.Throws<HelperError>(() => Params.BoundedInt(JsonValue.Create(11), "n", 0, 1, 10));
        Assert.Throws<HelperError>(() => Params.BoundedInt(JsonValue.Create(1.5), "n", 0, 1, 10));
        Assert.Throws<HelperError>(() => Params.BoundedInt(JsonValue.Create(true), "n", 0, 1, 10));
        Assert.Throws<HelperError>(() => Params.BoundedInt(JsonValue.Create("2"), "n", 0, 1, 10));
    }

    [Fact]
    public void OptionalStringCountsTextElements()
    {
        Assert.Equal(new string('가', 5), Params.OptionalString(JsonValue.Create(new string('가', 5)), "t", 5));
        Assert.Throws<HelperError>(() => Params.OptionalString(JsonValue.Create(new string('a', 6)), "t", 5));
        Assert.Throws<HelperError>(() => Params.OptionalString(JsonValue.Create(3), "t", 5));
    }
}

public class KeyStrokeTests
{
    [Theory]
    [InlineData("cmd+v", 'V', true, false, false)]
    [InlineData("command+c", 'C', true, false, false)]
    [InlineData("ctrl+a", 'A', true, false, false)]
    [InlineData("control+shift+z", 'Z', true, false, true)]
    [InlineData("alt+f4", (char)0x73, false, true, false)]
    [InlineData("option+tab", (char)9, false, true, false)]
    [InlineData("shift+1", '1', false, false, true)]
    public void ParsesChords(string spec, char vk, bool ctrl, bool alt, bool shift)
    {
        var key = new KeyStroke(spec);
        Assert.Equal(vk, (char)key.Vk);
        Assert.Equal((ctrl, alt, shift), (key.Ctrl, key.Alt, key.Shift));
    }

    [Theory]
    [InlineData("enter", 0x0D)]
    [InlineData("Return", 0x0D)]
    [InlineData("esc", 0x1B)]
    [InlineData("backspace", 0x08)]
    [InlineData("delete", 0x2E)]
    [InlineData("pagedown", 0x22)]
    [InlineData("f12", 0x7B)]
    [InlineData("space", 0x20)]
    public void NamedKeys(string spec, int vk) => Assert.Equal(vk, new KeyStroke(spec).Vk);

    [Fact]
    public void ArrowsAreExtendedKeys()
    {
        Assert.True(new KeyStroke("left").Extended);
        Assert.True(new KeyStroke("end").Extended);
        Assert.False(new KeyStroke("enter").Extended);
    }

    [Theory]
    [InlineData("win+r")]
    [InlineData("meta+a")]
    [InlineData("super+a")]
    [InlineData("cmd+ctrl+a")]
    [InlineData("shift+shift+a")]
    [InlineData("ctrl+")]
    [InlineData("")]
    [InlineData("ctrl+nosuchkey")]
    public void RejectsInvalidKeys(string spec) => Assert.Equal("invalid_key", Assert.Throws<HelperError>(() => new KeyStroke(spec)).Code);

    [Theory]
    [InlineData("a")]
    [InlineData("9")]
    public void BareCharacterIsTextNotKey(string spec) => Assert.Equal("text_via_key", Assert.Throws<HelperError>(() => new KeyStroke(spec)).Code);

    [Fact]
    public void PasteAndSelectAllDetection()
    {
        Assert.True(new KeyStroke("cmd+v").Paste);
        Assert.True(new KeyStroke("ctrl+v").Paste);
        Assert.False(new KeyStroke("ctrl+shift+v").Paste);
        Assert.True(new KeyStroke("cmd+a").SelectAll);
        Assert.False(new KeyStroke("alt+a").SelectAll);
    }
}

public class ActionRequestTests
{
    private static JsonObject Obj(string json) => Json.ParseObject(Encoding.UTF8.GetBytes(json))!;
    private static string Code(string json) => Assert.Throws<HelperError>(() => new ActionRequest(Obj(json))).Code;

    [Fact]
    public void ClickNeedsRefOrPoint() => Assert.Equal("invalid_params", Code("{\"action\":\"click\"}"));

    [Fact]
    public void RefAndPointAreExclusive() => Assert.Equal("invalid_params", Code("{\"action\":\"click\",\"ref\":\"e1\",\"x\":1,\"y\":2}"));

    [Fact]
    public void TypeNeedsNonEmptyText()
    {
        Assert.Equal("invalid_params", Code("{\"action\":\"type\"}"));
        Assert.Equal("invalid_params", Code("{\"action\":\"type\",\"text\":\"\"}"));
        Assert.Equal("한글", new ActionRequest(Obj("{\"action\":\"type\",\"text\":\"한글\"}")).Text);
    }

    [Fact]
    public void SetValueAllowsEmptyTextButNeedsRef()
    {
        Assert.Equal("invalid_params", Code("{\"action\":\"set_value\",\"text\":\"\"}"));
        Assert.Equal("", new ActionRequest(Obj("{\"action\":\"set_value\",\"ref\":\"e2\",\"text\":\"\"}")).Text);
    }

    [Fact]
    public void KeyRules()
    {
        Assert.Equal("invalid_key", Code("{\"action\":\"key\",\"key\":\"win+r\"}"));
        Assert.Equal("text_via_key", Code("{\"action\":\"key\",\"key\":\"a\"}"));
        Assert.Equal("invalid_params", Code("{\"action\":\"key\",\"key\":\"ctrl+a\",\"requireEditableFocus\":true}"));
        Assert.Equal("invalid_params", Code("{\"action\":\"key\",\"key\":\"cmd+v\",\"text\":\"x\"}"));
        var paste = new ActionRequest(Obj("{\"action\":\"key\",\"key\":\"cmd+v\",\"requireEditableFocus\":true,\"text\":\"x\"}"));
        Assert.True(paste.RequireEditableFocus);
        Assert.True(paste.Stroke!.Paste);
    }

    [Fact]
    public void ScrollDirectionAndPages()
    {
        Assert.Equal("invalid_params", Code("{\"action\":\"scroll\",\"x\":1,\"y\":1,\"direction\":\"sideways\"}"));
        Assert.Equal("invalid_params", Code("{\"action\":\"scroll\",\"x\":1,\"y\":1,\"direction\":\"up\",\"pages\":11}"));
        Assert.Equal("invalid_params", Code("{\"action\":\"scroll\",\"x\":1,\"y\":1,\"direction\":\"up\",\"pages\":0.05}"));
        Assert.Equal(2.5, new ActionRequest(Obj("{\"action\":\"scroll\",\"x\":1,\"y\":1,\"direction\":\"down\",\"pages\":2.5}")).Pages);
    }

    [Fact]
    public void AxActionNeedsRefAndName()
    {
        Assert.Equal("invalid_params", Code("{\"action\":\"ax_action\",\"name\":\"AXPress\"}"));
        Assert.Equal("invalid_name", Code("{\"action\":\"ax_action\",\"ref\":\"e1\"}"));
    }

    [Fact]
    public void DragNeedsDestination() => Assert.Equal("invalid_params", Code("{\"action\":\"drag\",\"x\":1,\"y\":1}"));

    [Fact]
    public void UnknownActionAndUnknownFieldsAreRejected()
    {
        Assert.Equal("invalid_params", Code("{\"action\":\"hover\"}"));
        Assert.Equal("invalid_params", Code("{\"action\":\"click\",\"x\":1,\"y\":1,\"direction\":\"up\"}"));
    }

    [Fact]
    public void TextLimit() => Assert.Equal("invalid_params", Code("{\"action\":\"type\",\"text\":\"" + new string('a', 20_001) + "\"}"));
}

public class SurfaceTests
{
    [Theory]
    [InlineData("Edit", true)]
    [InlineData("RichEditD2DPT", true)]
    [InlineData("Button", true)]
    [InlineData("#32770", true)]
    [InlineData("WindowsForms10.BUTTON.app.0.1", true)]
    [InlineData("Chrome_RenderWidgetHostHWND", true)]
    [InlineData("Microsoft.UI.Content.DesktopChildSiteBridge", false)]
    [InlineData("InputSiteWindowClass", false)]
    [InlineData("Windows.UI.Core.CoreWindow", false)]
    [InlineData("ApplicationFrameWindow", false)]
    [InlineData("ApplicationFrameInputSinkWindow", false)]
    [InlineData("Windows.UI.Input.InputSite.WindowClass", false)]
    [InlineData("HwndWrapper[App.exe;;1234]", false)]
    [InlineData("", false)]
    public void MessageSurfaceAllowAndDenyLists(string windowClass, bool expected) =>
        Assert.Equal(expected, MessageInput.MessageSurface(windowClass));

    [Theory]
    [InlineData(50000, "AXButton")]
    [InlineData(50004, "AXTextField")]
    [InlineData(50020, "AXStaticText")]
    [InlineData(50011, "AXMenuItem")]
    [InlineData(50002, "AXCheckBox")]
    [InlineData(50015, "AXSlider")]
    [InlineData(99999, "AXUnknown")]
    public void ControlTypesMapToAxRoles(int controlType, string role) => Assert.Equal(role, UiaRoles.Role(controlType, false, false));

    [Fact]
    public void DocumentRoleDependsOnEngine()
    {
        Assert.Equal("AXTextArea", UiaRoles.Role(50030, false, false));
        Assert.Equal("AXWebArea", UiaRoles.Role(50030, true, true));
    }
}

public class GeometryTests
{
    [Fact]
    public void FrameIntersectionAndContainment()
    {
        var a = new Frame(0, 0, 100, 50);
        var b = new Frame(60, 20, 100, 100);
        Assert.Equal(new Frame(60, 20, 40, 30), a.Intersect(b));
        Assert.True(a.Intersects(b));
        Assert.False(a.Intersects(new Frame(100, 0, 10, 10)));
        Assert.True(a.Contains(0, 0));
        Assert.False(a.Contains(100, 10));
        Assert.True(a.Intersect(new Frame(200, 200, 5, 5)).IsEmpty);
        Assert.Equal(50, a.MidX);
    }

    [Fact]
    public void WindowIdIsLowThirtyTwoBitsOfTheHandle()
    {
        Assert.Equal(0x1234ABCDu, Native.IdOf((nint)0x1234ABCD));
        Assert.Equal(0xFFFFFFF0u, Native.IdOf(Native.HwndOf(0xFFFFFFF0u)));
        Assert.Equal((nint)0x1234ABCD, Native.HwndOf(0x1234ABCDu));
    }

    [Fact]
    public void FileTimeConvertsToEpochSeconds() => Assert.Equal(0, Native.FileTimeToEpochSeconds(116444736000000000L));
}

public class ClipboardFormatTests
{
    [Fact]
    public void HtmlFormatHasConsistentOffsets()
    {
        var bytes = ClipboardLease.HtmlFormat("<b>한글</b>");
        var text = Encoding.UTF8.GetString(bytes);
        int Field(string name) => int.Parse(text.Split(name + ":")[1][..10]);
        var startHtml = Field("StartHTML");
        var endHtml = Field("EndHTML");
        var startFragment = Field("StartFragment");
        var endFragment = Field("EndFragment");
        Assert.Equal("<html>", Encoding.UTF8.GetString(bytes, startHtml, 6));
        Assert.Equal("<b>한글</b>", Encoding.UTF8.GetString(bytes, startFragment, endFragment - startFragment));
        Assert.Equal("</html>", Encoding.UTF8.GetString(bytes, endHtml - 7, 7));
    }
}

public class FocusScopeTests
{
    private const uint WS_CHILD = 0x40000000, WS_POPUP = 0x80000000;

    [Fact]
    public void KeyboardFocusCountsOnlyInsideTheTargetOrWindowsItOwns()
    {
        // Codex P1 (PR #2788): an unrelated top-level window of the same process and thread must not receive the target's keys.
        var target = Native.CreateWindowEx(0, "STATIC", "target", 0, 0, 0, 100, 100, 0, 0, 0, 0);
        var sibling = Native.CreateWindowEx(0, "STATIC", "sibling", 0, 0, 0, 100, 100, 0, 0, 0, 0);
        var child = Native.CreateWindowEx(0, "STATIC", "child", WS_CHILD, 0, 0, 10, 10, target, 0, 0, 0);
        var popup = Native.CreateWindowEx(0, "STATIC", "menu popup", WS_POPUP, 0, 0, 10, 10, target, 0, 0, 0);
        var siblingChild = Native.CreateWindowEx(0, "STATIC", "sibling child", WS_CHILD, 0, 0, 10, 10, sibling, 0, 0, 0);
        try
        {
            Assert.All(new[] { target, sibling, child, popup, siblingChild }, h => Assert.NotEqual(0, h));
            Assert.True(MessageInput.BelongsToWindow(target, target));
            Assert.True(MessageInput.BelongsToWindow(child, target));
            Assert.True(MessageInput.BelongsToWindow(popup, target));
            Assert.False(MessageInput.BelongsToWindow(sibling, target));
            Assert.False(MessageInput.BelongsToWindow(siblingChild, target));
        }
        finally
        {
            foreach (var h in new[] { siblingChild, popup, child, sibling, target }) if (h != 0) Native.DestroyWindow(h);
        }
    }
}
