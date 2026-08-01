export const CLAUDE_COMPAT_CONTEXT_WINDOW = 1_000_000;
export const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_JSON_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SSE_FRAME_BYTES = 1024 * 1024;
const MAX_SSE_SEPARATOR_BYTES = 4;

const ANTHROPIC_INPUT_USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

export interface AnthropicResponseUsageProjectionOptions {
  readonly contentType?: string | null;
  readonly contextWindow: number;
  /** Maximum non-streaming response size retained for JSON rewriting. */
  readonly maxJsonBytes?: number;
  /** Maximum single SSE frame size retained for JSON rewriting. */
  readonly maxSseFrameBytes?: number;
}

interface Projection<T> {
  readonly changed: boolean;
  readonly value: T;
}

interface SseSeparator {
  readonly index: number;
  readonly length: number;
}

/** A provider window that needs Claude Code's 1M compatibility coordinate. */
export function canProjectClaudeContextWindow(contextWindow: number | undefined): boolean {
  return typeof contextWindow === "number"
    && Number.isFinite(contextWindow)
    && contextWindow > CLAUDE_DEFAULT_CONTEXT_WINDOW;
}

/** A provider model whose real context window is at least 1M. */
export function isClaudeOneMillionContextWindow(contextWindow: number | undefined): boolean {
  return typeof contextWindow === "number"
    && Number.isFinite(contextWindow)
    && contextWindow >= CLAUDE_COMPAT_CONTEXT_WINDOW;
}

export function hasClaudeOneMillionMarker(modelId: string): boolean {
  return /\[1m\]$/i.test(modelId);
}

export function stripClaudeOneMillionMarker(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, "");
}

/**
 * Project a marked provider model's input usage onto Claude Code's 1M coordinate.
 * The projection preserves the provider model's occupied-context ratio.
 */
export function projectClaudeContextInputTokens(
  inputTokens: number,
  advertisedContextWindow: number | undefined,
  upstreamContextWindow: number | undefined = advertisedContextWindow,
): number {
  if (
    !Number.isFinite(inputTokens)
    || inputTokens < 0
    || !canProjectClaudeContextWindow(advertisedContextWindow)
  ) {
    return inputTokens;
  }
  const projectionWindow = positiveContextWindow(upstreamContextWindow)
    ?? positiveContextWindow(advertisedContextWindow);
  if (projectionWindow === undefined) return inputTokens;
  return Math.ceil(inputTokens * CLAUDE_COMPAT_CONTEXT_WINDOW / projectionWindow);
}

/**
 * Rewrite Anthropic input and cache usage in bounded SSE or JSON responses.
 * Unsupported media types and unparseable payloads remain byte-for-byte intact.
 */
export async function* projectAnthropicResponseUsage(
  chunks: AsyncIterable<Uint8Array>,
  options: AnthropicResponseUsageProjectionOptions,
): AsyncGenerator<Uint8Array> {
  if (!canProjectClaudeContextWindow(options.contextWindow)) {
    yield* chunks;
    return;
  }

  const mediaType = options.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/event-stream") {
    yield* projectSseUsage(
      chunks,
      options.contextWindow,
      positiveLimit(options.maxSseFrameBytes, DEFAULT_MAX_SSE_FRAME_BYTES),
    );
    return;
  }
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
    yield* projectJsonUsage(
      chunks,
      options.contextWindow,
      positiveLimit(options.maxJsonBytes, DEFAULT_MAX_JSON_BYTES),
    );
    return;
  }
  yield* chunks;
}

async function* projectJsonUsage(
  chunks: AsyncIterable<Uint8Array>,
  contextWindow: number,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let passthrough = false;

  for await (const chunk of chunks) {
    if (passthrough) {
      yield chunk;
      continue;
    }
    if (bufferedBytes + chunk.byteLength > maxBytes) {
      passthrough = true;
      yield* buffered;
      yield chunk;
      continue;
    }
    buffered.push(chunk);
    bufferedBytes += chunk.byteLength;
  }

  if (passthrough || bufferedBytes === 0) return;
  const original = concatChunks(buffered, bufferedBytes);
  const projected = projectJsonBytes(original, contextWindow);
  yield projected ?? original;
}

async function* projectSseUsage(
  chunks: AsyncIterable<Uint8Array>,
  contextWindow: number,
  maxFrameBytes: number,
): AsyncGenerator<Uint8Array> {
  let buffered: Uint8Array = new Uint8Array(0);
  let oversizedFrame = false;

  for await (const chunk of chunks) {
    buffered = concatBytes(buffered, chunk);

    if (oversizedFrame) {
      const separator = findSseSeparator(buffered);
      if (separator === undefined) {
        const retainedBytes = Math.min(MAX_SSE_SEPARATOR_BYTES - 1, buffered.byteLength);
        const flushBytes = buffered.byteLength - retainedBytes;
        if (flushBytes > 0) {
          yield buffered.slice(0, flushBytes);
          buffered = buffered.slice(flushBytes);
        }
        continue;
      }
      const frameEnd = separator.index + separator.length;
      yield buffered.slice(0, frameEnd);
      buffered = buffered.slice(frameEnd);
      oversizedFrame = false;
    }

    for (;;) {
      const separator = findSseSeparator(buffered);
      if (separator === undefined) break;
      const frame = buffered.slice(0, separator.index);
      const separatorBytes = buffered.slice(separator.index, separator.index + separator.length);
      const originalFrame = buffered.slice(0, separator.index + separator.length);
      const projectedFrame = frame.byteLength > maxFrameBytes
        ? undefined
        : projectSseFrame(frame, contextWindow);
      yield projectedFrame === undefined
        ? originalFrame
        : concatBytes(projectedFrame, separatorBytes);
      buffered = buffered.slice(separator.index + separator.length);
    }

    if (buffered.byteLength > maxFrameBytes) {
      const retainedBytes = Math.min(MAX_SSE_SEPARATOR_BYTES - 1, buffered.byteLength);
      const flushBytes = buffered.byteLength - retainedBytes;
      yield buffered.slice(0, flushBytes);
      buffered = buffered.slice(flushBytes);
      oversizedFrame = true;
    }
  }

  if (buffered.byteLength > 0) yield buffered;
}

function projectJsonBytes(bytes: Uint8Array, contextWindow: number): Uint8Array | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  const projected = projectAnthropicUsageEnvelope(parsed, contextWindow);
  return projected.changed
    ? new TextEncoder().encode(JSON.stringify(projected.value))
    : undefined;
}

function projectSseFrame(frame: Uint8Array, contextWindow: number): Uint8Array | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch {
    return undefined;
  }

  const newline = text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : "\r";
  const lines = text.split(/\r\n|\n|\r/);
  const dataIndexes: number[] = [];
  const dataValues: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line !== "data" && !line.startsWith("data:")) continue;
    dataIndexes.push(index);
    const rawValue = line === "data" ? "" : line.slice(5);
    dataValues.push(rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue);
  }
  if (dataIndexes.length === 0) return undefined;

  const payload = dataValues.join("\n");
  if (payload === "[DONE]") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const projected = projectAnthropicUsageEnvelope(parsed, contextWindow);
  if (!projected.changed) return undefined;

  const firstDataIndex = dataIndexes[0];
  const dataIndexSet = new Set(dataIndexes);
  const outputLines: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (index === firstDataIndex) {
      outputLines.push(`data: ${JSON.stringify(projected.value)}`);
    } else if (!dataIndexSet.has(index)) {
      outputLines.push(line);
    }
  }
  return new TextEncoder().encode(outputLines.join(newline));
}

function projectAnthropicUsageEnvelope(
  value: unknown,
  contextWindow: number,
): Projection<unknown> {
  if (!isRecord(value)) return { changed: false, value };

  let projectedValue = value;
  let changed = false;
  const topLevelUsage = projectUsageProperty(projectedValue, "usage", contextWindow);
  if (topLevelUsage.changed) {
    projectedValue = topLevelUsage.value;
    changed = true;
  }

  const message = projectedValue.message;
  if (isRecord(message)) {
    const messageUsage = projectUsageProperty(message, "usage", contextWindow);
    if (messageUsage.changed) {
      projectedValue = { ...projectedValue, message: messageUsage.value };
      changed = true;
    }
  }
  return { changed, value: projectedValue };
}

function projectUsageProperty(
  container: Record<string, unknown>,
  property: string,
  contextWindow: number,
): Projection<Record<string, unknown>> {
  const usage = container[property];
  if (!isRecord(usage)) return { changed: false, value: container };

  let projectedUsage = usage;
  let changed = false;
  for (const field of ANTHROPIC_INPUT_USAGE_FIELDS) {
    const tokens = usage[field];
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) continue;
    const projectedTokens = projectClaudeContextInputTokens(tokens, contextWindow);
    if (projectedTokens === tokens) continue;
    if (!changed) projectedUsage = { ...usage };
    projectedUsage[field] = projectedTokens;
    changed = true;
  }
  return changed
    ? { changed: true, value: { ...container, [property]: projectedUsage } }
    : { changed: false, value: container };
}

function findSseSeparator(bytes: Uint8Array): SseSeparator | undefined {
  for (let index = 0; index < bytes.byteLength - 1; index += 1) {
    const first = bytes[index];
    const second = bytes[index + 1];
    if (first === 10) {
      if (second === 10) return { index, length: 2 };
      if (second === 13 && bytes[index + 2] === 10) return { index, length: 3 };
      continue;
    }
    if (first !== 13) continue;
    if (second === 13) return { index, length: 2 };
    if (second !== 10) continue;
    if (bytes[index + 2] === 10) return { index, length: 3 };
    if (bytes[index + 2] === 13 && bytes[index + 3] === 10) {
      return { index, length: 4 };
    }
  }
  return undefined;
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  return concatChunks([left, right], left.byteLength + right.byteLength);
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function positiveContextWindow(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
