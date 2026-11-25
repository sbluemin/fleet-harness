using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using FleetComputerUse.Cursor;
using static FleetComputerUse.Cursor.Win32;
using static Probe;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        try { Verify(args.Length == 1 ? args[0] : null); return 0; }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }

    private static void Verify(string? output)
    {
        if (SetThreadDpiAwarenessContext(-4) == 0) throw Error("Set test DPI context");
        Check(GetCursorPos(out var pointer), "GetCursorPos succeeded");
        nint foreground = GetForegroundWindow();
        Check(foreground != 0, "Interactive foreground HWND exists");
        var foregroundEvents = new List<nint>();
        EventProc callback = (_, _, hwnd, _, _, _, _) => foregroundEvents.Add(hwnd);
        nint eventHook = SetWinEventHook(3, 3, 0, callback, 0, 0, 0);
        Check(eventHook != 0, "Foreground WinEvent hook");
        int samples = 0;
        nint module = GetModuleHandle(null), target = 0, cover = 0;
        string className = "FleetCursorTestFixture";
        WndProc def = DefWindowProc;
        var wc = new WindowClass { ClassName = className, Procedure = def, Instance = module, Background = 6 }; // COLOR_WINDOW + 1
        Check(RegisterClass(wc) != 0, "Register fixture class");
        try
        {
            // Pick an exposed corner of the primary working area; another app may
            // have an always-on-top window. Verify fixture pixels before recording.
            Check(SystemParametersInfoRect(0x30, 0, out Rect work, 0), "Read primary work area");
            int ox = work.Left + 12, oy = work.Top + 12;
            (int X, int Y)[] corners = [(ox, oy), (ox, work.Bottom - 470),
                (work.Right - 840, oy), (work.Right - 840, work.Bottom - 470)];
            int x = 0, y = 0, rx = 0, ry = 0;
            const int rw = 195, rh = 146;
            byte[] baseline = [];
            bool unobstructed = false;
            foreach (var corner in corners)
            {
                (ox, oy) = corner;
                if (target != 0) DestroyWindow(target);
                if (cover != 0) DestroyWindow(cover);
                target = CreateWindowEx(NoActivate | ToolWindow, className, null, Popup, ox + 10, oy + 10, 640, 470, 0, 0, module, 0);
                cover = CreateWindowEx(NoActivate | ToolWindow, className, null, Popup, ox + 355, oy + 230, 480, 340, 0, 0, module, 0);
                Check(target != 0 && cover != 0, "Create fixture windows");
                // Keep the capture fixture above unrelated desktop windows. A
                // uniform crop from a foreground app could otherwise pass as our backdrop.
                Check(Position(target, -1, 0, 0, 0, 0, NoMove | NoSize | Show) &&
                    Position(cover, -1, 0, 0, 0, 0, NoMove | NoSize | Show), "Show capture fixtures without activation");
                Pause(180);
                (x, y) = (ox + 210, oy + 185);
                (rx, ry) = (x - 57, y - 58);
                baseline = Capture(rx, ry, rw, rh);
                // RDP dimming can change the apparent shade of the white backdrop.
                unobstructed = baseline[0] == baseline[1] && baseline[0] == baseline[2] &&
                    Enumerable.Range(0, rw * rh).All(i => baseline[4 * i] == baseline[0] && baseline[4 * i + 1] == baseline[1] && baseline[4 * i + 2] == baseline[2]);
                if (unobstructed) break;
            }
            Check(unobstructed, "Capture region contains only the uniform test fixture");
            bool fixtureTopmost = IsTopmost(target);
            using (var cursor = AICursor.Create())
            {
                nint overlay = FindOverlay();
                Check(((uint)GetWindowLongPtr(overlay, ExtendedStyle) & (Layered | Transparent | NoActivate | ToolWindow)) ==
                    (Layered | Transparent | NoActivate | ToolWindow), "Required extended styles");
                cursor.Track(target);
                Wait(cursor.MoveToAsync(x, y));
                Pause(90);
                Check(IsWindowVisible(overlay), "Production overlay is visible");
                Check(GetWindow(target, Previous) == overlay && GetWindow(overlay, Previous) == cover && IsTopmost(overlay) == fixtureTopmost,
                    "Target immediately below cursor in matching band; cover stays above");
                Check(GetWindowRect(overlay, out Rect rect) && GetDpiForWindow(overlay) is > 0 and var dpi &&
                      Math.Abs(rect.Left + CursorArt.Tip * dpi / 96d - x) < 1 && Math.Abs(rect.Top + CursorArt.Tip * dpi / 96d - y) < 1,
                    "Cursor hotspot matches physical coordinates within one pixel");
                // WindowFromPoint is not a cross-thread mouse-routing test. Query the
                // overlay's own WM_NCHITTEST response without injecting input.
                Check(SendMessageTimeout(overlay, WmNcHitTest, 0, ((y + 16) << 16) | (x + 10), 2, 200, out nint hit) != 0 && hit == -1,
                    "Overlay responds HTTRANSPARENT at opaque body");
                var screenshot = Capture(rx, ry, rw, rh);
                int changes = ChangedPixels(baseline, screenshot);
                if (output is not null)
                {
                    SavePng(Path.Combine(output, "cursor-visible.png"), screenshot, rw, rh);
                    SavePng(Path.Combine(output, "cursor-hidden.png"), baseline, rw, rh);
                }
                Check(changes > 250, $"CAPTUREBLT includes production overlay: {changes} pixels changed");

                var moving = Stopwatch.StartNew();
                var motion = cursor.MoveToAsync(ox + 290, oy + 345);
                var positions = new HashSet<(int, int)>();
                while (!motion.IsCompleted)
                {
                    Check(GetWindowRect(overlay, out var frame), "Read moving window position");
                    positions.Add((frame.Left, frame.Top));
                    Pause(8);
                }
                motion.GetAwaiter().GetResult();
                Check(positions.Count >= 3 && moving.ElapsedMilliseconds < 390,
                    $"Motion produced {positions.Count} distinct window origins in {moving.ElapsedMilliseconds} ms");
                Wait(cursor.MoveToAsync(x, y));
                Pause(140);
                cursor.Feedback(CursorFeedback.RightClick);
                Pause(135);
                var pulse = Capture(rx, ry, rw, rh);
                Check(ChangedPixels(screenshot, pulse) > 250, "Right-click pulse visibly changes pixels");
                if (output is not null) SavePng(Path.Combine(output, "cursor-right-click.png"), pulse, rw, rh);
                foreach (var feedback in new[] { CursorFeedback.Click, CursorFeedback.DoubleClick, CursorFeedback.ScrollUp,
                             CursorFeedback.ScrollDown, CursorFeedback.ScrollLeft, CursorFeedback.ScrollRight, CursorFeedback.TypingOn,
                             CursorFeedback.TypingOff, CursorFeedback.DragBegin, CursorFeedback.DragEnd })
                {
                    cursor.Feedback(feedback);
                    Pause(115);
                    if (output is not null && feedback is CursorFeedback.ScrollRight or CursorFeedback.TypingOn or CursorFeedback.DragBegin)
                    {
                        Pause(115);
                        SavePng(Path.Combine(output, $"cursor-{feedback}.png"), Capture(rx, ry, rw, rh), rw, rh);
                    }
                    if (feedback == CursorFeedback.ScrollRight) Pause(550);
                }

                // Put a window between cursor and target; the overlay must repair its own order, not the target's.
                Check(Position(cover, overlay, 0, 0, 0, 0, NoMove | NoSize), "Interleave cover for reorder test");
                WaitFor(() => GetWindow(target, Previous) == overlay && GetWindow(overlay, Previous) == cover, "160 ms reorder repairs adjacency");
                var obscured = Capture(ox + 400, oy + 275, 160, 125);
                Wait(cursor.MoveToAsync(ox + 455, oy + 329));
                Pause(100);
                Check(ChangedPixels(obscured, Capture(ox + 400, oy + 275, 160, 125)) == 0, "Foreground cover occludes cursor");

                Check(Position(cover, -1, 0, 0, 0, 0, NoMove | NoSize), "Create topmost predecessor");
                Check(Position(target, cover, 0, 0, 0, 0, NoMove | NoSize) && IsTopmost(target), "Promote fixture target into TOPMOST below cover");
                WaitFor(() => IsTopmost(overlay) && GetWindow(target, Previous) == overlay && GetWindow(overlay, Previous) == cover,
                    "Topmost target keeps exact ordering within its band");
                Check(Position(target, -2, 0, 0, 0, 0, NoMove | NoSize), "Demote fixture target");
                WaitFor(() => !IsTopmost(overlay) && GetWindow(target, Previous) == overlay, "Cursor leaves TOPMOST when target demotes");
                Check(Position(cover, -2, 0, 0, 0, 0, NoMove | NoSize), "Demote fixture cover");
                Check(Position(target, -1, 0, 0, 0, 0, NoMove | NoSize), "Move fixture target to head of TOPMOST");
                WaitFor(() => IsTopmost(overlay) && GetWindow(target, Previous) == overlay, "Cursor tracks target at head of TOPMOST");
                cursor.Track(0);
                WaitFor(() => !IsWindowVisible(overlay) && !IsTopmost(overlay), "Clearing target hides and demotes cursor");
                Check(Position(target, -2, 0, 0, 0, 0, NoMove | NoSize), "Restore fixture target to normal band");
                cursor.Track(target);
                Wait(cursor.MoveToAsync(ox + 455, oy + 329));
                Check(IsWindowVisible(overlay), $"Overlay returns after retracking: target=0x{target:x} previous=0x{GetWindow(target, Previous):x} cursor=0x{overlay:x} cursorPrevious=0x{GetWindow(overlay, Previous):x} cursorNext=0x{GetWindow(overlay, Next):x}");

                using (var cancel = new CancellationTokenSource())
                {
                    var cancelled = cursor.MoveToAsync(x, y, cancel.Token);
                    Pause(40);
                    cancel.Cancel();
                    try { Wait(cancelled); throw new InvalidOperationException("Cancellation completed successfully"); }
                    catch (OperationCanceledException ex) when (ex.CancellationToken == cancel.Token) { }
                }
                Check(IsWindowVisible(overlay), "Active movement cancels without removing the overlay");

                ShowWindow(target, 6); // SW_MINIMIZE: target is not the foreground fixture.
                WaitFor(() => IsIconic(target) && !IsWindowVisible(overlay), "Minimized target hides overlay");
                ShowWindow(target, 4); // SW_SHOWNOACTIVATE restores to recent position and size.
                if (IsIconic(target)) throw new InvalidOperationException("Fixture did not restore");
                Wait(cursor.MoveToAsync(x, y));
                ShowWindow(target, 0);
                WaitFor(() => !IsWindowVisible(overlay), "Hidden target hides overlay");
                ShowAtTop(target);
                Wait(cursor.MoveToAsync(x, y));
                Check(DwmSetWindowAttribute(target, 13, 1, sizeof(int)) == 0, "Cloak fixture using DWM");
                WaitFor(() => !IsWindowVisible(overlay), "Cloaked target hides overlay");
                Check(DwmSetWindowAttribute(target, 13, 0, sizeof(int)) == 0, "Uncloak fixture using DWM");
                Wait(cursor.MoveToAsync(x, y));
                Pause(3600);
                Check(IsWindowVisible(overlay), "Cursor is still visible before four seconds of idle");
                WaitFor(() => !IsWindowVisible(overlay), "Cursor fades and hides after four seconds of idle", 1100);
                Wait(cursor.MoveToAsync(x, y));
                Check(DestroyWindow(target), "Destroy fixture target");
                target = 0;
                WaitFor(() => !IsWindowVisible(overlay), "Destroyed target hides overlay");
            }
            Sample();
            Check(foregroundEvents.All(hwnd => hwnd == foreground),
                $"No EVENT_SYSTEM_FOREGROUND transition to another HWND (events: {string.Join(", ", foregroundEvents.Select(hwnd => $"0x{hwnd:X}"))})");
            Console.WriteLine($"PASS {samples} samples: GetForegroundWindow=0x{foreground:X}; GetCursorPos=({pointer.X},{pointer.Y}); foreground WinEvents={foregroundEvents.Count}");
        }
        finally
        {
            UnhookWinEvent(eventHook);
            if (target != 0) DestroyWindow(target);
            if (cover != 0) DestroyWindow(cover);
            UnregisterClass(className, module);
            GC.KeepAlive(callback);
            GC.KeepAlive(def);
        }

        void Sample()
        {
            while (PeekMessage(out var message, 0, 0, 0, 1)) DispatchMessage(message);
            var current = GetForegroundWindow();
            if (current != foreground) throw new InvalidOperationException($"Foreground changed: 0x{foreground:X} -> 0x{current:X}");
            if (!GetCursorPos(out var p) || p != pointer) throw new InvalidOperationException($"Pointer changed: {pointer} -> {p}");
            samples++;
        }
        void Pause(int ms)
        {
            var time = Stopwatch.StartNew();
            do { Sample(); Thread.Sleep(5); } while (time.ElapsedMilliseconds < ms);
        }
        void Wait(Task task)
        {
            WaitFor(() => task.IsCompleted, null, 1500);
            task.GetAwaiter().GetResult();
        }
        void WaitFor(Func<bool> test, string? label, int ms = 600)
        {
            var time = Stopwatch.StartNew();
            while (!test() && time.ElapsedMilliseconds < ms) Pause(5);
            Check(test(), label ?? "Task completed");
            Sample();
        }
    }

    private static bool IsTopmost(nint hwnd) => (GetWindowLongPtr(hwnd, ExtendedStyle) & Topmost) != 0;
    private static void ShowAtTop(nint hwnd) => Check(Position(hwnd, 0, 0, 0, 0, 0, NoMove | NoSize | Show), "Show fixture without activation");
    internal static void Check(bool result, string label)
    {
        if (!result) throw new InvalidOperationException(label);
        // The motion loop reads every sampled position; keep stdout useful but compact.
        if (label != "Read moving window position" && label != "Task completed") Console.WriteLine($"PASS {label}");
    }

    private static nint FindOverlay()
    {
        nint found = 0;
        EnumWindows((hwnd, _) =>
        {
            var name = new System.Text.StringBuilder(128);
            GetClassName(hwnd, name, name.Capacity);
            if (!name.ToString().StartsWith(CursorOverlay.WindowClassPrefix, StringComparison.Ordinal) ||
                ((uint)GetWindowLongPtr(hwnd, ExtendedStyle) & Layered) == 0 ||
                GetWindowThreadProcessId(hwnd, out var pid) == 0 || pid != Environment.ProcessId) return true;
            found = hwnd;
            return false;
        }, 0);
        if (found == 0) throw new InvalidOperationException("Overlay not found");
        return found;
    }

    private static byte[] Capture(int x, int y, int width, int height)
    {
        DwmFlush();
        nint display = GetDC(0), memory = 0, bitmap = 0, old = 0;
        try
        {
            if (display == 0) throw Error("Get capture DC");
            memory = CreateCompatibleDC(display);
            if (memory == 0) throw Error(nameof(CreateCompatibleDC));
            var info = new BitmapInfo { Size = 40, Width = width, Height = -height, BitCount = 32, Planes = 1 };
            bitmap = CreateDIBSection(memory, info, 0, out var data, 0, 0);
            if (bitmap == 0) throw Error(nameof(CreateDIBSection));
            old = SelectObject(memory, bitmap);
            if (old == 0 || old == -1) throw Error(nameof(SelectObject));
            if (!BitBlt(memory, 0, 0, width, height, display, x, y, 0x40cc0020)) throw Error("CAPTUREBLT");
            GdiFlush();
            var pixels = new byte[width * height * 4];
            Marshal.Copy(data, pixels, 0, pixels.Length);
            return pixels;
        }
        finally
        {
            if (old != 0 && old != -1) SelectObject(memory, old);
            if (bitmap != 0) DeleteObject(bitmap);
            if (memory != 0) DeleteDC(memory);
            if (display != 0) ReleaseDC(0, display);
        }
    }

    private static int ChangedPixels(byte[] a, byte[] b)
    {
        int diff = 0;
        for (int i = 0; i < a.Length; i += 4)
            if (Math.Abs(a[i] - b[i]) + Math.Abs(a[i + 1] - b[i + 1]) + Math.Abs(a[i + 2] - b[i + 2]) > 12) diff++;
        return diff;
    }

    private static void SavePng(string path, byte[] bgra, int width, int height)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        using var file = File.Create(path);
        file.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        Span<byte> header = stackalloc byte[13];
        header.Clear();
        BinaryPrimitives.WriteInt32BigEndian(header, width);
        BinaryPrimitives.WriteInt32BigEndian(header[4..], height);
        header[8] = 8; header[9] = 2;
        Chunk("IHDR"u8, header);
        using var buffer = new MemoryStream();
        using (var zlib = new ZLibStream(buffer, CompressionLevel.Optimal, true))
        {
            var row = new byte[1 + width * 3];
            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++)
                {
                    int i = (y * width + x) * 4;
                    row[1 + x * 3] = bgra[i + 2]; row[2 + x * 3] = bgra[i + 1]; row[3 + x * 3] = bgra[i];
                }
                zlib.Write(row);
            }
        }
        Chunk("IDAT"u8, buffer.GetBuffer().AsSpan(0, (int)buffer.Length));
        Chunk("IEND"u8, []);

        void Chunk(ReadOnlySpan<byte> type, ReadOnlySpan<byte> content)
        {
            Span<byte> value = stackalloc byte[4];
            BinaryPrimitives.WriteInt32BigEndian(value, content.Length);
            file.Write(value); file.Write(type); file.Write(content);
            uint crc = uint.MaxValue;
            foreach (byte b in type) Update(b);
            foreach (byte b in content) Update(b);
            BinaryPrimitives.WriteUInt32BigEndian(value, ~crc);
            file.Write(value);
            void Update(byte b)
            {
                crc ^= b;
                for (int i = 0; i < 8; i++) crc = (crc >> 1) ^ ((crc & 1) != 0 ? 0xedb88320u : 0);
            }
        }
    }
}

internal static class Probe
{
    internal delegate bool EnumWindow(nint hwnd, nint param);
    [DllImport("user32")] internal static extern bool EnumWindows(EnumWindow callback, nint parameter);
    [DllImport("user32", CharSet = CharSet.Unicode)] internal static extern int GetClassName(nint hwnd, System.Text.StringBuilder name, int size);
    [DllImport("user32")] internal static extern bool GetCursorPos(out Point point);
    [DllImport("user32")] internal static extern nint GetForegroundWindow();
    [DllImport("user32", CharSet = CharSet.Unicode)] internal static extern nint SendMessageTimeout(nint hwnd, uint message, nuint wParam, nint lParam, uint flags, uint ms, out nint result);
    [DllImport("user32", CharSet = CharSet.Unicode)] internal static extern bool PeekMessage(out Msg message, nint window, uint min, uint max, uint remove);
    [DllImport("user32", EntryPoint = "SystemParametersInfoW")] internal static extern bool SystemParametersInfoRect(uint action, uint param, out Rect rect, uint flags);
    [DllImport("dwmapi")] internal static extern int DwmFlush();
    [DllImport("dwmapi")] internal static extern int DwmSetWindowAttribute(nint hwnd, uint attribute, in int value, uint size);
    [DllImport("gdi32", SetLastError = true)] internal static extern bool BitBlt(nint destination, int x, int y, int w, int h, nint source, int sx, int sy, uint rop);
    [DllImport("gdi32")] internal static extern bool GdiFlush();
}
