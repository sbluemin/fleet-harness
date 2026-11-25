using static FleetComputerUse.Cursor.GdiPlus;

namespace FleetComputerUse.Cursor;

internal sealed class CursorArt : IDisposable
{
    internal const int Width = 148, Height = 116, Tip = 52;
    private const uint White = 0xffffffff;
    // sRGB conversions of the OKLCH tokens in the macOS CursorTokens.swift.
    private static readonly uint Badge = Color(.57, .16), Vivid = Color(.57, .24), Lift = Color(.68, .15), Shadow = Color(.28, .12);
    private static readonly uint[] GradientColors = [Lift, Badge, Vivid];
    private static readonly float[] GradientStops = [0, .55f, 1];
    private static readonly float[] Dashes = [2.5f, 2f]; // GDI+ units are pen widths.
    private nint body, gradient, font, format, whiteBrush;
    private readonly List<(double Start, bool Square)> ripples = [];
    private bool typing, dragging;
    private double typingChange, typingFrom, dragChange, dragFrom, pressStart, scrollStart;
    private int clicks, direction;
    private double wiggleStart;

    internal CursorArt()
    {
        try
        {
            Check(GdipCreatePath(0, out body));
            MakeBody(body);
            var a = new P(4, 0);
            var b = new P(14, 29);
            Check(GdipCreateLineBrush(a, b, Lift, Vivid, 2, out gradient));
            Check(GdipSetLinePresetBlend(gradient, GradientColors, GradientStops, GradientStops.Length));
            Check(GdipCreateFontFamilyFromName("Segoe UI", 0, out var family));
            try { Check(GdipCreateFont(family, 10.5f, 1, 2, out font)); }
            finally { GdipDeleteFontFamily(family); }
            Check(GdipCreateStringFormat(0x5000, 0, out format)); // NoWrap | NoClip
            Check(GdipSetStringFormatAlign(format, 1));
            Check(GdipSetStringFormatLineAlign(format, 1));
            Check(GdipCreateSolidFill(White, out whiteBrush));
            Reset();
        }
        catch { Dispose(); throw; }
    }

    internal void Reset()
    {
        ripples.Clear();
        typing = dragging = false;
        clicks = 0;
        typingFrom = dragFrom = 0;
        typingChange = dragChange = pressStart = scrollStart = wiggleStart = double.NegativeInfinity;
    }

    internal void Feedback(CursorFeedback kind, double now)
    {
        switch (kind)
        {
            case CursorFeedback.Click:
            case CursorFeedback.DoubleClick:
            case CursorFeedback.RightClick:
                clicks = kind == CursorFeedback.DoubleClick ? 2 : 1;
                pressStart = now;
                if (kind == CursorFeedback.RightClick) wiggleStart = now;
                Ripple(now, kind == CursorFeedback.RightClick);
                if (clicks == 2) Ripple(now + .17, false);
                break;
            case CursorFeedback.ScrollUp:
            case CursorFeedback.ScrollRight:
            case CursorFeedback.ScrollDown:
            case CursorFeedback.ScrollLeft:
                direction = kind switch { CursorFeedback.ScrollUp => 0, CursorFeedback.ScrollRight => 1, CursorFeedback.ScrollDown => 2, _ => 3 };
                scrollStart = now;
                break;
            case CursorFeedback.TypingOn:
            case CursorFeedback.TypingOff:
                if (typing == (kind == CursorFeedback.TypingOn)) break;
                typingFrom = TypingAmount(now);
                typing = !typing;
                typingChange = now;
                break;
            case CursorFeedback.DragBegin:
            case CursorFeedback.DragEnd:
                if (dragging == (kind == CursorFeedback.DragBegin)) break;
                dragFrom = DragAmount(now);
                dragging = !dragging;
                dragChange = now;
                if (!dragging) Ripple(now, false);
                break;
        }
    }

    private void Ripple(double start, bool square)
    {
        if (ripples.Count == 8) ripples.RemoveAt(0);
        ripples.Add((start, square));
    }

    internal bool IsAnimating(double now, bool reduceMotion) =>
        (!reduceMotion && (typing || dragging)) || now - typingChange < .22 || now - dragChange < .22 ||
        now - pressStart < clicks * .30 || now - scrollStart < .62 ||
        ripples.Exists(r => now - r.Start < (r.Square ? .62 : .52));

    internal void Draw(nint g, float pixelScale, float tipX, float tipY, double now, double visibleAge,
        double fadeAge, bool reduceMotion, double vx, double vy, double settle, double settleAxis, double lagX, double lagY)
    {
        Check(GdipResetWorldTransform(g));
        Check(GdipGraphicsClear(g, 0));
        Translate(g, tipX, tipY);
        double pop = reduceMotion ? 1 : 1 - .45 * Math.Exp(-visibleAge * 16) * Math.Cos(visibleAge * 23);
        if (!reduceMotion && fadeAge >= 0) pop = 1 - .3 * Soft(fadeAge / .22);
        Scale(g, pop * pixelScale);

        for (var i = ripples.Count - 1; i >= 0; i--)
        {
            var r = ripples[i];
            var t = (now - r.Start) / (r.Square ? .62 : .52);
            if (t >= 1) ripples.RemoveAt(i);
            else if (t > 0) DrawRipple(g, t, r.Square, reduceMotion);
        }

        double drag = DragAmount(now);
        if (drag > 0)
        {
            Check(GdipSaveGraphics(g, out var state));
            if (!reduceMotion) Rotate(g, (now - dragChange) * (360 / 3.2));
            Scale(g, dragging && !reduceMotion ? .4 + .6 * drag : 1);
            Shape(g, -17, -17, 34, 34, 17, Alpha(Badge, .12 * drag), Alpha(Badge, drag), 2, true);
            Check(GdipRestoreGraphics(g, state));
        }

        Check(GdipSaveGraphics(g, out var pointerState));
        if (!reduceMotion)
        {
            double speed = Math.Sqrt(vx * vx + vy * vy);
            double theta = (speed < 30 ? settleAxis : Math.Atan2(vy, vx)) * (180 / Math.PI);
            double along = (1 + Math.Tanh(speed / 4200) * .40) * (1 + settle);
            Rotate(g, theta + Math.Clamp(vx / 9000, -.2, .2) * 180 / Math.PI);
            Check(GdipScaleWorldTransform(g, (float)along, (float)(1 / Math.Sqrt(along))));
            Rotate(g, -theta);
            double wiggle = now - wiggleStart;
            if (wiggle < .42) Rotate(g, Math.Sin(wiggle / .42 * 3 * Math.PI) * 15 * (1 - wiggle / .42));
            double scroll = now - scrollStart;
            if (scroll < .30 && direction % 2 == 0)
                Translate(g, 0, (direction == 0 ? -2.5 : 2.5) * Math.Sin(Math.PI * scroll / .30));
        }
        double breath = reduceMotion ? 1 : 1 + .0175 * (1 - Math.Cos(visibleAge * (2 * Math.PI / 3)));
        Scale(g, breath * PressAmount(now) * (1 - .12 * drag));
        Check(GdipSaveGraphics(g, out var shadowState));
        Translate(g, 0, 3);
        Stroke(g, body, Alpha(Shadow, .055), 10);
        Stroke(g, body, Alpha(Shadow, .10), 7);
        Stroke(g, body, Alpha(Shadow, .17), 4);
        Check(GdipRestoreGraphics(g, shadowState));
        Stroke(g, body, Alpha(Shadow, .30), 4.5f);
        Stroke(g, body, White, 3);
        Check(GdipFillPath(g, gradient, body));
        Check(GdipSaveGraphics(g, out var glossState));
        Translate(g, 8, 11);
        Rotate(g, -30);
        Ellipse(g, -4.2f, -2.6f, 8.4f, 5.2f, Alpha(White, .34));
        Check(GdipRestoreGraphics(g, glossState));
        Check(GdipRestoreGraphics(g, pointerState));

        Translate(g, lagX, lagY);
        DrawBadge(g, now, reduceMotion);
        double progress = (now - scrollStart) / .62;
        if (progress < 1) DrawScroll(g, progress, reduceMotion);
    }

    private void DrawBadge(nint g, double now, bool reduceMotion)
    {
        double amount = TypingAmount(now);
        float width = (float)(40 + 22 * amount);
        Shape(g, 16, 28, width + 2, 20, 10, Alpha(Shadow, .24));
        Shape(g, 17, 27, width, 18, 9, White);
        Shape(g, 18.5f, 28.5f, width - 3, 15, 7.5f, Badge);
        var text = new R((float)(22 + 4 * amount), 27.5f, 30, 18);
        Check(GdipDrawString(g, "Fleet", 5, font, text, format, whiteBrush));
        if (amount <= 0) return;
        for (int i = 0; i < 3; i++)
        {
            double time = now - typingChange - i * .14;
            double hop = reduceMotion || !typing || time < 0 ? 0 : Math.Max(0, 1 - Math.Abs(time % .95 - .2375) / .2375);
            Ellipse(g, 17 + width - 21 + i * 5.2f, (float)(34.3 - hop * 3.2), 3.4f, 3.4f,
                Alpha(White, Math.Min(amount, Math.Max(0, (width - 40 - i * 4) / 10)) * (.55 + .45 * hop)));
        }
    }

    private void DrawScroll(nint g, double t, bool reduceMotion)
    {
        double alpha = Math.Clamp(Math.Min(t / .15, (1 - t) / .2), 0, 1);
        if (alpha <= 0) return;
        Check(GdipSaveGraphics(g, out var state));
        Translate(g, -24, 6);
        if (!reduceMotion) Scale(g, .5 + .55 * Spring(t / .30) - .15 * Soft((t - .80) / .20));
        Shape(g, -13, -11, 26, 26, 13, Alpha(Shadow, .25 * alpha));
        Shape(g, -12, -12, 24, 24, 12, Alpha(White, alpha));
        Shape(g, -10.5f, -10.5f, 21, 21, 10.5f, Alpha(Badge, alpha));
        Rotate(g, direction * 90);
        if (!reduceMotion) Translate(g, 0, 4.5 - 9 * Soft((t % .5) / .45));
        P[] points = [new(-4.5f, 2.2f), new(0, -2.4f), new(4.5f, 2.2f)];
        Check(GdipCreatePen1(Alpha(White, alpha), 2.4f, 2, out var pen));
        try
        {
            Check(GdipSetPenLineJoin(pen, 2));
            Check(GdipSetPenStartCap(pen, 2));
            Check(GdipSetPenEndCap(pen, 2));
            Check(GdipDrawLines(g, pen, points, 3));
        }
        finally { GdipDeletePen(pen); }
        Check(GdipRestoreGraphics(g, state));
    }

    private static void DrawRipple(nint g, double t, bool square, bool reduceMotion)
    {
        double a = Math.Min(t / .12, (1 - t) / .88);
        Check(GdipSaveGraphics(g, out var state));
        double grow = Spring(t);
        if (!reduceMotion)
        {
            Scale(g, square ? .35 + 1.55 * grow : .30 + 1.90 * grow);
            if (square) Rotate(g, -29 * (1 - grow));
        }
        float r = square ? 16 : 18;
        Shape(g, -r, -r, r * 2, r * 2, square ? 9 : r, Alpha(Badge, a * .14), Alpha(White, a), 4.5f);
        Shape(g, -r, -r, r * 2, r * 2, square ? 9 : r, 0, Alpha(Badge, a), 2.4f);
        Check(GdipRestoreGraphics(g, state));
    }

    private double TypingAmount(double t) => Lerp(typingFrom, typing ? 1 : 0, Spring((t - typingChange) / .22));
    private double DragAmount(double t) => Lerp(dragFrom, dragging ? 1 : 0, Spring((t - dragChange) / .20));
    private double PressAmount(double now)
    {
        double elapsed = now - pressStart;
        if (elapsed >= clicks * .30) return 1;
        double cycle = elapsed % .30;
        if (cycle <= .08) return Lerp(1, .8, Soft(cycle / .08));
        double peak = elapsed >= (clicks - 1) * .30 ? 1.07 : 1;
        return cycle < .20 ? Lerp(.8, peak, Spring((cycle - .08) / .12)) : Lerp(peak, 1, Soft((cycle - .20) / .10));
    }

    private static void MakeBody(nint path)
    {
        // The mac cursor rounds off the tip of a tangent teardrop. Translate the
        // quadratic midpoint to the origin so the hotspot stays put when squashed.
        const double r = 10, distance = 25, trim = 8.5, axis = Math.PI / 6;
        double half = Math.Asin(r / distance), tangent = Math.Sqrt(distance * distance - r * r);
        var u = new P((float)Math.Sin(axis), (float)Math.Cos(axis));
        var t1 = new P((float)(Math.Sin(axis - half) * tangent), (float)(Math.Cos(axis - half) * tangent));
        var t2 = new P((float)(Math.Sin(axis + half) * tangent), (float)(Math.Cos(axis + half) * tangent));
        var e1 = new P(t1.X * (float)(trim / tangent), t1.Y * (float)(trim / tangent));
        var e2 = new P(t2.X * (float)(trim / tangent), t2.Y * (float)(trim / tangent));
        var apex = new P((e1.X + e2.X) / 4, (e1.Y + e2.Y) / 4);
        P Shift(P p) => new(p.X - apex.X, p.Y - apex.Y);
        P[] curve = [Shift(e1), Shift(new P(e1.X / 3, e1.Y / 3)), Shift(new P(e2.X / 3, e2.Y / 3)), Shift(e2)];
        Check(GdipAddPathBeziers(path, curve, 4));
        var c = Shift(new P((float)(u.X * distance), (float)(u.Y * distance)));
        var p1 = Shift(t1); var p2 = Shift(t2);
        Check(GdipAddPathLine(path, curve[3].X, curve[3].Y, p2.X, p2.Y));
        var a2 = Math.Atan2(p2.Y - c.Y, p2.X - c.X) * (180 / Math.PI);
        var a1 = Math.Atan2(p1.Y - c.Y, p1.X - c.X) * (180 / Math.PI);
        Check(GdipAddPathArc(path, c.X - (float)r, c.Y - (float)r, 20, 20, (float)a2, (float)((a1 - a2 + 360) % 360)));
        Check(GdipClosePathFigure(path));
    }

    private static void Shape(nint g, float x, float y, float w, float h, float r, uint fill, uint stroke = 0, float penWidth = 0, bool dashed = false)
    {
        Check(GdipCreatePath(0, out var path));
        try
        {
            float d = r * 2;
            if (d == w && d == h) Check(GdipAddPathEllipse(path, x, y, w, h));
            else
            {
                Check(GdipAddPathArc(path, x + w - d, y, d, d, 270, 90));
                Check(GdipAddPathArc(path, x + w - d, y + h - d, d, d, 0, 90));
                Check(GdipAddPathArc(path, x, y + h - d, d, d, 90, 90));
                Check(GdipAddPathArc(path, x, y, d, d, 180, 90));
                Check(GdipClosePathFigure(path));
            }
            if (fill != 0)
            {
                Check(GdipCreateSolidFill(fill, out var brush));
                try { Check(GdipFillPath(g, brush, path)); }
                finally { GdipDeleteBrush(brush); }
            }
            if (stroke != 0) Stroke(g, path, stroke, penWidth, dashed);
        }
        finally { GdipDeletePath(path); }
    }

    private static void Stroke(nint g, nint path, uint color, float width, bool dashed = false)
    {
        Check(GdipCreatePen1(color, width, 2, out var pen));
        try
        {
            Check(GdipSetPenLineJoin(pen, 2));
            if (dashed) Check(GdipSetPenDashArray(pen, Dashes, Dashes.Length));
            Check(GdipDrawPath(g, pen, path));
        }
        finally { GdipDeletePen(pen); }
    }

    private static void Ellipse(nint g, float x, float y, float w, float h, uint color)
    {
        Check(GdipCreateSolidFill(color, out var brush));
        try { Check(GdipFillEllipse(g, brush, x, y, w, h)); }
        finally { GdipDeleteBrush(brush); }
    }

    private static uint Alpha(uint color, double a) => (color & 0x00ffffff) | ((uint)Math.Round(255 * Math.Clamp(a, 0, 1)) << 24);
    private static void Translate(nint g, double x, double y) => Check(GdipTranslateWorldTransform(g, (float)x, (float)y, 0));
    private static void Rotate(nint g, double angle) => Check(GdipRotateWorldTransform(g, (float)angle, 0));
    private static void Scale(nint g, double factor) => Check(GdipScaleWorldTransform(g, (float)factor, (float)factor, 0));
    internal static double Lerp(double from, double to, double t) => from + (to - from) * t;
    internal static double Spring(double t) => Bezier(t, .16, 1, .3, 1);
    internal static double Soft(double t) => Bezier(t, .2, .8, .2, 1);

    private static double Bezier(double x, double x1, double y1, double x2, double y2)
    {
        if (x is <= 0 or >= 1) return Math.Clamp(x, 0, 1);
        static double Coord(double t, double a, double b) => 3 * (1 - t) * t * ((1 - t) * a + t * b) + t * t * t;
        double lo = 0, hi = 1;
        for (int i = 0; i < 18; i++)
        {
            double t = (lo + hi) / 2;
            if (Coord(t, x1, x2) < x) lo = t; else hi = t;
        }
        return Coord((lo + hi) / 2, y1, y2);
    }

    private static uint Color(double lightness, double chroma)
    {
        const double hue = 285 * Math.PI / 180;
        while (true)
        {
            double a = chroma * Math.Cos(hue), b = chroma * Math.Sin(hue);
            double l = Math.Pow(lightness + .3963377774 * a + .2158037573 * b, 3);
            double m = Math.Pow(lightness - .1055613458 * a - .0638541728 * b, 3);
            double s = Math.Pow(lightness - .0894841775 * a - 1.2914855480 * b, 3);
            double red = 4.0767416621 * l - 3.3077115913 * m + .2309699292 * s;
            double green = -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s;
            double blue = -.0041960863 * l - .7034186147 * m + 1.7076147010 * s;
            static bool InGamut(double v) => v is >= -.0005 and <= 1.0005;
            if (chroma == 0 || (InGamut(red) && InGamut(green) && InGamut(blue)))
            {
                static uint Encode(double x) => (uint)Math.Round(255 * Math.Clamp(x <= .0031308 ? 12.92 * x : 1.055 * Math.Pow(x, 1 / 2.4) - .055, 0, 1));
                return 0xff000000 | (Encode(red) << 16) | (Encode(green) << 8) | Encode(blue);
            }
            chroma = Math.Max(0, chroma - .004);
        }
    }

    public void Dispose()
    {
        if (whiteBrush != 0) GdipDeleteBrush(whiteBrush);
        if (format != 0) GdipDeleteStringFormat(format);
        if (font != 0) GdipDeleteFont(font);
        if (gradient != 0) GdipDeleteBrush(gradient);
        if (body != 0) GdipDeletePath(body);
        whiteBrush = format = font = gradient = body = 0;
    }
}
