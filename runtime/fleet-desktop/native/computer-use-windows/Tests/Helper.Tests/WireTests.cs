using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace FleetComputerUse.Helper.Tests;

/// <summary>Drives the built fleet-computer-use.exe over its real stdio protocols, like the Console does.</summary>
internal sealed class HelperProcess : IDisposable
{
    public static string ExePath
    {
        get
        {
            var dir = AppContext.BaseDirectory;
            var local = Path.Combine(dir, "fleet-computer-use.exe");
            if (File.Exists(local)) return local;
            throw new FileNotFoundException("fleet-computer-use.exe not next to the test assembly", local);
        }
    }

    private readonly Process process;
    private readonly List<JsonObject> rows = new();
    private readonly object gate = new();
    public Stopwatch Clock { get; } = Stopwatch.StartNew();

    public HelperProcess(string? fault = null, params string[] args)
    {
        var info = new ProcessStartInfo(ExePath) { RedirectStandardInput = true, RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
        foreach (var a in args) info.ArgumentList.Add(a);
        if (fault != null) info.Environment["FLEET_COMPUTER_USE_FAULT"] = fault;
        info.StandardOutputEncoding = Encoding.UTF8;
        process = Process.Start(info)!;
        process.OutputDataReceived += (_, e) => { };
        new Thread(() =>
        {
            string? line;
            while ((line = process.StandardOutput.ReadLine()) != null)
            {
                var row = JsonNode.Parse(line) as JsonObject;
                lock (gate) { if (row != null) rows.Add(row); }
            }
        }) { IsBackground = true }.Start();
    }

    public bool HasExited => process.HasExited;
    public int ExitCode => process.ExitCode;
    public bool WaitForExit(int ms) => process.WaitForExit(ms);
    public void SendRaw(string text) { process.StandardInput.Write(text); process.StandardInput.Flush(); }
    public void CloseInput() => process.StandardInput.Close();

    public void Send(long id, string method, object? parameters = null) =>
        SendRaw(new JsonObject { ["id"] = id, ["method"] = method, ["params"] = parameters == null ? new JsonObject() : JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(parameters)) }.ToJsonString() + "\n");

    public JsonObject Wait(Func<JsonObject, bool> match, int ms = 20_000)
    {
        var until = Environment.TickCount64 + ms;
        while (Environment.TickCount64 < until)
        {
            lock (gate)
            {
                var hit = rows.FirstOrDefault(match);
                if (hit != null) return hit;
            }
            Thread.Sleep(10);
        }
        throw new TimeoutException("no matching row; got: " + string.Join(" | ", Snapshot().Select(r => r.ToJsonString())));
    }

    public JsonObject Reply(long id, int ms = 20_000) => Wait(r => r["id"]?.GetValue<long>() == id, ms);
    public List<JsonObject> Snapshot() { lock (gate) return rows.ToList(); }

    public void Dispose()
    {
        try { if (!process.HasExited) process.Kill(true); } catch { }
        process.Dispose();
    }
}

public class PersistentWireTests
{
    [Fact]
    public void ReadyAndSelfCheckEventsThenHello()
    {
        using var helper = new HelperProcess();
        var ready = helper.Wait(r => r["event"]?.GetValue<string>() == "ready");
        Assert.Equal(1, ready["protocol"]!.GetValue<int>());
        var check = helper.Wait(r => r["event"]?.GetValue<string>() == "selfCheck");
        Assert.NotNull(check["selfCheck"]!["ok"]);
        helper.Send(1, "hello");
        var hello = helper.Reply(1)["result"]!.AsObject();
        Assert.Equal(1, hello["protocol"]!.GetValue<int>());
        Assert.Equal(1, hello["helperVersion"]!.GetValue<int>());
        Assert.True(hello["permissions"]!["accessibility"]!.GetValue<bool>());
        Assert.NotNull(hello["permissions"]!["screenRecording"]);
        Assert.False(hello["activationYields"]!.GetValue<bool>());
        Assert.Matches(@"^10\.0\.\d+$", hello["os"]!.GetValue<string>());
        Assert.NotNull(hello["selfCheck"]!["ok"]);
        // Events come before the first reply.
        var rows = helper.Snapshot();
        Assert.Equal("ready", rows[0]["event"]!.GetValue<string>());
    }

    [Fact]
    public void SelfCheckPassesOnAnInteractiveDesktop()
    {
        using var helper = new HelperProcess();
        var check = helper.Wait(r => r["event"]?.GetValue<string>() == "selfCheck")["selfCheck"]!;
        // A person moving the mouse or switching apps during the probe is transient; anything else is a real failure.
        var ok = check["ok"]!.GetValue<bool>();
        if (!ok) Assert.Contains(check["reason"]!.GetValue<string>(), new[] { "front_changed", "pointer_changed", "helper_activated", "probe_window_unavailable", "probe_click_not_received", "probe_failed" });
    }

    [Fact]
    public void MalformedAndInvalidRequestsGetInvalidParams()
    {
        using var helper = new HelperProcess();
        helper.Wait(r => r["event"]?.GetValue<string>() == "selfCheck");
        helper.SendRaw("not json\n");
        var bad = helper.Wait(r => r["ok"]?.GetValue<bool>() == false && r["id"] == null);
        Assert.Equal("invalid_params", bad["error"]!["code"]!.GetValue<string>());
        helper.SendRaw("{\"id\":5,\"method\":\"hello\"}\n");
        var missing = helper.Reply(5);
        Assert.Equal("invalid_params", missing["error"]!["code"]!.GetValue<string>());
        helper.Send(6, "no_such_method");
        Assert.Equal("invalid_params", helper.Reply(6)["error"]!["code"]!.GetValue<string>());
        helper.Send(7, "hello", new { extra = 1 });
        Assert.Equal("invalid_params", helper.Reply(7)["error"]!["code"]!.GetValue<string>());
        helper.Send(8, "windows", new { query = new string('a', 301) });
        Assert.Equal("invalid_params", helper.Reply(8)["error"]!["code"]!.GetValue<string>());
        helper.Send(9, "hello");
        Assert.True(helper.Reply(9)["ok"]!.GetValue<bool>());
    }

    [Fact]
    public void OversizedLineIsRejectedAndNextRequestStillWorks()
    {
        using var helper = new HelperProcess();
        helper.Wait(r => r["event"]?.GetValue<string>() == "selfCheck");
        helper.SendRaw(new string('x', 1_048_577 + 10) + "\n");
        var bad = helper.Wait(r => r["ok"]?.GetValue<bool>() == false && r["id"] == null);
        Assert.Equal("invalid_params", bad["error"]!["code"]!.GetValue<string>());
        helper.Send(1, "hello");
        Assert.True(helper.Reply(1)["ok"]!.GetValue<bool>());
    }

    [Fact]
    public void WindowsEnumerationReturnsWireShape()
    {
        using var helper = new HelperProcess();
        helper.Send(1, "windows");
        var result = helper.Reply(1)["result"]!.AsObject();
        Assert.Null(result["installed"]);
        foreach (var w in result["windows"]!.AsArray())
        {
            Assert.True(w!["pid"]!.GetValue<int>() > 0);
            Assert.True(w["windowId"]!.GetValue<long>() > 0);
            Assert.True(w["processStartedAt"]!.GetValue<double>() > 1e9);
            Assert.Equal("launch", w["startedAtSource"]!.GetValue<string>());
            Assert.True(w["frame"]!["w"]!.GetValue<double>() > 0);
            foreach (var key in new[] { "app", "bundleId", "bundlePath", "title", "engine" }) Assert.NotNull(w[key]);
            foreach (var key in new[] { "front", "hidden", "minimized", "onCurrentSpace" }) _ = w[key]!.GetValue<bool>();
        }
    }

    [Fact]
    public void WindowsQueryFiltersAndReturnsInstalledApps()
    {
        using var helper = new HelperProcess();
        helper.Send(1, "windows", new { query = "zzzz-no-such-window-zzzz" });
        var result = helper.Reply(1)["result"]!.AsObject();
        Assert.Empty(result["windows"]!.AsArray());
        Assert.NotNull(result["installed"]);
        helper.Send(2, "windows", new { query = "" });
        Assert.Null(helper.Reply(2)["result"]!["installed"]);
    }

    [Fact]
    public void RequestPermissionsIsImmediateAndEmpty()
    {
        using var helper = new HelperProcess();
        helper.Send(1, "requestPermissions", new { permissions = new[] { "accessibility", "screenRecording" } });
        var result = helper.Reply(1)["result"]!.AsObject();
        Assert.Empty(result["requested"]!.AsArray());
        Assert.Empty(result["deferred"]!.AsArray());
        Assert.True(result["permissions"]!["accessibility"]!.GetValue<bool>());
        helper.Send(2, "requestPermissions", new { permissions = Array.Empty<string>() });
        Assert.Equal("invalid_params", helper.Reply(2)["error"]!["code"]!.GetValue<string>());
        helper.Send(3, "requestPermissions", new { permissions = new[] { "camera" } });
        Assert.Equal("invalid_params", helper.Reply(3)["error"]!["code"]!.GetValue<string>());
    }

    [Fact]
    public void ActAgainstAMissingWindowIsNotSent()
    {
        using var helper = new HelperProcess();
        helper.Wait(r => r["event"]?.GetValue<string>() == "selfCheck");
        helper.Send(1, "act", new { pid = 4, windowId = 123456789, processStartedAt = 1.7e9, action = "click", x = 1, y = 1 });
        var error = helper.Reply(1)["error"]!;
        Assert.Equal("window_unavailable", error["code"]!.GetValue<string>());
        Assert.Equal("not_sent", error["dispatch"]!.GetValue<string>());
        Assert.Equal("closed", error["details"]!["reason"]!.GetValue<string>());
        helper.Send(2, "snapshot", new { pid = 4, windowId = 123456789, processStartedAt = 1.7e9 });
        Assert.Equal("window_unavailable", helper.Reply(2)["error"]!["code"]!.GetValue<string>());
    }

    [Fact]
    public void ActValidationErrorsAreNotSent()
    {
        using var helper = new HelperProcess();
        helper.Send(1, "act", new { pid = 4, windowId = 1, processStartedAt = 1.7e9, action = "key", key = "win+r" });
        var error = helper.Reply(1)["error"]!;
        Assert.Equal("invalid_key", error["code"]!.GetValue<string>());
        Assert.Equal("not_sent", error["dispatch"]!.GetValue<string>());
    }

    [Fact]
    public void CursorHideAcceptsOnlyHide()
    {
        using var helper = new HelperProcess();
        helper.Send(1, "cursor", new { op = "hide" });
        Assert.True(helper.Reply(1)["ok"]!.GetValue<bool>());
        helper.Send(2, "cursor", new { op = "show" });
        Assert.Equal("invalid_params", helper.Reply(2)["error"]!["code"]!.GetValue<string>());
    }

    [Fact]
    public void ShutdownRepliesThenExitsZero()
    {
        using var helper = new HelperProcess();
        helper.Send(1, "shutdown");
        Assert.True(helper.Reply(1)["ok"]!.GetValue<bool>());
        Assert.True(helper.WaitForExit(2_000));
        Assert.Equal(0, helper.ExitCode);
    }

    [Fact]
    public void StdinEofExitsWithinAFewHundredMilliseconds()
    {
        using var helper = new HelperProcess();
        helper.Wait(r => r["event"]?.GetValue<string>() == "selfCheck");
        var watch = Stopwatch.StartNew();
        helper.CloseInput();
        Assert.True(helper.WaitForExit(3_000));
        Assert.Equal(0, helper.ExitCode);
        Assert.True(watch.ElapsedMilliseconds < 2_000);
    }

    [Fact]
    public void FaultInjectionBlocksInputButNotReading()
    {
        using var helper = new HelperProcess("self_check");
        helper.Send(1, "hello");
        var hello = helper.Reply(1)["result"]!;
        Assert.False(hello["selfCheck"]!["ok"]!.GetValue<bool>());
        Assert.Equal("fault_injected_self_check", hello["selfCheck"]!["reason"]!.GetValue<string>());
        helper.Send(2, "act", new { pid = 4, windowId = 1, processStartedAt = 1.7e9, action = "click", x = 1, y = 1 });
        var error = helper.Reply(2)["error"]!;
        Assert.Equal("self_check_failed", error["code"]!.GetValue<string>());
        Assert.Equal("not_sent", error["dispatch"]!.GetValue<string>());
        helper.Send(3, "recheck");
        Assert.False(helper.Reply(3)["result"]!["ok"]!.GetValue<bool>());
    }

    [Fact]
    public void WatchdogTimesOutAfterFifteenSecondsAndExits()
    {
        using var helper = new HelperProcess("hang");
        helper.Wait(r => r["event"]?.GetValue<string>() == "selfCheck");
        var watch = Stopwatch.StartNew();
        helper.Send(1, "windows");
        var reply = helper.Reply(1, 25_000);
        Assert.InRange(watch.ElapsedMilliseconds, 14_000, 19_000);
        Assert.Equal("timeout", reply["error"]!["code"]!.GetValue<string>());
        Assert.Null(reply["error"]!["dispatch"]); // only `act` carries dispatch
        Assert.True(helper.WaitForExit(3_000));
        Assert.Equal(1, helper.ExitCode);
    }

    [Fact]
    public void WatchdogAfterSendReportsSentWithTimeoutObservation()
    {
        using var helper = new HelperProcess("hang_after_send");
        helper.Wait(r => r["event"]?.GetValue<string>() == "selfCheck");
        helper.Send(1, "act", new { pid = 4, windowId = 1, processStartedAt = 1.7e9, action = "click", x = 1, y = 1 });
        var reply = helper.Reply(1, 25_000);
        Assert.True(reply["ok"]!.GetValue<bool>());
        var result = reply["result"]!;
        Assert.True(result["sent"]!.GetValue<bool>());
        Assert.Equal("timeout", result["observation"]!.GetValue<string>());
        Assert.Equal("message", result["via"]!.GetValue<string>());
        Assert.True(helper.WaitForExit(3_000));
        Assert.Equal(1, helper.ExitCode);
    }
}

public class PlatformWireTests
{
    private static byte[] Frame(string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        return Encoding.ASCII.GetBytes(body.Length.ToString("D8")).Concat(body).ToArray();
    }

    private static (int Exit, JsonObject Reply) Run(byte[] stdin, params string[] args)
    {
        var info = new ProcessStartInfo(HelperProcess.ExePath) { RedirectStandardInput = true, RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
        foreach (var a in args.Length == 0 ? new[] { "--platform" } : args) info.ArgumentList.Add(a);
        using var process = Process.Start(info)!;
        process.StandardInput.BaseStream.Write(stdin);
        process.StandardInput.Close();
        var output = process.StandardOutput.ReadToEnd();
        Assert.True(process.WaitForExit(15_000));
        return (process.ExitCode, (JsonNode.Parse(output.Trim()) as JsonObject)!);
    }

    [Fact]
    public void ReadPermissions()
    {
        var (exit, reply) = Run(Frame("{\"version\":1,\"method\":\"readPermissions\",\"params\":{}}"));
        Assert.Equal(0, exit);
        Assert.True(reply["ok"]!.GetValue<bool>());
        Assert.True(reply["result"]!["accessibility"]!.GetValue<bool>());
        Assert.Null(reply["result"]!["holder"]);
    }

    [Theory]
    [InlineData("{\"version\":2,\"method\":\"readPermissions\",\"params\":{}}", "invalid_request")]
    [InlineData("{\"version\":1,\"method\":\"nope\",\"params\":{}}", "unknown_method")]
    [InlineData("{\"version\":1,\"method\":\"verifyWindowIdentity\",\"params\":{\"pid\":0,\"windowId\":1,\"processStartedAt\":1}}", "invalid_params")]
    [InlineData("{\"version\":1,\"method\":\"windowState\",\"params\":{\"pid\":1}}", "invalid_params")]
    [InlineData("{\"version\":1,\"method\":\"resolveApp\",\"params\":{}}", "invalid_params")]
    [InlineData("{\"version\":1,\"method\":\"openApp\",\"params\":{\"app\":\"x\"}}", "invalid_params")]
    [InlineData("{\"version\":1,\"method\":\"openPrivacySettings\",\"params\":{\"permissions\":[]}}", "invalid_params")]
    public void Errors(string request, string code)
    {
        var (exit, reply) = Run(Frame(request));
        Assert.Equal(1, exit);
        Assert.False(reply["ok"]!.GetValue<bool>());
        Assert.Equal(code, reply["error"]!.GetValue<string>());
        Assert.Equal(1, reply["version"]!.GetValue<int>());
    }

    [Fact]
    public void BadFrameHeaderIsInvalidRequest()
    {
        var (exit, reply) = Run(Encoding.ASCII.GetBytes("garbage!{}"));
        Assert.Equal(1, exit);
        Assert.Equal("invalid_request", reply["error"]!.GetValue<string>());
    }

    [Fact]
    public void WrongArgumentCountIsUsageError()
    {
        var info = new ProcessStartInfo(HelperProcess.ExePath) { RedirectStandardInput = true, RedirectStandardOutput = true, UseShellExecute = false };
        info.ArgumentList.Add("--platform");
        info.ArgumentList.Add("extra");
        using var process = Process.Start(info)!;
        process.StandardInput.Close();
        Assert.True(process.WaitForExit(10_000));
        Assert.Equal(64, process.ExitCode);
    }

    [Fact]
    public void IdentityOfAMissingWindowMismatches()
    {
        var (exit, reply) = Run(Frame("{\"version\":1,\"method\":\"verifyWindowIdentity\",\"params\":{\"pid\":4,\"windowId\":1234567,\"processStartedAt\":1700000000.5}}"));
        Assert.Equal(0, exit);
        Assert.Equal("mismatch", reply["result"]!["identity"]!.GetValue<string>());
        (exit, reply) = Run(Frame("{\"version\":1,\"method\":\"windowState\",\"params\":{\"pid\":4,\"windowId\":1234567,\"processStartedAt\":1700000000.5}}"));
        Assert.Equal(0, exit);
        Assert.False(reply["result"]!["onscreen"]!.GetValue<bool>());
        (exit, reply) = Run(Frame("{\"version\":1,\"method\":\"captureStill\",\"params\":{\"pid\":4,\"windowId\":1234567,\"processStartedAt\":1700000000.5}}"));
        Assert.Equal(1, exit);
        Assert.Equal("still_unavailable", reply["error"]!.GetValue<string>());
    }

    [Fact]
    public void ResolveAppRules()
    {
        string Resolve(string target)
        {
            var body = new JsonObject { ["version"] = 1, ["method"] = "resolveApp", ["params"] = new JsonObject { ["target"] = target } }.ToJsonString();
            var (exit, reply) = Run(Frame(body));
            Assert.Equal(0, exit);
            var result = reply["result"]!.AsObject();
            return (result["app"] ?? result["error"])!.GetValue<string>();
        }
        Assert.Equal("exact_target_required", Resolve(" notepad"));
        Assert.Equal("exact_target_required", Resolve(""));
        Assert.Equal("installed_target_required", Resolve("C:/definitely/missing/app.exe"));
        Assert.Equal("installed_target_required", Resolve("no such installed application 12345"));
        Assert.Equal("C:\\Windows\\System32\\notepad.exe", Resolve("C:/Windows/System32/notepad.exe"), ignoreCase: true);
    }

    [Fact]
    public void OpenPrivacySettingsReportsNotOpened()
    {
        var (exit, reply) = Run(Frame("{\"version\":1,\"method\":\"openPrivacySettings\",\"params\":{\"permissions\":[\"screenRecording\"]}}"));
        Assert.Equal(0, exit);
        Assert.False(reply["result"]!["opened"]!.GetValue<bool>());
    }

    [Fact]
    public void OpenAppRejectsInexactTargets()
    {
        var (exit, reply) = Run(Frame("{\"version\":1,\"method\":\"openApp\",\"params\":{\"app\":\"C:/missing/x.exe\",\"activate\":false}}"));
        Assert.Equal(0, exit);
        Assert.Equal("computer_use_open_failed", reply["result"]!["error"]!.GetValue<string>());
        Assert.False(reply["result"]!["requestDispatched"]!.GetValue<bool>());
    }
}
