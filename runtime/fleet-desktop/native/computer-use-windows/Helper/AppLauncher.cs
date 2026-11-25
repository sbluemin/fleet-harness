using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.Storage.FileSystem;
using Windows.Win32.System.Com;
using Windows.Win32.UI.Shell;
using static FleetComputerUse.Helper.Native;

namespace FleetComputerUse.Helper;

/// <summary>Enumerates the shell's AppsFolder (classic and packaged applications with their display names and parsing names).</summary>
internal static class CsWin32Shell
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(string path, nint bindContext, ref Guid iid, out nint item);

    public static unsafe void Enumerate(Action<string, string> visit)
    {
        var iid = typeof(IShellItem).GUID;
        if (SHCreateItemFromParsingName("shell:AppsFolder", 0, ref iid, out var raw) < 0 || raw == 0) return;
        var folder = (IShellItem)Marshal.GetObjectForIUnknown(raw);
        Marshal.Release(raw);
        var bhid = new Guid("94f60519-2850-4924-aa5a-d15e84868039");
        var enumIid = typeof(IEnumShellItems).GUID;
        void* enumRaw;
        folder.BindToHandler(null!, &bhid, &enumIid, out enumRaw);
        var items = (IEnumShellItems)Marshal.GetObjectForIUnknown((nint)enumRaw);
        Marshal.Release((nint)enumRaw);
        while (true)
        {
            var batch = new IShellItem[1];
            uint fetched = 0;
            items.Next(1, batch, &fetched);
            if (fetched == 0 || batch[0] == null) break;
            var item = batch[0];
            try
            {
                var name = DisplayName(item, SIGDN.SIGDN_NORMALDISPLAY);
                var parsing = DisplayName(item, SIGDN.SIGDN_PARENTRELATIVEPARSING);
                if (name != null && parsing != null) visit(name, parsing);
            }
            finally { Marshal.ReleaseComObject(item); }
        }
    }

    private static unsafe string? DisplayName(IShellItem item, SIGDN kind)
    {
        PWSTR text;
        item.GetDisplayName(kind, &text);
        if (text.Value == null) return null;
        var s = new string(text.Value);
        Marshal.FreeCoTaskMem((nint)text.Value);
        return s;
    }
}

internal static class AppLauncher
{
    private static readonly Regex Aumid = new(@"^[A-Za-z0-9][A-Za-z0-9._-]*_[a-z0-9]{13}![A-Za-z0-9._-]+$", RegexOptions.Compiled);

    private static bool Clean(string value) =>
        value.Length > 0 && value == value.Trim() && !value.Any(c => c < 32 || c == 127);

    private static bool IsAbsolutePath(string value) =>
        value.Length > 3 && char.IsLetter(value[0]) && value[1] == ':' && (value[2] == '\\' || value[2] == '/');

    /// <summary>Canonical existing .exe/.lnk path, or null.</summary>
    private static string? CanonicalPath(string value)
    {
        if (!IsAbsolutePath(value) || !Clean(value)) return null;
        var extension = Path.GetExtension(value).ToLowerInvariant();
        if (extension is not (".exe" or ".lnk")) return null;
        try
        {
            var full = Path.GetFullPath(value);
            if (!File.Exists(full)) return null;
            var info = new FileInfo(full);
            return info.ResolveLinkTarget(true)?.FullName is { } target && extension == ".exe" ? target : full;
        }
        catch { return null; }
    }

    public static Obj Resolve(string target)
    {
        if (!Clean(target)) return new Obj(("error", "exact_target_required"));
        if (IsAbsolutePath(target))
            return CanonicalPath(target) is { } path ? new Obj(("app", path)) : new Obj(("error", "installed_target_required"));
        var apps = InstalledApps.All();
        if (Aumid.IsMatch(target))
        {
            var match = apps.FirstOrDefault(a => string.Equals(a.Path, target, StringComparison.OrdinalIgnoreCase));
            return match != null ? new Obj(("app", match.Path)) : new Obj(("error", "installed_target_required"));
        }
        // A display name must identify exactly one installed application.
        var named = apps.Where(a => string.Equals(a.Name, target, StringComparison.CurrentCultureIgnoreCase)).GroupBy(a => a.Path, StringComparer.OrdinalIgnoreCase).ToList();
        if (named.Count == 0) return new Obj(("error", "installed_target_required"));
        if (named.Count > 1) return new Obj(("error", "unambiguous_target_required"));
        return new Obj(("app", named[0].Key));
    }

    private static string? ShortcutTarget(string lnk)
    {
        try
        {
            var link = (IShellLinkW)new ShellLink();
            ((IPersistFile)link).Load(lnk, 0);
            var buffer = new char[1024];
            unsafe
            {
                fixed (char* p = buffer)
                {
                    WIN32_FIND_DATAW data = default;
                    link.GetPath(new PWSTR(p), buffer.Length, &data, 0);
                    var s = new string(p);
                    return s.Length > 0 ? s : null;
                }
            }
        }
        catch { return null; }
    }

    public static Obj Open(string app, bool activate)
    {
        var failed = new Obj(("requestDispatched", false), ("windowReady", false), ("error", "computer_use_open_failed"));
        var isPackage = !IsAbsolutePath(app) && Aumid.IsMatch(app);
        var path = isPackage ? null : CanonicalPath(app);
        if (!isPackage && path == null) return failed;
        if (!isPackage && !string.Equals(path, app, StringComparison.OrdinalIgnoreCase) && !string.Equals(path, Path.GetFullPath(app), StringComparison.OrdinalIgnoreCase)) return failed;
        string? exeTarget = null;
        if (path != null) exeTarget = path.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase) ? ShortcutTarget(path) : path;
        var info = new SHELLEXECUTEINFO
        {
            cbSize = (uint)Marshal.SizeOf<SHELLEXECUTEINFO>(),
            fMask = 0x40 | 0x400, // NOCLOSEPROCESS | FLAG_NO_UI
            lpVerb = "open",
            lpFile = isPackage ? "shell:AppsFolder\\" + app : path,
            nShow = activate ? SW_SHOWNORMAL : SW_SHOWNOACTIVATE,
        };
        var dispatched = ShellExecuteEx(ref info);
        if (!dispatched) return failed;
        uint startedPid = info.hProcess != 0 ? GetProcessId(info.hProcess) : 0;
        if (info.hProcess != 0) CloseHandle(info.hProcess);
        var catalog = new WindowCatalog();
        var clock = Stopwatch.StartNew();
        var ready = false;
        while (clock.ElapsedMilliseconds < 5_000 && !ready)
        {
            foreach (var window in catalog.All())
            {
                if (window.Minimized || !window.Onscreen) continue;
                var match = isPackage
                    ? string.Equals(window.BundleId, app, StringComparison.OrdinalIgnoreCase)
                    : (exeTarget != null && string.Equals(window.BundlePath, exeTarget, StringComparison.OrdinalIgnoreCase)) || (startedPid != 0 && window.Key.Pid == startedPid);
                if (match) { ready = true; break; }
            }
            if (!ready) Thread.Sleep(200);
        }
        return new Obj(("requestDispatched", true), ("windowReady", ready));
    }
}
