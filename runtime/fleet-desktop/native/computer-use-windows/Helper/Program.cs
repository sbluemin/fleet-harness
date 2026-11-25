using FleetComputerUse.Cursor;

namespace FleetComputerUse.Helper;

internal static class Program
{
    private const int UsageError = 64; // EX_USAGE

    /// <summary>
    /// Modes mirror the macOS helper: no arguments = persistent NDJSON helper; `--platform` and `--paste-lease` are one-shot
    /// processes that must not initialize the input helper or its self-check; `--cursor-demo` is a standalone AI-cursor trial.
    /// </summary>
    [MTAThread]
    private static int Main(string[] args)
    {
        switch (args.FirstOrDefault())
        {
            case "--platform":
                return args.Length == 1 ? PlatformCommands.Run() : UsageError;
            case "--paste-lease":
                return args.Length == 1 ? PasteLeaseCommand.Run() : UsageError;
            case "--cursor-demo":
                return CursorDemoHost.Run(args.Skip(1).ToArray());
            default:
                return PersistentHost.Run();
        }
    }
}

/// <summary>`--cursor-demo [hwnd]`: runs the cursor module's demo against a window (default: the current foreground window).</summary>
internal static class CursorDemoHost
{
    public static int Run(string[] args)
    {
        nint target = 0;
        if (args.Length > 0)
        {
            var text = args[0].StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? args[0][2..] : args[0];
            var style = args[0].StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? System.Globalization.NumberStyles.HexNumber : System.Globalization.NumberStyles.Integer;
            if (long.TryParse(text, style, System.Globalization.CultureInfo.InvariantCulture, out var value)) target = (nint)value;
        }
        if (target == 0) target = Native.GetForegroundWindow();
        using var cursor = AICursor.Create();
        using var cancel = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancel.Cancel(); };
        try { CursorDemo.Run(cursor, target, cancel.Token).GetAwaiter().GetResult(); }
        catch (OperationCanceledException) { }
        return 0;
    }
}
