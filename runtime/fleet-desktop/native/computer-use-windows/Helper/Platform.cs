using System.Diagnostics;
using System.Text.Json.Nodes;
using static FleetComputerUse.Helper.Native;

namespace FleetComputerUse.Helper;

/// <summary>
/// One bounded frame on stdin (8 ASCII decimal digits followed by UTF-8 JSON) and a small newline-terminated reply on stdout.
/// stdin is polled with PeekNamedPipe so deadlines hold on a blocking pipe; an input frame is never echoed.
/// </summary>
internal sealed unsafe class PlatformPipe
{
    public const int Version = 1;
    private readonly nint stdin = GetStdHandle(-10);
    private readonly Stream input = Console.OpenStandardInput();
    private readonly Func<bool> interrupted;

    public PlatformPipe(Func<bool>? interrupted = null) { this.interrupted = interrupted ?? (() => false); }

    /// <summary>Bytes ready to read; 0 when idle; -1 on EOF/hangup or when the pipe state cannot be established.</summary>
    private int Available()
    {
        uint available = 0;
        return PeekNamedPipe(stdin, null, 0, null, &available, null) ? (int)Math.Min(available, int.MaxValue) : -1;
    }

    /// <summary>True when a read would complete (data or hangup) before the deadline.</summary>
    public bool CanRead(Stopwatch clock, int deadlineMs)
    {
        while (!interrupted())
        {
            if (clock.ElapsedMilliseconds >= deadlineMs) return false;
            if (Available() != 0) return true;
            Thread.Sleep(5);
        }
        return false;
    }

    /// <summary>Fail closed: any extra input, EOF, or unknown pipe state counts as "the caller is done".</summary>
    public bool HasExtraInputOrEof() => Available() != 0;

    private byte[]? Read(int count, Stopwatch clock, int deadlineMs)
    {
        var bytes = new byte[count];
        var offset = 0;
        while (offset < count)
        {
            if (!CanRead(clock, deadlineMs)) return null;
            var ready = Available();
            if (ready <= 0) return null;
            var size = input.Read(bytes, offset, Math.Min(count - offset, ready));
            if (size <= 0) return null;
            offset += size;
        }
        return bytes;
    }

    public byte[]? ReadFrame(int maxBytes, Stopwatch clock, int deadlineMs)
    {
        var header = Read(8, clock, deadlineMs);
        if (header == null || header.Any(b => b is < 48 or > 57)) return null;
        var length = int.Parse(System.Text.Encoding.ASCII.GetString(header), System.Globalization.CultureInfo.InvariantCulture);
        if (length < 1 || length > maxBytes) return null;
        return Read(length, clock, deadlineMs);
    }

    private static readonly Stream Stdout = Console.OpenStandardOutput();

    public static bool Emit(Obj result)
    {
        try
        {
            var data = Json.Serialize(result);
            var output = Stdout;
            output.Write(data, 0, data.Length);
            output.WriteByte(10);
            output.Flush();
            return true;
        }
        catch { return false; }
    }
}

/// <summary>One-shot `--platform` commands: independent of the input helper's hello, self-check and request queue.</summary>
internal static class PlatformCommands
{
    public static int Run()
    {
        var pipe = new PlatformPipe();
        var clock = Stopwatch.StartNew();
        int Fail(string error)
        {
            PlatformPipe.Emit(new Obj(("version", PlatformPipe.Version), ("ok", false), ("error", error)));
            return 1;
        }
        var frame = pipe.ReadFrame(65_536, clock, 3_000);
        var request = frame == null ? null : Json.ParseObject(frame);
        if (request == null || Json.Number(request["version"]) != PlatformPipe.Version || Json.Text(request["method"]) is not { } method) return Fail("invalid_request");
        var parameters = request["params"] as JsonObject;
        Obj result;
        switch (method)
        {
            case "readPermissions":
                result = HelperPermissions.Json();
                break;
            case "verifyWindowIdentity" or "windowState" or "captureStill":
            {
                if (Identity(parameters) is not { } target) return Fail("invalid_params");
                var catalog = new WindowCatalog();
                var state = WindowState(catalog, target, includingHidden: method != "verifyWindowIdentity");
                if (method == "verifyWindowIdentity") result = new Obj(("identity", state.Identity));
                // DWM does not compose a minimized window, so no still exists until it is restored; the preview card says so.
                else if (method == "windowState") result = new Obj(("identity", state.Identity), ("onscreen", state.Onscreen), ("minimized", state.Window?.Minimized == true));
                else
                {
                    if (!WindowCapture.Supported) return Fail("screen_recording_required");
                    if (state.Onscreen || state.Window == null) return Fail("still_unavailable");
                    try
                    {
                        var image = WindowCapture.Capture(state.Window, 480, CancellationToken.None);
                        var recheck = WindowState(catalog, target, includingHidden: true);
                        if (recheck.Onscreen || recheck.Window == null || recheck.Window.Frame != state.Window.Frame) return Fail("still_unavailable");
                        result = image.ToJson();
                    }
                    catch { return Fail("still_unavailable"); }
                }
                break;
            }
            case "resolveApp":
            {
                if (parameters == null || Json.Text(parameters["target"]) is not { } target) return Fail("invalid_params");
                result = AppLauncher.Resolve(target);
                break;
            }
            case "openApp":
            {
                if (parameters == null || Json.Text(parameters["app"]) is not { } app || Json.Bool(parameters["activate"]) is not { } activate) return Fail("invalid_params");
                result = AppLauncher.Open(app, activate);
                break;
            }
            case "openPrivacySettings":
            {
                if (parameters?["permissions"] is not JsonArray list || list.Count == 0 || !list.All(n => Json.Text(n) is "accessibility" or "screenRecording"))
                    return Fail("invalid_params");
                // No Windows privacy gate to open for UI Automation or window capture.
                result = new Obj(("opened", false));
                break;
            }
            default: return Fail("unknown_method");
        }
        return PlatformPipe.Emit(new Obj(("version", PlatformPipe.Version), ("ok", true), ("result", result))) ? 0 : 1;
    }

    private sealed record Target(int Pid, uint Id, double Started);
    private sealed record State(string Identity, bool Onscreen, WindowInfo? Window);

    private static Target? Identity(JsonObject? p)
    {
        if (p == null || Json.Number(p["pid"]) is not { } pid || Json.Number(p["windowId"]) is not { } id || Json.Number(p["processStartedAt"]) is not { } started) return null;
        if (pid < 1 || pid > int.MaxValue || id < 1 || id > uint.MaxValue || Math.Truncate(pid) != pid || Math.Truncate(id) != id || started <= 0) return null;
        return new Target((int)pid, (uint)id, started);
    }

    private static State WindowState(WindowCatalog catalog, Target target, bool includingHidden)
    {
        var launched = catalog.LaunchDate(target.Pid);
        if (launched is not { } l || Math.Abs(l - target.Started) >= 0.000_001) return new State("mismatch", false, null);
        var hwnd = HwndOf(target.Id);
        if (!IsWindow(hwnd) || Owner(hwnd).Pid != target.Pid) return new State("mismatch", false, null);
        try
        {
            var info = catalog.Available(target.Pid, target.Id, allowOtherSpace: true);
            if (!includingHidden && info.Hidden) return new State("mismatch", false, null);
            return new State("matches", info.Visible, info);
        }
        catch (HelperError error)
        {
            // Still the same window, just not drawn (hidden or on another desktop).
            var reason = error.Details?.GetValueOrDefault("reason") as string;
            if (reason == "closed" || reason == null) return new State("mismatch", false, null);
            return includingHidden ? new State("matches", false, null) : new State("mismatch", false, null);
        }
    }
}
