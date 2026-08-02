/**
 * Diagnostic wire logging.
 *
 * Entirely inert unless `FLEET_GATEWAY_WIRE_LOG` names a writable file path. It exists to
 * answer one question the normal request path cannot: what tool schema actually reached the
 * provider, and what argument JSON the model actually produced in reply.
 *
 * Every entry is one JSON line. Serialization never throws and never propagates: a
 * diagnostics failure must not break a live request.
 */
import { appendFileSync } from "node:fs";

function target(): string | undefined {
  const value = process.env.FLEET_GATEWAY_WIRE_LOG;
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function wireLogEnabled(): boolean {
  return target() !== undefined;
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, entry: unknown) => {
        if (typeof entry === "bigint") return entry.toString();
        if (typeof entry === "object" && entry !== null) {
          if (seen.has(entry)) return "[circular]";
          seen.add(entry);
        }
        return entry;
      }) ?? "null"
    );
  } catch (error) {
    return JSON.stringify({ serializationError: String(error) });
  }
}

export function wireLog(event: string, payload: unknown): void {
  const path = target();
  if (path === undefined) return;
  try {
    appendFileSync(path, `{"ts":"${new Date().toISOString()}","event":"${event}","payload":${safeJson(payload)}}\n`);
  } catch {
    // Diagnostics must never break the request path.
  }
}

/**
 * Pass-through wrapper that records every canonical event as it streams. Placed at the
 * canonical boundary so one wrapper covers every adapter, including the argument JSON the
 * model emitted (`response.function_call_arguments.done`).
 */
export async function* logCanonicalEvents<T>(
  events: AsyncIterable<T>,
  event: string,
): AsyncGenerator<T> {
  for await (const item of events) {
    wireLog(event, item);
    yield item;
  }
}
