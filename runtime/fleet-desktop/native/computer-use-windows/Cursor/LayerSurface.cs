using System.Runtime.InteropServices;
using static FleetComputerUse.Cursor.Win32;

namespace FleetComputerUse.Cursor;

/// <summary>A top-down premultiplied BGRA DIB shared by GDI+ and UpdateLayeredWindow.</summary>
internal sealed class LayerSurface : IDisposable
{
    private nint dc, dib, oldBitmap, bitmap, graphics;
    internal readonly Size Size;
    internal nint Graphics => graphics;

    internal LayerSurface(int width, int height)
    {
        Size = new(width, height);
        try
        {
            dc = CreateCompatibleDC(0);
            if (dc == 0) throw Error(nameof(CreateCompatibleDC));
            var info = new BitmapInfo { Size = 40, Width = width, Height = -height, BitCount = 32, Planes = 1 };
            dib = CreateDIBSection(dc, in info, 0, out var bits, 0, 0);
            if (dib == 0) throw Error(nameof(CreateDIBSection));
            oldBitmap = SelectObject(dc, dib);
            if (oldBitmap == 0 || oldBitmap == -1) throw Error(nameof(SelectObject));
            GdiPlus.Check(GdiPlus.GdipCreateBitmapFromScan0(width, height, width * 4, 0x000E200B, bits, out bitmap)); // PixelFormat32bppPARGB
            GdiPlus.Check(GdiPlus.GdipGetImageGraphicsContext(bitmap, out graphics));
            GdiPlus.Check(GdiPlus.GdipSetSmoothingMode(graphics, 4)); // AntiAlias
            GdiPlus.Check(GdiPlus.GdipSetTextRenderingHint(graphics, 4)); // AntiAliasGridFit, not ClearType on alpha
        }
        catch { Dispose(); throw; }
    }

    internal void Present(nint window, Point origin, byte opacity)
    {
        GdiPlus.Check(GdiPlus.GdipFlush(graphics, 1));
        var source = new Point(0, 0);
        var blend = new Blend(0, 0, opacity, 1);
        if (!UpdateLayeredWindow(window, 0, origin, Size, dc, source, 0, blend, 2))
            throw Error(nameof(UpdateLayeredWindow));
    }

    public void Dispose()
    {
        if (graphics != 0) GdiPlus.GdipDeleteGraphics(graphics);
        if (bitmap != 0) GdiPlus.GdipDisposeImage(bitmap);
        if (oldBitmap != 0 && oldBitmap != -1) SelectObject(dc, oldBitmap);
        if (dib != 0) DeleteObject(dib);
        if (dc != 0) DeleteDC(dc);
        graphics = bitmap = oldBitmap = dib = dc = 0;
    }
}

internal static class GdiPlus
{
    [StructLayout(LayoutKind.Sequential)] internal struct Startup { public uint Version; public nint Callback; public int NoBackgroundThread, NoExternalCodecs; }
    [StructLayout(LayoutKind.Sequential)] internal record struct P(float X, float Y);
    [StructLayout(LayoutKind.Sequential)] internal record struct R(float X, float Y, float Width, float Height);
    internal static void Check(int status)
    {
        if (status != 0) throw new InvalidOperationException($"GDI+ cursor render failed (status {status}).");
    }

    [DllImport("gdiplus")] internal static extern int GdiplusStartup(out nuint token, in Startup input, nint output);
    [DllImport("gdiplus")] internal static extern void GdiplusShutdown(nuint token);
    [DllImport("gdiplus")] internal static extern int GdipCreateBitmapFromScan0(int w, int h, int stride, int format, nint bits, out nint bitmap);
    [DllImport("gdiplus")] internal static extern int GdipDisposeImage(nint bitmap);
    [DllImport("gdiplus")] internal static extern int GdipGetImageGraphicsContext(nint image, out nint graphics);
    [DllImport("gdiplus")] internal static extern int GdipDeleteGraphics(nint graphics);
    [DllImport("gdiplus")] internal static extern int GdipSetSmoothingMode(nint graphics, int mode);
    [DllImport("gdiplus")] internal static extern int GdipSetTextRenderingHint(nint graphics, int mode);
    [DllImport("gdiplus")] internal static extern int GdipGraphicsClear(nint graphics, uint argb);
    [DllImport("gdiplus")] internal static extern int GdipFlush(nint graphics, int intention);
    [DllImport("gdiplus")] internal static extern int GdipSaveGraphics(nint graphics, out uint state);
    [DllImport("gdiplus")] internal static extern int GdipRestoreGraphics(nint graphics, uint state);
    [DllImport("gdiplus")] internal static extern int GdipResetWorldTransform(nint graphics);
    [DllImport("gdiplus")] internal static extern int GdipTranslateWorldTransform(nint graphics, float x, float y, int order = 0);
    [DllImport("gdiplus")] internal static extern int GdipScaleWorldTransform(nint graphics, float x, float y, int order = 0);
    [DllImport("gdiplus")] internal static extern int GdipRotateWorldTransform(nint graphics, float angle, int order = 0);
    [DllImport("gdiplus")] internal static extern int GdipCreateSolidFill(uint argb, out nint brush);
    [DllImport("gdiplus")] internal static extern int GdipCreateLineBrush(in P from, in P to, uint start, uint end, int wrap, out nint brush);
    [DllImport("gdiplus")] internal static extern int GdipSetLinePresetBlend(nint brush, uint[] colors, float[] positions, int count);
    [DllImport("gdiplus")] internal static extern int GdipDeleteBrush(nint brush);
    [DllImport("gdiplus")] internal static extern int GdipCreatePen1(uint argb, float width, int unit, out nint pen);
    [DllImport("gdiplus")] internal static extern int GdipSetPenLineJoin(nint pen, int join);
    [DllImport("gdiplus")] internal static extern int GdipSetPenStartCap(nint pen, int cap);
    [DllImport("gdiplus")] internal static extern int GdipSetPenEndCap(nint pen, int cap);
    [DllImport("gdiplus")] internal static extern int GdipSetPenDashArray(nint pen, float[] dashes, int count);
    [DllImport("gdiplus")] internal static extern int GdipDeletePen(nint pen);
    [DllImport("gdiplus")] internal static extern int GdipCreatePath(int fill, out nint path);
    [DllImport("gdiplus")] internal static extern int GdipAddPathBeziers(nint path, P[] points, int count);
    [DllImport("gdiplus")] internal static extern int GdipAddPathLine(nint path, float x1, float y1, float x2, float y2);
    [DllImport("gdiplus")] internal static extern int GdipAddPathArc(nint path, float x, float y, float width, float height, float start, float sweep);
    [DllImport("gdiplus")] internal static extern int GdipAddPathEllipse(nint path, float x, float y, float width, float height);
    [DllImport("gdiplus")] internal static extern int GdipClosePathFigure(nint path);
    [DllImport("gdiplus")] internal static extern int GdipDeletePath(nint path);
    [DllImport("gdiplus")] internal static extern int GdipFillPath(nint graphics, nint brush, nint path);
    [DllImport("gdiplus")] internal static extern int GdipDrawPath(nint graphics, nint pen, nint path);
    [DllImport("gdiplus")] internal static extern int GdipDrawLines(nint graphics, nint pen, P[] points, int count);
    [DllImport("gdiplus")] internal static extern int GdipFillEllipse(nint graphics, nint brush, float x, float y, float width, float height);
    [DllImport("gdiplus", CharSet = CharSet.Unicode, ExactSpelling = true)] internal static extern int GdipCreateFontFamilyFromName(string name, nint collection, out nint family);
    [DllImport("gdiplus")] internal static extern int GdipDeleteFontFamily(nint family);
    [DllImport("gdiplus")] internal static extern int GdipCreateFont(nint family, float size, int style, int unit, out nint font);
    [DllImport("gdiplus")] internal static extern int GdipDeleteFont(nint font);
    [DllImport("gdiplus")] internal static extern int GdipCreateStringFormat(int attributes, ushort language, out nint format);
    [DllImport("gdiplus")] internal static extern int GdipSetStringFormatAlign(nint format, int align);
    [DllImport("gdiplus")] internal static extern int GdipSetStringFormatLineAlign(nint format, int align);
    [DllImport("gdiplus")] internal static extern int GdipDeleteStringFormat(nint format);
    [DllImport("gdiplus", CharSet = CharSet.Unicode, ExactSpelling = true)] internal static extern int GdipDrawString(nint graphics, string text, int length, nint font, in R bounds, nint format, nint brush);
}
