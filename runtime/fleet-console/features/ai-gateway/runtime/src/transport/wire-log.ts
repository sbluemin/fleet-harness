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
import { nextEventBoundaryBytes, parseSseFrameFields } from "./upstream-sse.js";

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

/**
 * Raw provider event payload. `data` is the `JSON.parse` result verbatim — before
 * event-name type fallback, canonical filtering, or tool assembly — and `event` is the SSE
 * `event:` field when the frame carried one. `event` is omitted entirely when absent.
 */
export interface RawWireEventPayload {
  readonly event?: string;
  readonly data: unknown;
}

/** Log one raw provider event under the caller-owned label. Inert when no target is set. */
export function logRawWireEvent(label: string, eventName: string | undefined, data: unknown): void {
  if (!wireLogEnabled()) return;
  wireLog(label, {
    ...(eventName === undefined ? {} : { event: eventName }),
    data,
  } satisfies RawWireEventPayload);
}

// 진단 파싱 상한. wire log 타깃이 켜져 있을 때만 도달하고, 본문이 상한을 넘어도 원본 바이트는
// 그대로 통과한다 — 기록 항목만 빠질 뿐이다.
const RAW_EVENT_MAX_FRAME_BYTES = 1024 * 1024;
const RAW_EVENT_MAX_JSON_BYTES = 16 * 1024 * 1024;

/**
 * Observation tap for passthrough responses. Records each JSON payload exactly as parsed from
 * the upstream body — before projection/model rewrite — then passes the original bytes through
 * unchanged. Unsupported media types, malformed frames, and oversized diagnostics never fail
 * or alter the request, only the diagnostic line is skipped. When no wire log target is set the
 * tap is a pure pass-through with no buffering or parsing.
 */
export async function* logRawPassthroughBody(
  chunks: AsyncIterable<Uint8Array>,
  options: { readonly label: string; readonly contentType?: string | null },
): AsyncGenerator<Uint8Array> {
  if (!wireLogEnabled()) {
    yield* chunks;
    return;
  }
  const mediaType = options.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/event-stream") {
    yield* tapPassthroughSse(chunks, options.label);
    return;
  }
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
    yield* tapPassthroughJson(chunks, options.label);
    return;
  }
  yield* chunks;
}

async function* tapPassthroughSse(
  chunks: AsyncIterable<Uint8Array>,
  label: string,
): AsyncGenerator<Uint8Array> {
  let pending: Uint8Array = new Uint8Array(0);
  let oversizedFrame = false;
  for await (const chunk of chunks) {
    pending = concatBytes(pending, chunk);
    let boundary = nextEventBoundaryBytes(pending);
    while (boundary !== undefined) {
      const frame = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary.length);
      if (!oversizedFrame && frame.byteLength <= RAW_EVENT_MAX_FRAME_BYTES) {
        tapPassthroughFrameBytes(label, frame);
      }
      oversizedFrame = false;
      boundary = nextEventBoundaryBytes(pending);
    }
    if (pending.byteLength > RAW_EVENT_MAX_FRAME_BYTES) {
      // 상한을 넘긴 프레임은 진단만 skip한다. 경계가 청크에 걸쳐 나뉠 수 있으니 separator
      // 길이만큼의 꼬리를 남겨 다음 청크에서 경계를 다시 찾고, 그 뒤 정상 프레임은 계속 기록한다.
      pending = pending.slice(Math.max(0, pending.byteLength - 3));
      oversizedFrame = true;
    }
    yield chunk;
  }
  if (!oversizedFrame && pending.byteLength > 0) {
    tapPassthroughFrameBytes(label, pending);
  }
}

function tapPassthroughFrameBytes(label: string, frameBytes: Uint8Array): void {
  let frame: string;
  try {
    frame = new TextDecoder("utf-8", { fatal: true }).decode(frameBytes);
  } catch {
    return;
  }
  const { event: eventName, data } = parseSseFrameFields(frame);
  if (data.length === 0 || data === "[DONE]") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    // Malformed payloads flow through unchanged; only the diagnostic line is skipped.
    return;
  }
  logRawWireEvent(label, eventName, parsed);
}

async function* tapPassthroughJson(
  chunks: AsyncIterable<Uint8Array>,
  label: string,
): AsyncGenerator<Uint8Array> {
  let pending: Uint8Array = new Uint8Array(0);
  let oversized = false;
  for await (const chunk of chunks) {
    if (!oversized) {
      if (pending.byteLength + chunk.byteLength > RAW_EVENT_MAX_JSON_BYTES) {
        oversized = true;
        pending = new Uint8Array(0);
      } else {
        pending = concatBytes(pending, chunk);
      }
    }
    yield chunk;
  }
  if (oversized || pending.byteLength === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending));
  } catch {
    return;
  }
  logRawWireEvent(label, undefined, parsed);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}
