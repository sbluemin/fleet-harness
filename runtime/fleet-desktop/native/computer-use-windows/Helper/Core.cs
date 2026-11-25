using System.Buffers;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace FleetComputerUse.Helper;

/// <summary>JSON object as emitted on the wire. Keys are written in ordinal order like the macOS helper (.sortedKeys).</summary>
internal sealed class Obj : Dictionary<string, object?>
{
    public Obj() { }
    public Obj(params (string Key, object? Value)[] items) { foreach (var (k, v) in items) this[k] = v; }
}

internal static class Json
{
    private static readonly JsonWriterOptions WriterOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, SkipValidation = true };

    public static byte[] Serialize(object? value)
    {
        var buffer = new ArrayBufferWriter<byte>(256);
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions)) Write(writer, value);
        return buffer.WrittenSpan.ToArray();
    }

    public static string SerializeString(object? value) => Encoding.UTF8.GetString(Serialize(value));

    private static void Write(Utf8JsonWriter w, object? v)
    {
        switch (v)
        {
            case null: w.WriteNullValue(); break;
            case string s: w.WriteStringValue(s); break;
            case bool b: w.WriteBooleanValue(b); break;
            case int i: w.WriteNumberValue(i); break;
            case uint u: w.WriteNumberValue(u); break;
            case long l: w.WriteNumberValue(l); break;
            case ulong ul: w.WriteNumberValue(ul); break;
            case double d:
                if (double.IsFinite(d)) w.WriteNumberValue(d); else w.WriteNullValue();
                break;
            case float f: w.WriteNumberValue(f); break;
            case JsonNode node: node.WriteTo(w); break;
            case IDictionary<string, object?> map:
                w.WriteStartObject();
                foreach (var key in map.Keys.OrderBy(k => k, StringComparer.Ordinal))
                {
                    w.WritePropertyName(key);
                    Write(w, map[key]);
                }
                w.WriteEndObject();
                break;
            case System.Collections.IEnumerable list:
                w.WriteStartArray();
                foreach (var item in list) Write(w, item);
                w.WriteEndArray();
                break;
            default: w.WriteStringValue(Convert.ToString(v, CultureInfo.InvariantCulture)); break;
        }
    }

    public static JsonObject? ParseObject(ReadOnlySpan<byte> bytes)
    {
        try { return JsonNode.Parse(bytes, null, new JsonDocumentOptions { MaxDepth = 64 }) as JsonObject; }
        catch (JsonException) { return null; }
    }

    /// <summary>Finite JSON number (never a boolean or string) or null.</summary>
    public static double? Number(JsonNode? node)
    {
        if (node is not JsonValue value || value.GetValueKind() != JsonValueKind.Number) return null;
        if (value.TryGetValue<double>(out var d)) return double.IsFinite(d) ? d : null;
        if (value.TryGetValue<long>(out var l)) return l;
        if (value.TryGetValue<int>(out var i)) return i;
        if (value.TryGetValue<decimal>(out var m)) return (double)m;
        return value.TryGetValue<JsonElement>(out var element) && element.TryGetDouble(out var e) && double.IsFinite(e) ? e : null;
    }

    public static bool? Bool(JsonNode? node)
    {
        if (node is not JsonValue value) return null;
        return value.GetValueKind() switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null };
    }

    public static string? Text(JsonNode? node)
    {
        if (node is not JsonValue value) return null;
        if (value.TryGetValue<JsonElement>(out var element)) return element.ValueKind == JsonValueKind.String ? element.GetString() : null;
        return value.TryGetValue<string>(out var s) ? s : null;
    }
}

internal sealed class HelperError : Exception
{
    public string Code { get; }
    public Obj? Details { get; }
    public HelperError(string code, string message = "", Obj? details = null) : base(message.Length == 0 ? code : message)
    {
        Code = code;
        Details = details;
    }

    public static HelperError Unavailable(string reason = "unknown", string message = "") =>
        new("window_unavailable", message, new Obj(("reason", reason)));
}

/// <summary>Request parameter validation matching the macOS helper's `validateKeys`, `optionalString`, `boundedInt`.</summary>
internal static class Params
{
    public static void ValidateKeys(JsonObject p, ISet<string> allowed)
    {
        var bad = p.Select(kv => kv.Key).Where(k => !allowed.Contains(k)).OrderBy(k => k, StringComparer.Ordinal).FirstOrDefault();
        if (bad != null) throw new HelperError("invalid_params", "unexpected " + bad);
    }

    public static HashSet<string> Keys(params string[] names) => new(names, StringComparer.Ordinal);

    public static int TextLength(string s) => new StringInfo(s).LengthInTextElements;

    public static string? OptionalString(JsonNode? raw, string name, int max)
    {
        if (raw == null) return null;
        var value = Json.Text(raw);
        if (value == null || TextLength(value) > max) throw new HelperError("invalid_params", name);
        return value;
    }

    public static string? OptionalRef(JsonNode? raw)
    {
        var reference = OptionalString(raw, "ref", 24);
        if (reference == null) return null;
        if (!IsRef(reference)) throw new HelperError("invalid_params", "ref");
        return reference;
    }

    public static bool IsRef(string reference) =>
        reference.Length > 1 && reference[0] == 'e' && reference.Skip(1).All(c => c is >= '0' and <= '9');

    public static long BoundedLong(JsonNode? raw, string name, long fallback, long min, long max)
    {
        if (raw == null) return fallback;
        var n = Json.Number(raw);
        if (n == null || Math.Truncate(n.Value) != n.Value || n < min || n > max) throw new HelperError("invalid_params", name);
        return (long)n.Value;
    }

    public static int BoundedInt(JsonNode? raw, string name, int fallback, long min, long max)
    {
        if (raw == null) return fallback;
        var n = Json.Number(raw);
        if (n == null || Math.Truncate(n.Value) != n.Value || n < min || n > max) throw new HelperError("invalid_params", name);
        return (int)n.Value;
    }
}

internal readonly record struct Frame(double X, double Y, double W, double H)
{
    public double Right => X + W;
    public double Bottom => Y + H;
    public bool IsEmpty => W <= 0 || H <= 0;
    public Obj ToJson() => new(("x", X), ("y", Y), ("w", W), ("h", H));
    public bool Contains(double px, double py) => px >= X && px < Right && py >= Y && py < Bottom;
    public bool Intersects(Frame o) => X < o.Right && o.X < Right && Y < o.Bottom && o.Y < Bottom;
    public Frame Intersect(Frame o)
    {
        var x = Math.Max(X, o.X);
        var y = Math.Max(Y, o.Y);
        var r = Math.Min(Right, o.Right);
        var b = Math.Min(Bottom, o.Bottom);
        return r <= x || b <= y ? new Frame(0, 0, 0, 0) : new Frame(x, y, r - x, b - y);
    }
    public Frame Offset(double dx, double dy) => new(X + dx, Y + dy, W, H);
    public double MidX => X + W / 2;
    public double MidY => Y + H / 2;
}

internal static class Clock
{
    public static double Now => Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;
    public static int MillisSince(double start) => (int)((Now - start) * 1000);
    public static void Pause(int ms, CancellationToken ct)
    {
        if (ms <= 0) { ct.ThrowIfCancellationRequested(); return; }
        if (ct.WaitHandle.WaitOne(ms)) ct.ThrowIfCancellationRequested();
    }
}

/// <summary>What the helper has confirmed about a possibly timed-out `act` (see macOS DispatchRecord).</summary>
internal sealed class DispatchRecord
{
    private readonly object gate = new();
    private Obj? confirmed;
    public void Confirmed(string via, IReadOnlyList<string> notes)
    {
        lock (gate)
            confirmed = new Obj(("sent", true), ("via", via), ("notes", notes.ToList()), ("changes", new List<object?>()), ("observation", "timeout"));
    }
    public Obj? TimeoutResult { get { lock (gate) return confirmed; } }
    public HelperError TimeoutError => new("timeout");
}
