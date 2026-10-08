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
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { nextEventBoundaryBytes, parseSseFrameFields } from "./upstream-sse.js";

export interface WireLogFile {
  readonly path: string;
  /** 부재 = 회전 없음(무제한 append). env 경로는 항상 이 상태다. */
  readonly maxBytes?: number;
}

export interface WireLogTarget extends WireLogFile {
  /**
   * 조립된 도구 입력 블록만 담는 별도 회전 파일. 본 로그는 스트림 이벤트마다 한 줄이라 바쁜
   * 세션에서는 1분도 못 버티고 회전한다 — 모델이 낸 tool_use 입력 원문은 그 너머까지 남아야
   * 다음 재현을 한 번에 바이트로 입증할 수 있다. 부재면 기록하지 않는다(env 경로가 그렇다).
   */
  readonly toolInputs?: WireLogFile & { readonly maxBytes: number };
}

export const DEFAULT_WIRE_LOG_MAX_BYTES = 16 * 1024 * 1024;
/**
 * 도구 입력 파일 한 개의 상한. 회전본 하나를 더해 디스크 점유는 이 값의 두 배로 묶인다.
 * 2026-10-08 실측: 네이티브 Anthropic 도구 입력 원문은 49초에 약 20KB였으니, 이 상한이면
 * 같은 부하에서 하루 안팎을 담는다(본 로그는 같은 구간에서 49초).
 */
export const DEFAULT_WIRE_TOOL_INPUT_LOG_MAX_BYTES = 32 * 1024 * 1024;

let overrideTarget: WireLogTarget | null | undefined;
const sizeStates = new Map<string, { maxBytes: number; bytes: number }>();
const preparedDirectories = new Set<string>();

export function setWireLogTarget(target: WireLogTarget | null | undefined): void {
  overrideTarget = target;
  sizeStates.clear();
  preparedDirectories.clear();
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

function trackedBytes(file: WireLogFile, maxBytes: number): { maxBytes: number; bytes: number } {
  const known = sizeStates.get(file.path);
  if (known?.maxBytes === maxBytes) return known;

  let bytes: number;
  try {
    bytes = statSync(file.path).size;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    bytes = 0;
  }
  const state = { maxBytes, bytes };
  sizeStates.set(file.path, state);
  return state;
}

function append(file: WireLogFile, line: string): void {
  // 부모 디렉터리는 런타임 오버라이드가 지목한 경로에만 만든다. 환경 변수 경로는 호출자 소유라
  // 오늘처럼 부모가 없으면 조용히 기록되지 않는 편이 맞다. 준비는 디렉터리당 한 번으로 memoize한다 —
  // 스트림 이벤트마다 기록되는 경로라 매 줄 syscall을 얹으면 안 된다.
  const directory = dirname(file.path);
  if (overrideTarget !== null && overrideTarget !== undefined && !preparedDirectories.has(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    preparedDirectories.add(directory);
  }

  const lineBytes = Buffer.byteLength(line);
  const maxBytes = file.maxBytes;
  const state = maxBytes === undefined ? undefined : trackedBytes(file, maxBytes);
  if (state !== undefined && state.bytes + lineBytes > state.maxBytes) {
    const backupPath = `${file.path}.1`;
    rmSync(backupPath, { force: true });
    try {
      renameSync(file.path, backupPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    state.bytes = 0;
  }

  appendFileSync(file.path, line, { encoding: "utf8", mode: 0o600 });
  if (state !== undefined) state.bytes += lineBytes;
}

function writeEntry(file: WireLogFile, event: string, payload: unknown): void {
  try {
    const ts = new Date().toISOString();
    let line = serializeEntry(ts, event, payload);
    if (file.maxBytes !== undefined) {
      const bytes = Buffer.byteLength(line);
      if (bytes > file.maxBytes) {
        line = serializeEntry(ts, "wire_log.entry_omitted", { event, bytes });
      }
    }
    append(file, line);
  } catch {
    // Diagnostics must never break the request path.
  }
}

export function wireLog(event: string, payload: unknown): void {
  const logTarget = target();
  if (logTarget === undefined) return;
  writeEntry(logTarget, event, payload);
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
  /** Passthrough tap only: the gateway-local id shared by every entry of one response stream. */
  readonly stream?: string;
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
/**
 * What ties one relayed response to the client's own records. Claude Code's transcript keeps the
 * same `requestId` (the provider's `request-id` header) and `message.id` on each assistant entry,
 * and `sessionId` names the transcript itself.
 */
export interface PassthroughWireCorrelation {
  readonly sessionId?: string;
  readonly requestId?: string;
}

export interface PassthroughWireLogOptions {
  readonly label: string;
  readonly contentType?: string | null;
  readonly correlation?: PassthroughWireCorrelation;
}

export async function* logRawPassthroughBody(
  chunks: AsyncIterable<Uint8Array>,
  options: PassthroughWireLogOptions,
): AsyncGenerator<Uint8Array> {
  if (!wireLogEnabled()) {
    yield* chunks;
    return;
  }
  const stream = randomUUID();
  wireLog(`${options.label}.stream`, {
    stream,
    ...(options.correlation?.sessionId === undefined ? {} : { sessionId: options.correlation.sessionId }),
    ...(options.correlation?.requestId === undefined ? {} : { requestId: options.correlation.requestId }),
  });
  const mediaType = options.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/event-stream") {
    yield* tapPassthroughSse(chunks, options, stream);
    return;
  }
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
    yield* tapPassthroughJson(chunks, options.label, stream);
    return;
  }
  yield* chunks;
}

async function* tapPassthroughSse(
  chunks: AsyncIterable<Uint8Array>,
  options: PassthroughWireLogOptions,
  stream: string,
): AsyncGenerator<Uint8Array> {
  const toolInputs = new ToolInputRecorder(options, stream);
  let pending: Uint8Array = new Uint8Array(0);
  let oversizedFrame = false;
  try {
    for await (const chunk of chunks) {
      pending = concatBytes(pending, chunk);
      let boundary = nextEventBoundaryBytes(pending);
      while (boundary !== undefined) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary.length);
        if (!oversizedFrame && frame.byteLength <= RAW_EVENT_MAX_FRAME_BYTES) {
          tapPassthroughFrameBytes(options.label, stream, frame, toolInputs);
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
      tapPassthroughFrameBytes(options.label, stream, pending, toolInputs);
    }
  } finally {
    // 끊긴 스트림의 미완성 블록이야말로 가장 보고 싶은 원문이다. 소비자가 멈춰도 남긴다.
    toolInputs.flushOpen();
  }
}

function tapPassthroughFrameBytes(
  label: string,
  stream: string,
  frameBytes: Uint8Array,
  toolInputs: ToolInputRecorder,
): void {
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
  wireLog(label, {
    stream,
    ...(eventName === undefined ? {} : { event: eventName }),
    data: parsed,
  } satisfies RawWireEventPayload);
  toolInputs.observe(parsed);
}

interface OpenToolInput {
  readonly toolUseId?: string;
  readonly name?: string;
  readonly blockType: string;
  readonly parts: string[];
  bytes: number;
  deltas: number;
}

/**
 * Assembles Anthropic `tool_use` input blocks from relayed events into one record per block,
 * written to the target's `toolInputs` file. `input` is the concatenation of the
 * `input_json_delta.partial_json` strings exactly as the provider streamed them — the model's own
 * argument text, before Claude Code parses it. Inert when the target names no tool input file.
 */
class ToolInputRecorder {
  private readonly file: WireLogTarget["toolInputs"];
  private readonly open = new Map<number, OpenToolInput>();
  private messageId: string | undefined;
  private model: string | undefined;

  constructor(
    private readonly options: PassthroughWireLogOptions,
    private readonly stream: string,
  ) {
    this.file = target()?.toolInputs;
  }

  observe(data: unknown): void {
    if (this.file === undefined || !isRecord(data)) return;
    try {
      this.observeEvent(data);
    } catch {
      // Diagnostics must never break the request path.
    }
  }

  flushOpen(): void {
    for (const index of [...this.open.keys()]) this.finish(index, false);
  }

  private observeEvent(data: Record<string, unknown>): void {
    if (data.type === "message_start" && isRecord(data.message)) {
      if (typeof data.message.id === "string") this.messageId = data.message.id;
      if (typeof data.message.model === "string") this.model = data.message.model;
      return;
    }
    if (typeof data.index !== "number") return;
    if (data.type === "content_block_start" && isRecord(data.content_block)) {
      const block = data.content_block;
      if (typeof block.type !== "string" || !block.type.endsWith("tool_use")) return;
      this.open.set(data.index, {
        blockType: block.type,
        ...(typeof block.id === "string" ? { toolUseId: block.id } : {}),
        ...(typeof block.name === "string" ? { name: block.name } : {}),
        parts: [],
        bytes: 0,
        deltas: 0,
      });
      return;
    }
    const open = this.open.get(data.index);
    if (open === undefined) return;
    if (data.type === "content_block_delta" && isRecord(data.delta)
      && data.delta.type === "input_json_delta" && typeof data.delta.partial_json === "string") {
      const part = data.delta.partial_json;
      open.deltas += 1;
      open.bytes += Buffer.byteLength(part);
      // 파일 상한을 넘는 블록은 어차피 기록되지 않는다 — 원문을 붙들지 않고 크기만 센다.
      if (this.file !== undefined && open.bytes <= this.file.maxBytes) open.parts.push(part);
      else open.parts.length = 0;
      return;
    }
    if (data.type === "content_block_stop") this.finish(data.index, true);
  }

  private finish(index: number, complete: boolean): void {
    const open = this.open.get(index);
    this.open.delete(index);
    if (open === undefined || this.file === undefined) return;
    const { correlation, label } = this.options;
    writeEntry(this.file, "tool_input", {
      stream: this.stream,
      label,
      ...(correlation?.sessionId === undefined ? {} : { sessionId: correlation.sessionId }),
      ...(correlation?.requestId === undefined ? {} : { requestId: correlation.requestId }),
      ...(this.messageId === undefined ? {} : { messageId: this.messageId }),
      ...(this.model === undefined ? {} : { model: this.model }),
      index,
      blockType: open.blockType,
      ...(open.toolUseId === undefined ? {} : { toolUseId: open.toolUseId }),
      ...(open.name === undefined ? {} : { name: open.name }),
      complete,
      deltas: open.deltas,
      inputBytes: open.bytes,
      ...(open.bytes > this.file.maxBytes ? { inputOmitted: true } : { input: open.parts.join("") }),
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function* tapPassthroughJson(
  chunks: AsyncIterable<Uint8Array>,
  label: string,
  stream: string,
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
  wireLog(label, { stream, data: parsed } satisfies RawWireEventPayload);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}
