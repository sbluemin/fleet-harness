using System.Collections.Concurrent;
using System.Text.Json.Nodes;

namespace FleetComputerUse.Helper;

/// <summary>
/// Persistent NDJSON helper (`args:[]`): same framing, queue, watchdog, EOF and shutdown semantics as the macOS helper
/// (HelperMain.swift). One request is handled at a time on a dedicated MTA worker thread.
/// </summary>
internal sealed class PersistentHost
{
    private sealed record Request(long Id, string Method, JsonObject Params);

    private const int LineLimit = 1_048_576;
    private const int QueueLimit = 128;
    private const int WatchdogMs = 15_000;

    private readonly Stream output = Console.OpenStandardOutput();
    private readonly object outputLock = new();
    private readonly BlockingCollection<Request> queue = new(new ConcurrentQueue<Request>(), QueueLimit);
    private readonly CancellationTokenSource lifetime = new();
    private HelperService? service;

    public static int Run()
    {
        var host = new PersistentHost();
        return host.Main();
    }

    private int Main()
    {
        var worker = new Thread(Work) { Name = "Fleet helper worker", IsBackground = false };
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        var reader = new Thread(ReadInput) { Name = "Fleet helper stdin", IsBackground = true };
        reader.Start();
        worker.Join();
        return 0;
    }

    // ---- output ----------------------------------------------------------------------------------------------------

    public void Emit(Obj row)
    {
        var data = Json.Serialize(row);
        lock (outputLock)
        {
            try
            {
                output.Write(data, 0, data.Length);
                output.WriteByte(10);
                output.Flush();
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        }
    }

    private void Fail(long? id, HelperError error, bool isAction = false)
    {
        var detail = new Obj(("code", error.Code), ("message", error.Message));
        if (isAction) detail["dispatch"] = error.Code == "timeout" ? "unknown" : "not_sent";
        if (error.Details != null) detail["details"] = error.Details;
        Emit(new Obj(("id", id), ("ok", false), ("error", detail)));
    }

    // ---- input -----------------------------------------------------------------------------------------------------

    private void ReadInput()
    {
        using var input = Console.OpenStandardInput();
        var line = new MemoryStream();
        var oversize = false;
        var buffer = new byte[16_384];
        try
        {
            while (true)
            {
                var size = input.Read(buffer, 0, buffer.Length);
                if (size <= 0) break;
                for (var i = 0; i < size; i++)
                {
                    var b = buffer[i];
                    if (b == 10)
                    {
                        if (oversize) Fail(null, new HelperError("invalid_params", "JSON line too long"));
                        else if (line.Length > 0) Accept(line.ToArray());
                        line.SetLength(0);
                        oversize = false;
                    }
                    else if (line.Length < LineLimit) line.WriteByte(b);
                    else oversize = true;
                }
            }
            if (!oversize && line.Length > 0) Accept(line.ToArray());
        }
        catch (IOException) { }
        queue.CompleteAdding();
        OnEof();
    }

    private void Accept(byte[] line)
    {
        var row = Json.ParseObject(line);
        if (row == null) { Fail(null, new HelperError("invalid_params", "expected JSON request object")); return; }
        long? id = null;
        try { id = Params.BoundedLong(row["id"], "id", -1, 0, 9_007_199_254_740_991); } catch (HelperError) { }
        if (id is not { } valid || valid < 0 || Json.Text(row["method"]) is not { } method || row["params"] is not JsonObject parameters)
        {
            Fail(id == -1 ? null : id, new HelperError("invalid_params", "id, method and params required"));
            return;
        }
        if (!queue.TryAdd(new Request(valid, method, parameters))) Fail(valid, new HelperError("internal", "request_queue_full"));
    }

    private void OnEof()
    {
        lifetime.Cancel();
        // A worker blocked in a native call must not keep a parentless helper alive.
        new Thread(() => { Thread.Sleep(400); ProcessExit.Now(0); }) { IsBackground = true }.Start();
        try { service?.HideCursor(false); } catch { }
    }

    // ---- worker ----------------------------------------------------------------------------------------------------

    private void Work()
    {
        service = new HelperService();
        Obj check;
        try { check = service.Initialize(lifetime.Token); }
        catch (OperationCanceledException) { ProcessExit.Now(0); return; }
        Emit(new Obj(("event", "ready"), ("protocol", 1)));
        Emit(new Obj(("event", "selfCheck"), ("selfCheck", check)));
        foreach (var request in queue.GetConsumingEnumerable())
        {
            var isAction = request.Method == "act";
            var deadline = new DeadlineToken();
            var record = new DispatchRecord();
            using var cancel = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            using var watchdog = new Timer(_ =>
            {
                if (!deadline.Take()) return;
                cancel.Cancel();
                // After a timeout this process takes no further input; the caller observes first.
                new Thread(() => { Thread.Sleep(400); ProcessExit.Now(1); }) { IsBackground = true }.Start();
                if (record.TimeoutResult is { } sent) Emit(new Obj(("id", request.Id), ("ok", true), ("result", sent)));
                else Fail(request.Id, record.TimeoutError, isAction);
                service.HideCursor(false);
                ProcessExit.Now(1);
            }, null, WatchdogMs, Timeout.Infinite);
            Obj? result = null;
            HelperError? failure = null;
            try { result = service.Handle(request.Method, request.Params, record, cancel.Token); }
            catch (HelperError error) { failure = error; }
            catch (OperationCanceledException) { failure = new HelperError("internal"); }
            catch (Exception) { failure = new HelperError("internal"); }
            watchdog.Change(Timeout.Infinite, Timeout.Infinite);
            // The watchdog answered and owns the exit(1); never race it with a clean exit.
            if (!deadline.Take()) { Thread.Sleep(Timeout.Infinite); return; }
            if (failure != null) Fail(request.Id, failure, isAction);
            else
            {
                Emit(new Obj(("id", request.Id), ("ok", true), ("result", result)));
                if (request.Method == "shutdown") ProcessExit.Now(0);
            }
        }
        service.HideCursor(false);
        ProcessExit.Now(0);
    }

    private sealed class DeadlineToken
    {
        private int pending = 1;
        public bool Take() => Interlocked.Exchange(ref pending, 0) == 1;
    }
}

internal static class ProcessExit
{
    /// <summary>`_exit`: no finalizers, no waiting on blocked threads. The cursor overlay's windows die with the process.</summary>
    public static void Now(int code)
    {
        Native.TerminateProcess(Native.GetCurrentProcess(), (uint)code);
        Environment.Exit(code);
    }
}
