using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using static FleetComputerUse.Helper.Native;

namespace FleetComputerUse.Helper;

internal static unsafe class ClipboardNative
{
    [DllImport("gdi32.dll")] public static extern uint GetEnhMetaFileBits(nint hemf, uint size, byte* buffer);
    [DllImport("gdi32.dll")] public static extern nint SetEnhMetaFileBits(uint size, byte* buffer);
    [DllImport("gdi32.dll")] public static extern bool DeleteEnhMetaFile(nint hemf);
}

/// <summary>
/// Temporary clipboard contents for a paste. Preserves every readable format (total 64 MiB), fails closed on delayed rendering
/// and handle-only GDI formats, and never overwrites contents a person (or app) wrote after the lease began.
/// </summary>
internal sealed unsafe class ClipboardLease
{
    private const uint CF_TEXT = 1, CF_BITMAP = 2, CF_METAFILEPICT = 3, CF_PALETTE = 9, CF_ENHMETAFILE = 14, CF_UNICODETEXT = 13, CF_DIB = 8, CF_DIBV5 = 17,
        CF_OWNERDISPLAY = 0x80, CF_DSPBITMAP = 0x82, CF_DSPMETAFILEPICT = 0x83, CF_DSPENHMETAFILE = 0x8E;
    private const long MaxBytes = 64L * 1024 * 1024;

    private sealed record Saved(uint Format, byte[] Data);

    private readonly nint owner;
    private readonly uint ownedSequence;
    private List<Saved> saved;
    private string? finished;

    private ClipboardLease(nint owner, uint ownedSequence, List<Saved> saved)
    {
        this.owner = owner; this.ownedSequence = ownedSequence; this.saved = saved;
    }

    private static bool Open(nint owner, int waitMs)
    {
        var clock = Stopwatch.StartNew();
        while (!OpenClipboard(owner))
        {
            if (clock.ElapsedMilliseconds > waitMs) return false;
            Thread.Sleep(10);
        }
        return true;
    }

    public static nint CreateOwnerWindow() => CreateWindowEx(0, "STATIC", "FleetPasteLease", 0, 0, 0, 0, 0, -3, 0, 0, 0);

    private static List<Saved>? Snapshot(nint owner)
    {
        if (!Open(owner, 1_000)) return null;
        try
        {
            var formats = new List<uint>();
            for (var f = EnumClipboardFormats(0); f != 0; f = EnumClipboardFormats(f)) formats.Add(f);
            var hasDib = formats.Contains(CF_DIB) || formats.Contains(CF_DIBV5);
            var result = new List<Saved>();
            long total = 0;
            foreach (var format in formats)
            {
                if (format is CF_BITMAP or CF_PALETTE && hasDib) continue; // synthesized from the DIB, which is restored
                if (format is CF_METAFILEPICT or CF_BITMAP or CF_PALETTE or CF_OWNERDISPLAY or CF_DSPBITMAP or CF_DSPMETAFILEPICT or CF_DSPENHMETAFILE) return null;
                if (format is >= 0x300 and <= 0x3FF) return null;
                var handle = GetClipboardData(format);
                if (handle == 0) return null; // delayed rendering that did not render, or an unreadable format
                byte[] data;
                if (format == CF_ENHMETAFILE)
                {
                    var size = ClipboardNative.GetEnhMetaFileBits(handle, 0, null);
                    if (size == 0 || total + size > MaxBytes) return null;
                    data = new byte[size];
                    fixed (byte* p = data) if (ClipboardNative.GetEnhMetaFileBits(handle, size, p) != size) return null;
                }
                else
                {
                    var size = (long)GlobalSize(handle);
                    if (size < 0 || total + size > MaxBytes) return null;
                    var source = GlobalLock(handle);
                    if (source == null) return null;
                    data = new byte[size];
                    Marshal.Copy((nint)source, data, 0, (int)size);
                    GlobalUnlock(handle);
                }
                total += data.Length;
                result.Add(new Saved(format, data));
            }
            return result;
        }
        finally { CloseClipboard(); }
    }

    private static bool Set(uint format, byte[] data)
    {
        if (format == CF_ENHMETAFILE)
        {
            fixed (byte* p = data)
            {
                var emf = ClipboardNative.SetEnhMetaFileBits((uint)data.Length, p);
                if (emf == 0) return false;
                if (SetClipboardData(format, emf) != 0) return true;
                ClipboardNative.DeleteEnhMetaFile(emf);
                return false;
            }
        }
        var mem = GlobalAlloc(0x42, (nuint)Math.Max(1, data.Length));
        if (mem == 0) return false;
        var target = GlobalLock(mem);
        if (target == null) { GlobalFree(mem); return false; }
        Marshal.Copy(data, 0, (nint)target, data.Length);
        GlobalUnlock(mem);
        if (SetClipboardData(format, mem) != 0) return true;
        GlobalFree(mem);
        return false;
    }

    private static byte[] Utf16Text(string text) => Encoding.Unicode.GetBytes(text + "\0");

    /// <summary>CF_HTML wrapper with byte offsets, as Windows applications expect.</summary>
    internal static byte[] HtmlFormat(string html)
    {
        const string prefix = "<html><body><!--StartFragment-->";
        const string suffix = "<!--EndFragment--></body></html>";
        string Header(int a, int b, int c, int d) =>
            $"Version:0.9\r\nStartHTML:{a:D10}\r\nEndHTML:{b:D10}\r\nStartFragment:{c:D10}\r\nEndFragment:{d:D10}\r\n";
        var headerLength = Encoding.UTF8.GetByteCount(Header(0, 0, 0, 0));
        var fragment = Encoding.UTF8.GetByteCount(html);
        var startHtml = headerLength;
        var startFragment = startHtml + Encoding.UTF8.GetByteCount(prefix);
        var endFragment = startFragment + fragment;
        var endHtml = endFragment + Encoding.UTF8.GetByteCount(suffix);
        return Encoding.UTF8.GetBytes(Header(startHtml, endHtml, startFragment, endFragment) + prefix + html + suffix + "\0");
    }

    public static ClipboardLease? Start(nint owner, string text, string? html, Guid token, Func<bool> canReplace)
    {
        var originalSequence = GetClipboardSequenceNumber();
        var saved = Snapshot(owner);
        if (saved == null || !canReplace() || GetClipboardSequenceNumber() != originalSequence) return null;
        var tokenFormat = RegisterClipboardFormat("FleetConsole.PasteLease");
        var historyFormat = RegisterClipboardFormat("CanIncludeInClipboardHistory");
        var cloudFormat = RegisterClipboardFormat("CanUploadToCloudClipboard");
        var monitorFormat = RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing");
        var htmlFormat = RegisterClipboardFormat("HTML Format");
        if (!Open(owner, 500)) return null;
        var opened = true;
        uint sequence;
        try
        {
            if (GetClipboardSequenceNumber() != originalSequence) return null;
            if (!EmptyClipboard()) return null;
            var ok = Set(CF_UNICODETEXT, Utf16Text(text)) &&
                     Set(tokenFormat, Encoding.UTF8.GetBytes(token.ToString())) &&
                     (html == null || Set(htmlFormat, HtmlFormat(html)));
            // Keep the temporary contents out of clipboard history, cloud sync and clipboard monitors.
            Set(historyFormat, new byte[4]);
            Set(cloudFormat, new byte[4]);
            Set(monitorFormat, new byte[4]);
            CloseClipboard();
            opened = false;
            sequence = GetClipboardSequenceNumber();
            var lease = new ClipboardLease(owner, sequence, saved);
            if (ok && lease.ContainsReplacement(tokenFormat, token)) return lease;
            if (lease.ContainsReplacement(tokenFormat, token)) lease.Finish();
            return null;
        }
        finally { if (opened) CloseClipboard(); }
    }

    private bool ContainsReplacement(uint tokenFormat, Guid token)
    {
        if (!Open(owner, 500)) return false;
        try
        {
            if (GetClipboardSequenceNumber() != ownedSequence) return false;
            var handle = GetClipboardData(tokenFormat);
            if (handle == 0) return false;
            var source = GlobalLock(handle);
            if (source == null) return false;
            var value = Marshal.PtrToStringUTF8((nint)source, 36);
            GlobalUnlock(handle);
            return value == token.ToString();
        }
        finally { CloseClipboard(); }
    }

    /// <summary>Restores the saved contents unless something newer was written. Runs once.</summary>
    public string Finish()
    {
        if (finished != null) return finished;
        string outcome;
        if (!Open(owner, 2_000)) outcome = GetClipboardSequenceNumber() != ownedSequence ? "preserved_newer_contents" : "failed";
        else
        {
            try
            {
                if (GetClipboardSequenceNumber() != ownedSequence) outcome = "preserved_newer_contents";
                else if (!EmptyClipboard()) outcome = "failed";
                else
                {
                    outcome = "restored";
                    foreach (var item in saved) if (!Set(item.Format, item.Data)) outcome = "failed";
                }
            }
            finally { CloseClipboard(); }
        }
        saved = new List<Saved>();
        finished = outcome;
        return outcome;
    }
}

/// <summary>`--paste-lease`: hold temporary clipboard contents while the caller pastes, then restore (stdin EOF / extra input / expiry / Ctrl-C).</summary>
internal static class PasteLeaseCommand
{
    private static volatile bool terminated;

    public static int Run()
    {
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; terminated = true; };
        var pipe = new PlatformPipe(() => terminated);
        var clock = Stopwatch.StartNew();
        const int prepareBy = 5_000, leaseEnds = 100_000;
        var token = Guid.NewGuid();
        ClipboardLease? lease = null;
        var frame = pipe.ReadFrame(2_000_000, clock, prepareBy);
        var payload = frame == null ? null : Json.ParseObject(frame);
        if (payload != null && Json.Number(payload["version"]) == PlatformPipe.Version && Json.Text(payload["text"]) is { } text &&
            (payload["html"] == null || Json.Text(payload["html"]) != null) && !terminated && !pipe.HasExtraInputOrEof() && clock.ElapsedMilliseconds < prepareBy)
        {
            var owner = ClipboardLease.CreateOwnerWindow();
            if (owner != 0)
                lease = ClipboardLease.Start(owner, text, Json.Text(payload["html"]), token,
                    () => !terminated && !pipe.HasExtraInputOrEof() && clock.ElapsedMilliseconds < prepareBy);
        }
        if (lease == null)
        {
            PlatformPipe.Emit(new Obj(("version", PlatformPipe.Version), ("ready", false)));
            return 1;
        }
        // Stdin stays open only while the caller owns the temporary contents.
        if (!terminated && !pipe.HasExtraInputOrEof() && clock.ElapsedMilliseconds < prepareBy &&
            PlatformPipe.Emit(new Obj(("version", PlatformPipe.Version), ("ready", true))))
            pipe.CanRead(clock, leaseEnds);
        var restoration = lease.Finish();
        PlatformPipe.Emit(new Obj(("version", PlatformPipe.Version), ("restoration", restoration)));
        return restoration == "failed" ? 1 : 0;
    }
}
