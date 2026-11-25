using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using WinRT;
using static FleetComputerUse.Helper.Native;

namespace FleetComputerUse.Helper;

internal sealed record CapturedImage(string Mime, byte[] Data, int Width, int Height, string Source)
{
    public Obj ToJson() => new(("mime", Mime), ("data", Convert.ToBase64String(Data)), ("width", Width), ("height", Height));
}

/// <summary>Single-window capture: Windows.Graphics.Capture first, PrintWindow(PW_RENDERFULLCONTENT) second. Never reads the screen.</summary>
internal static unsafe class WindowCapture
{
    private sealed record Raw(byte[] Bgra, int Width, int Height, string Source);

    public static bool Supported
    {
        get { try { return GraphicsCaptureSession.IsSupported(); } catch { return false; } }
    }

    public static CapturedImage Capture(WindowInfo win, int? maxWidth, CancellationToken ct)
    {
        if (win.Minimized || !IsWindow(win.Hwnd) || IsIconic(win.Hwnd)) throw new HelperError("needs_visible_window", "", new Obj(("reason", "minimized")));
        Raw? raw = null;
        if (Supported)
        {
            try { raw = Wgc(win.Hwnd, ct); } catch (OperationCanceledException) { throw; } catch { raw = null; }
        }
        if (raw == null || Blank(raw)) raw = PrintWindowCapture(win.Hwnd) ?? raw;
        if (raw == null || Blank(raw)) throw HelperError.Unavailable("unknown", "capture_failed");
        raw = Crop(raw, win);
        return Encode(raw, maxWidth);
    }

    /// <summary>True when no screen pixel of the window belongs to it (every sampled point is covered by another window).</summary>
    public static bool FullyOccluded(WindowInfo win)
    {
        for (var iy = 1; iy <= 5; iy++)
            for (var ix = 1; ix <= 5; ix++)
            {
                var p = new POINT { X = (int)(win.Frame.X + win.Frame.W * ix / 6), Y = (int)(win.Frame.Y + win.Frame.H * iy / 6) };
                var hit = WindowFromPoint(p);
                if (hit != 0 && GetAncestor(hit, GA_ROOT) == win.Hwnd) return false;
            }
        return true;
    }

    private static bool Blank(Raw raw)
    {
        var first = BitConverter.ToUInt32(raw.Bgra, ((raw.Height / 2) * raw.Width + raw.Width / 2) * 4) & 0x00FFFFFF;
        var stepY = Math.Max(1, raw.Height / 24);
        var stepX = Math.Max(1, raw.Width / 24);
        for (var y = 0; y < raw.Height; y += stepY)
            for (var x = 0; x < raw.Width; x += stepX)
                if ((BitConverter.ToUInt32(raw.Bgra, (y * raw.Width + x) * 4) & 0x00FFFFFF) != first) return false;
        return first == 0;
    }

    /// <summary>Trims the invisible resize border so image pixels match the window frame (1px = 1 frame pixel).</summary>
    private static Raw Crop(Raw raw, WindowInfo win)
    {
        var rect = Rect(win.Hwnd);
        var fw = (int)win.Frame.W;
        var fh = (int)win.Frame.H;
        if (raw.Width == fw && raw.Height == fh) return raw;
        if (raw.Width != rect.W || raw.Height != rect.H) return raw;
        var ox = (int)win.Frame.X - rect.L;
        var oy = (int)win.Frame.Y - rect.T;
        if (ox < 0 || oy < 0 || ox + fw > raw.Width || oy + fh > raw.Height || fw <= 0 || fh <= 0) return raw;
        var output = new byte[fw * fh * 4];
        for (var y = 0; y < fh; y++) System.Buffer.BlockCopy(raw.Bgra, ((y + oy) * raw.Width + ox) * 4, output, y * fw * 4, fw * 4);
        return new Raw(output, fw, fh, raw.Source);
    }

    // ---- PrintWindow ----------------------------------------------------------------------------------------------

    private static Raw? PrintWindowCapture(nint hwnd)
    {
        var rect = Rect(hwnd);
        if (rect.W <= 0 || rect.H <= 0 || rect.W > 16384 || rect.H > 16384) return null;
        var screen = GetDC(0);
        var dc = CreateCompatibleDC(screen);
        ReleaseDC(0, screen);
        if (dc == 0) return null;
        var header = new BITMAPINFOHEADER { biSize = (uint)sizeof(BITMAPINFOHEADER), biWidth = rect.W, biHeight = -rect.H, biPlanes = 1, biBitCount = 32 };
        byte* bits;
        var bitmap = CreateDIBSection(dc, ref header, 0, out bits, 0, 0);
        if (bitmap == 0) { DeleteDC(dc); return null; }
        var old = SelectObject(dc, bitmap);
        try
        {
            if (!PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT)) return null;
            var bytes = new byte[rect.W * rect.H * 4];
            Marshal.Copy((nint)bits, bytes, 0, bytes.Length);
            for (var i = 3; i < bytes.Length; i += 4) bytes[i] = 0xFF;
            return new Raw(bytes, rect.W, rect.H, "printwindow");
        }
        finally
        {
            SelectObject(dc, old);
            DeleteObject(bitmap);
            DeleteDC(dc);
        }
    }

    // ---- WGC ------------------------------------------------------------------------------------------------------

    [DllImport("d3d11.dll")] private static extern int D3D11CreateDevice(nint adapter, int driverType, nint software, uint flags, nint levels, uint nLevels, uint sdk, out nint device, out int level, out nint ctx);
    [DllImport("d3d11.dll")] private static extern int CreateDirect3D11DeviceFromDXGIDevice(nint dxgi, out nint inspectable);
    [DllImport("combase.dll")] private static extern int RoGetActivationFactory(nint hstring, ref Guid iid, out nint factory);
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] private static extern int WindowsCreateString(string s, int len, out nint h);
    [DllImport("combase.dll")] private static extern int WindowsDeleteString(nint h);

    private static IDirect3DDevice? device;
    private static readonly object DeviceLock = new();

    private static IDirect3DDevice Device()
    {
        lock (DeviceLock)
        {
            if (device != null) return device;
            // WARP fallback when no hardware adapter is usable (remote sessions, VMs).
            var hr = D3D11CreateDevice(0, 1, 0, 0x20, 0, 0, 7, out var d, out _, out _);
            if (hr < 0) Marshal.ThrowExceptionForHR(D3D11CreateDevice(0, 5, 0, 0x20, 0, 0, 7, out d, out _, out _));
            var iidDxgi = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(d, in iidDxgi, out var dxgi));
            Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out var insp));
            device = MarshalInterface<IDirect3DDevice>.FromAbi(insp);
            return device;
        }
    }

    private static GraphicsCaptureItem ItemForWindow(nint hwnd)
    {
        const string cls = "Windows.Graphics.Capture.GraphicsCaptureItem";
        WindowsCreateString(cls, cls.Length, out var hstring);
        try
        {
            var iidInterop = new Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356");
            Marshal.ThrowExceptionForHR(RoGetActivationFactory(hstring, ref iidInterop, out var factory));
            var vtbl = *(nint**)factory;
            var create = (delegate* unmanaged[Stdcall]<nint, nint, Guid*, nint*, int>)vtbl[3];
            var iidItem = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
            nint item;
            Marshal.ThrowExceptionForHR(create(factory, hwnd, &iidItem, &item));
            return MarshalInterface<GraphicsCaptureItem>.FromAbi(item);
        }
        finally { WindowsDeleteString(hstring); }
    }

    private static bool borderlessRequested;

    private static Raw? Wgc(nint hwnd, CancellationToken ct)
    {
        // 테두리 없는 캡처 API는 Windows 10.0.20348 이상에만 있다. 지원 하한(19041)에서는 노란 테두리를 감수한다.
        if (!borderlessRequested && OperatingSystem.IsWindowsVersionAtLeast(10, 0, 20348))
        {
            borderlessRequested = true;
            try { GraphicsCaptureAccess.RequestAccessAsync(GraphicsCaptureAccessKind.Borderless).AsTask().Wait(2000); } catch { }
        }
        var item = ItemForWindow(hwnd);
        var size = item.Size;
        if (size.Width <= 0 || size.Height <= 0) return null;
        using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(Device(), DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, size);
        using var session = pool.CreateCaptureSession(item);
        if (OperatingSystem.IsWindowsVersionAtLeast(10, 0, 20348))
        {
            try { session.IsBorderRequired = false; } catch { }
        }
        try { session.IsCursorCaptureEnabled = false; } catch { }
        using var arrived = new ManualResetEventSlim();
        Direct3D11CaptureFrame? frame = null;
        pool.FrameArrived += (p, _) =>
        {
            if (frame != null) return;
            frame = p.TryGetNextFrame();
            arrived.Set();
        };
        session.StartCapture();
        try
        {
            if (!arrived.Wait(1500, ct) || frame == null) return null;
            using var bitmap = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface, BitmapAlphaMode.Premultiplied).AsTask().GetAwaiter().GetResult();
            return FromBitmap(bitmap, "wgc");
        }
        finally { frame?.Dispose(); }
    }

    private static Raw FromBitmap(SoftwareBitmap bitmap, string source)
    {
        var converted = bitmap.BitmapPixelFormat == BitmapPixelFormat.Bgra8 ? bitmap : SoftwareBitmap.Convert(bitmap, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        var bytes = new byte[converted.PixelWidth * converted.PixelHeight * 4];
        converted.CopyToBuffer(bytes.AsBuffer());
        if (!ReferenceEquals(converted, bitmap)) converted.Dispose();
        for (var i = 3; i < bytes.Length; i += 4) bytes[i] = 0xFF;
        return new Raw(bytes, bitmap.PixelWidth, bitmap.PixelHeight, source);
    }

    // ---- encoding -------------------------------------------------------------------------------------------------

    private static CapturedImage Encode(Raw raw, int? maxWidth)
    {
        using var bitmap = SoftwareBitmap.CreateCopyFromBuffer(raw.Bgra.AsBuffer(), BitmapPixelFormat.Bgra8, raw.Width, raw.Height, BitmapAlphaMode.Ignore);
        var preview = maxWidth != null;
        var width = raw.Width;
        var height = raw.Height;
        if (maxWidth is { } limit && width > limit)
        {
            height = Math.Max(1, (int)Math.Round(height * (double)limit / width));
            width = limit;
        }
        foreach (var quality in preview ? new[] { 0.6f, 0.45f, 0.3f } : new[] { 1f })
        {
            var data = EncodeOnce(bitmap, preview, quality, raw.Width, raw.Height, width, height);
            if (!preview || data.Length <= 262_144) return new CapturedImage(preview ? "image/jpeg" : "image/png", data, width, height, raw.Source);
        }
        throw HelperError.Unavailable("unknown", "image_too_large");
    }

    private static byte[] EncodeOnce(SoftwareBitmap bitmap, bool jpeg, float quality, int sourceWidth, int sourceHeight, int width, int height)
    {
        using var stream = new InMemoryRandomAccessStream();
        BitmapEncoder encoder;
        if (jpeg)
        {
            var props = new BitmapPropertySet { { "ImageQuality", new BitmapTypedValue(quality, Windows.Foundation.PropertyType.Single) } };
            encoder = BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, stream, props).AsTask().GetAwaiter().GetResult();
        }
        else encoder = BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream).AsTask().GetAwaiter().GetResult();
        encoder.SetSoftwareBitmap(bitmap);
        if (width != sourceWidth || height != sourceHeight)
        {
            encoder.BitmapTransform.ScaledWidth = (uint)width;
            encoder.BitmapTransform.ScaledHeight = (uint)height;
            encoder.BitmapTransform.InterpolationMode = BitmapInterpolationMode.Fant;
        }
        encoder.FlushAsync().AsTask().GetAwaiter().GetResult();
        var length = (int)stream.Size;
        var bytes = new byte[length];
        using var reader = new DataReader(stream.GetInputStreamAt(0));
        reader.LoadAsync((uint)length).AsTask().GetAwaiter().GetResult();
        reader.ReadBytes(bytes);
        return bytes;
    }
}
