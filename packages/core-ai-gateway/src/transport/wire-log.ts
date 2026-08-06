/**
 * Diagnostic wire logging.
 *
 * Entirely inert unless an in-process target or `FLEET_GATEWAY_WIRE_LOG` names a writable file
 * path. It exists to answer one question the normal request path cannot: what tool schema
 * actually reached the provider, and what argument JSON the model actually produced in reply.
 *
 * Every entry is one JSON line. Serialization never throws and never propagates: a
 * diagnostics failure must not break a live request.
 */
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

export interface WireLogTarget {
  readonly path: string;
  /** 부재 = 회전 없음(무제한 append). env 경로는 항상 이 상태다. */
  readonly maxBytes?: number;
}

export const DEFAULT_WIRE_LOG_MAX_BYTES = 16 * 1024 * 1024;

let overrideTarget: WireLogTarget | null | undefined;
let sizeState: { path: string; maxBytes: number; bytes: number } | undefined;
let preparedPath: string | undefined;

export function setWireLogTarget(target: WireLogTarget | null | undefined): void {
  overrideTarget = target;
  sizeState = undefined;
  preparedPath = undefined;
}

function target(): WireLogTarget | undefined {
  if (overrideTarget === null) return undefined;
  if (overrideTarget !== undefined) return overrideTarget;

  const value = process.env.FLEET_GATEWAY_WIRE_LOG;
  return value !== undefined && value.length > 0 ? { path: value } : undefined;
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

function serializeEntry(ts: string, event: string, payload: unknown): string {
  return `{"ts":${JSON.stringify(ts)},"event":${JSON.stringify(event)},"payload":${safeJson(payload)}}\n`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function trackedBytes(logTarget: WireLogTarget, maxBytes: number): number {
  if (sizeState?.path === logTarget.path && sizeState.maxBytes === maxBytes) {
    return sizeState.bytes;
  }

  let bytes: number;
  try {
    bytes = statSync(logTarget.path).size;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    bytes = 0;
  }
  sizeState = { path: logTarget.path, maxBytes, bytes };
  return bytes;
}

function append(logTarget: WireLogTarget, line: string): void {
  // 부모 디렉터리는 런타임 오버라이드가 지목한 경로에만 만든다. 환경 변수 경로는 호출자 소유라
  // 오늘처럼 부모가 없으면 조용히 기록되지 않는 편이 맞다. 준비는 타깃당 한 번으로 memoize한다 —
  // 스트림 이벤트마다 기록되는 경로라 매 줄 syscall을 얹으면 안 된다.
  if (overrideTarget !== null && overrideTarget !== undefined && preparedPath !== logTarget.path) {
    mkdirSync(dirname(logTarget.path), { recursive: true, mode: 0o700 });
    preparedPath = logTarget.path;
  }

  const maxBytes = logTarget.maxBytes;
  if (maxBytes !== undefined) {
    const currentBytes = trackedBytes(logTarget, maxBytes);
    const lineBytes = Buffer.byteLength(line);
    if (currentBytes + lineBytes > maxBytes) {
      const backupPath = `${logTarget.path}.1`;
      rmSync(backupPath, { force: true });
      try {
        renameSync(logTarget.path, backupPath);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      sizeState = { path: logTarget.path, maxBytes, bytes: 0 };
    }
  }

  appendFileSync(logTarget.path, line, { encoding: "utf8", mode: 0o600 });
  if (logTarget.maxBytes !== undefined && sizeState !== undefined) {
    sizeState.bytes += Buffer.byteLength(line);
  }
}

export function wireLog(event: string, payload: unknown): void {
  const logTarget = target();
  if (logTarget === undefined) return;

  try {
    const ts = new Date().toISOString();
    let line = serializeEntry(ts, event, payload);
    if (logTarget.maxBytes !== undefined) {
      const bytes = Buffer.byteLength(line);
      if (bytes > logTarget.maxBytes) {
        line = serializeEntry(ts, "wire_log.entry_omitted", { event, bytes });
      }
    }
    append(logTarget, line);
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
