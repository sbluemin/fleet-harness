using System.Diagnostics;
using System.Runtime.InteropServices;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.UI.Shell;
using static FleetComputerUse.Helper.Native;
using RECT = FleetComputerUse.Helper.Native.RECT;

namespace FleetComputerUse.Helper;

internal sealed record WindowKey(int Pid, uint Id, double Started);

internal sealed class WindowInfo
{
    public required WindowKey Key { get; init; }
    public required nint Hwnd { get; init; }
    public required string Class { get; init; }
    public required string App { get; init; }
    public required string BundleId { get; init; }
    public required string BundlePath { get; init; }
    public required string Title { get; set; }
    public required Frame Frame { get; init; }
    public required string Engine { get; set; }
    public bool Front { get; init; }
    public bool Hidden { get; init; }
    public bool Minimized { get; set; }
    public bool OnCurrentSpace { get; init; }
    /// <summary>Drawn on the person's current screen: visible, not minimized, not cloaked, on the current virtual desktop.</summary>
    public bool Onscreen { get; init; }
    public bool InActiveDesktop { get; init; }
    public int InnerPid { get; init; }
    public string StartedAtSource => "launch";

    public Frame LocalFrame => new(0, 0, Frame.W, Frame.H);
    public bool Visible => Onscreen && OnCurrentSpace && !Hidden && !Minimized && !Frame.IsEmpty;
    /// <summary>Readable and operable without raising: visible windows plus minimized ones (their UIA tree and message queue still work).</summary>
    public bool Usable => (Visible || (InActiveDesktop && Minimized)) && !Frame.IsEmpty;
    public (double X, double Y) Screen(double x, double y) => (Frame.X + x, Frame.Y + y);
    public bool IsChromium => Engine is "chromium" or "electron";

    public Obj SnapshotJson() => new(("pid", Key.Pid), ("windowId", Key.Id), ("processStartedAt", Key.Started),
        ("title", Title), ("frame", Frame.ToJson()));

    public Obj Json()
    {
        var o = SnapshotJson();
        o["app"] = App; o["bundleId"] = BundleId; o["bundlePath"] = BundlePath; o["front"] = Front; o["hidden"] = Hidden;
        o["minimized"] = Minimized; o["onCurrentSpace"] = OnCurrentSpace; o["engine"] = Engine; o["startedAtSource"] = StartedAtSource;
        return o;
    }
}

internal sealed record ProcessData(int Pid, double Started, string? ExePath, string App, string BundleId, string BundlePath, string Engine);

internal sealed unsafe class WindowCatalog
{
    private static readonly HashSet<string> IgnoredClasses = new(StringComparer.Ordinal)
    {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow",
        "TopLevelWindowForOverflowXamlIsland", "NotifyIconOverflowWindow", "ForegroundStaging", "Windows.Internal.Shell.TabProxyWindow",
    };

    private readonly Dictionary<int, ProcessData> processes = new();
    private readonly Dictionary<nint, (string Cls, string Engine, double Started)> engines = new();
    private readonly Dictionary<uint, (int Pid, string Cls, double Started)> known = new();
    private IVirtualDesktopManager? desktops;
    private bool desktopsTried;
    private readonly uint ownPid = Native.GetCurrentProcessId();

    public static double? ProcessStarted(int pid)
    {
        var handle = OpenProcess(0x1000, false, (uint)pid);
        if (handle == 0) return null;
        try { return GetProcessTimes(handle, out var created, out _, out _, out _) && created > 0 ? FileTimeToEpochSeconds(created) : null; }
        finally { CloseHandle(handle); }
    }

    public double? LaunchDate(int pid) => ProcessStarted(pid);

    private ProcessData? Process(int pid, nint hwnd, string cls)
    {
        var started = ProcessStarted(pid);
        if (started == null) return null;
        if (processes.TryGetValue(pid, out var cached) && cached.Started == started && cls != "ApplicationFrameWindow") return cached;
        var handle = OpenProcess(0x1000, false, (uint)pid);
        if (handle == 0) return null;
        try
        {
            var exe = ProcessImagePath(handle);
            var aumid = AppUserModelId(handle);
            var data = Describe(pid, started.Value, exe, aumid, cls);
            if (cls != "ApplicationFrameWindow") processes[pid] = data;
            return data;
        }
        finally { CloseHandle(handle); }
    }

    private static ProcessData Describe(int pid, double started, string? exe, string? aumid, string cls)
    {
        var name = exe == null ? "" : Path.GetFileNameWithoutExtension(exe);
        string? description = null;
        if (exe != null)
        {
            try { description = FileVersionInfo.GetVersionInfo(exe).FileDescription; } catch { }
        }
        var app = !string.IsNullOrWhiteSpace(description) ? description!.Trim() : name;
        if (aumid != null && InstalledApps.NameForAumid(aumid) is { } packaged) app = packaged;
        var bundle = aumid ?? (exe == null ? "" : Path.GetFileName(exe));
        return new ProcessData(pid, started, exe, app, bundle, exe ?? "", "win32");
    }

    private (IVirtualDesktopManager? Manager, bool Ok) Desktops()
    {
        if (!desktopsTried)
        {
            desktopsTried = true;
            try { desktops = (IVirtualDesktopManager)new VirtualDesktopManager(); } catch { desktops = null; }
        }
        return (desktops, desktops != null);
    }

    private bool OnCurrentDesktop(nint hwnd)
    {
        var (manager, ok) = Desktops();
        if (!ok) return true;
        try { BOOL on; manager!.IsWindowOnCurrentVirtualDesktop(new HWND(hwnd), &on); return on; } catch { return true; }
    }

    private static string DetectEngine(nint hwnd, string cls, string? exe)
    {
        if (cls == "ApplicationFrameWindow") return "uwp";
        if (cls.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal))
        {
            if (exe != null)
            {
                var dir = Path.GetDirectoryName(exe) ?? "";
                var file = Path.GetFileName(exe).ToLowerInvariant();
                if (file == "electron.exe" || File.Exists(Path.Combine(dir, "resources", "app.asar")) ||
                    Directory.Exists(Path.Combine(dir, "resources", "app")) || File.Exists(Path.Combine(dir, "resources", "electron.asar")))
                    return "electron";
            }
            return "chromium";
        }
        if (cls.StartsWith("HwndWrapper[", StringComparison.Ordinal)) return "wpf";
        if (cls.StartsWith("WindowsForms10.", StringComparison.Ordinal)) return "winforms";
        if (cls == "WinUIDesktopWin32WindowClass") return "winui";
        foreach (var child in Descendants(hwnd))
        {
            var c = ClassName(child);
            if (c == "Microsoft.UI.Content.DesktopChildSiteBridge") return "winui";
            if (c.StartsWith("WindowsForms10.", StringComparison.Ordinal)) return "winforms";
        }
        return "win32";
    }

    private string EngineFor(nint hwnd, string cls, ProcessData process)
    {
        if (engines.TryGetValue(hwnd, out var hit) && hit.Cls == cls && hit.Started == process.Started) return hit.Engine;
        var engine = DetectEngine(hwnd, cls, process.ExePath);
        engines[hwnd] = (cls, engine, process.Started);
        return engine;
    }

    /// <summary>True for windows the person would see as an application window (taskbar/alt-tab-like).</summary>
    private static bool Listable(nint hwnd, string cls, string title)
    {
        if (IgnoredClasses.Contains(cls)) return false;
        if (title.Length == 0) return false;
        var ex = (uint)(long)GetWindowLongPtr(hwnd, GWL_EXSTYLE);
        if ((ex & WS_EX_TOOLWINDOW) != 0 && (ex & WS_EX_APPWINDOW) == 0) return false;
        return true;
    }

    private static Frame FrameOf(nint hwnd, bool iconic)
    {
        if (iconic)
        {
            var placement = new WINDOWPLACEMENT { length = (uint)sizeof(WINDOWPLACEMENT) };
            if (GetWindowPlacement(hwnd, ref placement))
            {
                var r = placement.rcNormalPosition;
                return new Frame(r.L, r.T, r.W, r.H);
            }
        }
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out RECT frame, sizeof(RECT)) == 0 && frame.W > 0 && frame.H > 0)
            return new Frame(frame.L, frame.T, frame.W, frame.H);
        var w = Rect(hwnd);
        return new Frame(w.L, w.T, w.W, w.H);
    }

    private WindowInfo? Build(nint hwnd, nint foregroundRoot, bool listFilter)
    {
        if (!IsWindow(hwnd)) return null;
        var (pid, _) = Owner(hwnd);
        if (pid <= 0 || pid == (int)ownPid) return null;
        var cls = ClassName(hwnd);
        var title = WindowText(hwnd);
        var visible = IsWindowVisible(hwnd);
        var iconic = IsIconic(hwnd);
        if (listFilter && (!visible || !Listable(hwnd, cls, title))) return null;
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out int cloaked, sizeof(int));
        var onDesktop = OnCurrentDesktop(hwnd);
        // Cloaked by the shell on another virtual desktop is still a real window (view-only); other cloaking is a suspended app surface.
        if (cloaked != 0 && onDesktop) return null;
        var process = Process(pid, hwnd, cls);
        if (process == null) return null;
        var inner = pid;
        ProcessData describe = process;
        if (cls == "ApplicationFrameWindow")
        {
            // The frame belongs to ApplicationFrameHost; the UWP app is the CoreWindow child's process.
            foreach (var child in Descendants(hwnd))
            {
                if (ClassName(child) != "Windows.UI.Core.CoreWindow") continue;
                var (childPid, _) = Owner(child);
                if (childPid > 0 && childPid != pid && Process(childPid, child, "Windows.UI.Core.CoreWindow") is { } real) { describe = real; inner = childPid; }
                break;
            }
            if (inner == pid) return null; // suspended UWP frame without content
        }
        var frame = FrameOf(hwnd, iconic);
        if (frame.IsEmpty) return null;
        var app = describe.App.Length > 0 ? describe.App : (title.Length > 0 ? title : Path.GetFileNameWithoutExtension(describe.ExePath ?? ""));
        var onscreen = visible && !iconic && cloaked == 0 && onDesktop;
        var info = new WindowInfo
        {
            Key = new WindowKey(pid, IdOf(hwnd), process.Started),
            Hwnd = hwnd,
            Class = cls,
            App = app,
            BundleId = describe.BundleId,
            BundlePath = describe.BundlePath,
            Title = title,
            Frame = frame,
            Engine = EngineFor(hwnd, cls, describe),
            Front = foregroundRoot == hwnd,
            Hidden = !visible,
            Minimized = iconic,
            OnCurrentSpace = onDesktop && cloaked == 0,
            Onscreen = onscreen,
            InActiveDesktop = onDesktop,
            InnerPid = inner,
        };
        known[info.Key.Id] = (pid, cls, process.Started);
        return info;
    }

    private static nint ForegroundRoot()
    {
        var fg = GetForegroundWindow();
        return fg == 0 ? 0 : GetAncestor(fg, GA_ROOT);
    }

    public List<WindowInfo> All(int? pid = null, bool visibleOnly = false)
    {
        var front = ForegroundRoot();
        var list = new List<WindowInfo>();
        foreach (var hwnd in TopLevelWindows())
        {
            if (pid != null && Owner(hwnd).Pid != pid) continue;
            var info = Build(hwnd, front, true);
            if (info == null) continue;
            if (visibleOnly && !info.Visible) continue;
            list.Add(info);
        }
        return list;
    }

    /// <summary>Finds a window again for reading/operating it. Other-desktop windows are returned only for view-only capture.</summary>
    public WindowInfo Available(int pid, uint id, bool allowOtherSpace = false)
    {
        var hwnd = HwndOf(id);
        if (!IsWindow(hwnd)) throw HelperError.Unavailable("closed");
        var (owner, _) = Owner(hwnd);
        var cls = ClassName(hwnd);
        if (owner != pid || (known.TryGetValue(id, out var prior) && (prior.Pid != pid || prior.Cls != cls)))
            throw HelperError.Unavailable("closed");
        var info = Build(hwnd, ForegroundRoot(), false) ?? throw HelperError.Unavailable("unknown");
        if (info.Usable || (allowOtherSpace && !info.InActiveDesktop && !info.Frame.IsEmpty)) return info;
        throw HelperError.Unavailable(UnavailableReason(info));
    }

    public static string UnavailableReason(WindowInfo info)
    {
        if (info.Hidden) return "hidden";
        if (info.Minimized) return "minimized";
        if (!info.InActiveDesktop || !info.OnCurrentSpace) return "other_space";
        return "unknown";
    }

    /// <summary>Drops cached knowledge about windows and processes that are gone.</summary>
    public HashSet<WindowKey> Prune(HashSet<WindowKey> reported)
    {
        foreach (var id in known.Keys.ToList())
        {
            var hwnd = HwndOf(id);
            if (!IsWindow(hwnd) || Owner(hwnd).Pid != known[id].Pid) known.Remove(id);
        }
        foreach (var pid in processes.Keys.ToList())
            if (ProcessStarted(pid) != processes[pid].Started) processes.Remove(pid);
        foreach (var hwnd in engines.Keys.ToList()) if (!IsWindow(hwnd)) engines.Remove(hwnd);
        return reported;
    }
}

internal sealed record InstalledApp(string Name, string Path, string BundleId);

/// <summary>Installed applications from the shell's AppsFolder (classic and packaged apps, with their AUMIDs).</summary>
internal static class InstalledApps
{
    private static readonly Guid EnumItems = new("94f60519-2850-4924-aa5a-d15e84868039");

    public static List<InstalledApp> All()
    {
        var apps = new List<InstalledApp>();
        try
        {
            CsWin32Shell.Enumerate((name, parsing) =>
            {
                if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(parsing)) return;
                var isPath = parsing.Length > 2 && char.IsLetter(parsing[0]) && parsing[1] == ':' && parsing[2] == '\\';
                var bundleId = isPath ? Path.GetFileName(parsing) : parsing;
                apps.Add(new InstalledApp(name.Trim(), parsing, bundleId));
            });
        }
        catch { }
        return apps;
    }

    private static Dictionary<string, string>? aumidNames;

    /// <summary>Display name of a packaged application (what the Start menu shows), by AUMID.</summary>
    public static string? NameForAumid(string aumid)
    {
        aumidNames ??= All().GroupBy(a => a.Path, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First().Name, StringComparer.OrdinalIgnoreCase);
        return aumidNames.GetValueOrDefault(aumid);
    }

    public static List<Obj> Query(string query)
    {
        return All()
            .Where(a => Contains(a.Name, query) || Contains(a.BundleId, query) || Contains(a.Path, query))
            .GroupBy(a => a.Path, StringComparer.OrdinalIgnoreCase).Select(g => g.First())
            .OrderBy(a => a.Name, StringComparer.CurrentCultureIgnoreCase)
            .Take(100)
            .Select(a => new Obj(("name", a.Name), ("path", a.Path), ("bundleId", a.BundleId))).ToList();
    }

    private static bool Contains(string haystack, string needle) => haystack.Contains(needle, StringComparison.CurrentCultureIgnoreCase);
}
