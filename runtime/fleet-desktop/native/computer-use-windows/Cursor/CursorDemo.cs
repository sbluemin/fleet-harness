using static FleetComputerUse.Cursor.Win32;

namespace FleetComputerUse.Cursor;

public static class CursorDemo
{
    /// <summary>Shows all feedback on an existing visible target without sending input or activating it.</summary>
    public static async Task Run(IAICursor cursor, IntPtr target, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(cursor);
        var (a, b, c) = DemoPoints(target);
        cursor.Track(target);
        try
        {
            await cursor.MoveToAsync(a.X, a.Y, ct).ConfigureAwait(false);
            await Task.Delay(350, ct).ConfigureAwait(false);
            await cursor.MoveToAsync(b.X, b.Y, ct).ConfigureAwait(false);
            foreach (var kind in new[] { CursorFeedback.Click, CursorFeedback.DoubleClick, CursorFeedback.RightClick,
                         CursorFeedback.ScrollUp, CursorFeedback.ScrollDown, CursorFeedback.ScrollLeft, CursorFeedback.ScrollRight,
                         CursorFeedback.TypingOn, CursorFeedback.TypingOff })
            {
                cursor.Feedback(kind);
                await Task.Delay(kind == CursorFeedback.TypingOn ? 1150 : 700, ct).ConfigureAwait(false);
            }
            cursor.Feedback(CursorFeedback.DragBegin);
            await Task.Delay(250, ct).ConfigureAwait(false);
            await cursor.MoveToAsync(c.X, c.Y, ct).ConfigureAwait(false);
            cursor.Feedback(CursorFeedback.DragEnd);
            await Task.Delay(700, ct).ConfigureAwait(false);
        }
        finally
        {
            cursor.Hide(animated: !ct.IsCancellationRequested);
        }
        await Task.Delay(250, ct).ConfigureAwait(false);
    }

    private static (Point, Point, Point) DemoPoints(nint target)
    {
        nint oldDpi = SetThreadDpiAwarenessContext(-4);
        if (oldDpi == 0) throw Error(nameof(SetThreadDpiAwarenessContext));
        try
        {
            if (target == 0 || !IsWindowVisible(target) || IsIconic(target) || !GetClientRect(target, out var rect))
                throw new ArgumentException("A visible target window is required.", nameof(target));
            var origin = new Point(0, 0);
            if (!ClientToScreen(target, ref origin)) throw Error(nameof(ClientToScreen));
            return (new(origin.X + rect.Right / 5, origin.Y + rect.Bottom / 4),
                new(origin.X + rect.Right / 2, origin.Y + rect.Bottom / 3),
                new(origin.X + rect.Right * 2 / 3, origin.Y + rect.Bottom * 2 / 3));
        }
        finally { SetThreadDpiAwarenessContext(oldDpi); }
    }
}
