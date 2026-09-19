import { estimateTokens } from "../../../transport/token-estimate.js";

export const CLAUDE_COMPAT_CONTEXT_WINDOW = 1_000_000;
export const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;
const CLAUDE_COMPACT_RESERVE = 32_000;
export const PROVIDER_COMPACT_RESERVE = 16_000;
const COMPACT_CEILING_EARLY_PERCENT = 88;
const COMPACT_CEILING_LATE_PERCENT = 97;
export const COMPACT_CEILING_CUSTOM_MIN = 70;
export const COMPACT_CEILING_CUSTOM_MAX = 99;

/** Stored compact-timing policy. Absent / null is Auto (window − 16k). */
export type CompactCeiling = "early" | "late" | number;

/**
 * The statuses Claude Code's own retry budget acts on.
 *
 * Documented in Claude Code's error reference: a failure that arrives before the response
 * stream starts is retried up to `CLAUDE_CODE_MAX_RETRIES` (default 10) with exponential
 * backoff and `retry-after` honoured — but only for these codes. Every other status ends the
 * turn at the client, no matter how transient the cause was.
 *
 * `502`, `503`, and `504` are deliberately absent from that list, which is why they must not
 * be what a transient upstream failure reaches Claude Code as.
 */
const CLAUDE_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 429, 500, 529]);

/**
 * What a gateway-side transient failure reports when no upstream status exists.
 *
 * A dropped socket, a stalled stream, or an adapter fault is not the caller's mistake and is
 * usually gone on the next attempt, so it has to land inside {@link CLAUDE_RETRYABLE_STATUSES}.
 * `500` rather than `529`: the gateway cannot claim the provider was overloaded when the
 * evidence is only that its own read failed.
 */
export const GATEWAY_TRANSIENT_ERROR_STATUS = 500;

/**
 * Remap an upstream status Claude Code would refuse to retry onto one it will.
 *
 * A bad-gateway / unavailable / timeout answer from a provider edge is the transient class the
 * client's retry budget exists for, but the client never sees it that way because those codes
 * are not on its list — so the turn dies on a failure that a single retry would have absorbed.
 * Measured 2026-08-21: an upstream answered `503` with an empty body 38.7s after dispatch while
 * the gateway was carrying concurrent streams, and the turn ended there.
 *
 * They become `529` (`overloaded_error`) rather than `500`: the upstream did answer, and what it
 * answered means "not now". That is also the one code Claude Code's retry watchdog will keep
 * retrying indefinitely when an operator turns it on.
 *
 * Statuses the client already retries pass through untouched, and so does every 4xx — a `400`
 * or `413` is a verdict about the request that retrying cannot change.
 */
export function claudeRetryableUpstreamStatus(status: number): number {
  if (CLAUDE_RETRYABLE_STATUSES.has(status)) return status;
  if (status === 502 || status === 503 || status === 504) return 529;
  // Cloudflare-family edge failures carry the same "try again" meaning.
  if (status >= 520 && status <= 524) return 529;
  return status;
}
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
  /** Real provider window mapped onto Claude Code's 200k or `[1m]` 1M coordinate. */
  readonly contextWindow?: number;
  /** Compact-timing policy. Absent is Auto (window − 16k). */
  readonly compactCeiling?: CompactCeiling | null;
  /**
   * Client-requested model id to echo back in place of the provider's wire id.
   * Anthropic passthrough relays the upstream body untouched, so without this the
   * client would see the provider's bare model id and fail to match its own request.
   */
  readonly responseModel?: string;
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

/** Stable sentinels in Claude Code's own client-side compact request and replacement history. */
export const CLAUDE_COMPACT_PROMPT_MARKER =
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.";
export const CLAUDE_COMPACT_CONTINUATION_MARKER =
  "This session is being continued from a previous conversation that ran out of context.";

interface ClaudeCompactMessageLike {
  readonly role?: unknown;
  readonly content: unknown;
}

export function isClaudeCompactSummaryRequest(
  messages: readonly ClaudeCompactMessageLike[],
): boolean {
  return messages.some((message) => message.role === "user"
    && messageTextIncludes(message.content, CLAUDE_COMPACT_PROMPT_MARKER));
}

export function hasClaudeCompactContinuation(
  messages: readonly ClaudeCompactMessageLike[],
): boolean {
  return messages.some((message) => message.role === "user"
    && messageTextIncludes(message.content, CLAUDE_COMPACT_CONTINUATION_MARKER));
}

/** Remove only Claude's private compact instruction block; preserve the conversation it follows. */
export function stripClaudeCompactPrompt<M extends ClaudeCompactMessageLike>(messages: readonly M[]): M[] {
  return stripClaudeMessageBlocks(messages, CLAUDE_COMPACT_PROMPT_MARKER);
}

/** Remove Claude's plaintext replacement summary before replaying the provider's opaque checkpoint. */
export function stripClaudeCompactContinuation<M extends ClaudeCompactMessageLike>(messages: readonly M[]): M[] {
  return stripClaudeMessageBlocks(messages, CLAUDE_COMPACT_CONTINUATION_MARKER);
}

function stripClaudeMessageBlocks<M extends ClaudeCompactMessageLike>(
  messages: readonly M[],
  marker: string,
): M[] {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [message];
    if (typeof message.content === "string") return message.content.includes(marker) ? [] : [message];
    if (!Array.isArray(message.content)) return [message];
    const content = message.content.filter((block) => !(
      isRecord(block)
      && block.type === "text"
      && typeof block.text === "string"
      && block.text.includes(marker)
    ));
    return content.length === 0 ? [] : [{ ...message, content } as M];
  });
}

function messageTextIncludes(content: unknown, marker: string): boolean {
  if (typeof content === "string") return content.includes(marker);
  return Array.isArray(content) && content.some((block) => (
    isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.includes(marker)
  ));
}

/**
 * Map a provider model's occupied input onto the fixed coordinate Claude Code assigns
 * from its model id: 200k without `[1m]`, 1M with it.
 *
 * Claude Code 2.1.227 compacted between 166k/168k on 200k and 966k/968k on 1M,
 * leaving roughly 32k on either coordinate. Scale usage so that observed compact
 * threshold lands 16k before the real provider window instead. This keeps the status
 * line increasing from the first token, while letting a 272k model reach 256k and a
 * 1M model reach 984k before compaction.
 *
 * An upstream-reported window can narrow the catalog value. This matters for routing
 * aliases whose serving model changes per turn: the reported window, when present,
 * is the real capacity the current response occupied. The result is capped at the
 * coordinate so an inconsistent over-window usage cannot strand Claude Code in its
 * manual "context exceeds the limit" state.
 */
export function projectClaudeContextInputTokens(
  inputTokens: number,
  advertisedContextWindow: number | undefined,
  upstreamContextWindow: number | undefined = advertisedContextWindow,
  compactCeiling?: CompactCeiling | null,
): number {
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return inputTokens;
  const advertisedWindow = positiveContextWindow(advertisedContextWindow);
  if (advertisedWindow === undefined) return inputTokens;
  const projectionWindow = positiveContextWindow(upstreamContextWindow) ?? advertisedWindow;
  const coordinate = advertisedWindow >= CLAUDE_COMPAT_CONTEXT_WINDOW
    ? CLAUDE_COMPAT_CONTEXT_WINDOW
    : CLAUDE_DEFAULT_CONTEXT_WINDOW;
  const claudeCompactThreshold = coordinate - CLAUDE_COMPACT_RESERVE;
  const providerCompactThreshold = compactThresholdTokens(projectionWindow, compactCeiling);
  if (providerCompactThreshold <= 0) return Math.min(coordinate, inputTokens);
  return Math.min(
    coordinate,
    Math.ceil(inputTokens * claudeCompactThreshold / providerCompactThreshold),
  );
}

/**
 * Read a projected occupancy back onto the provider's real window.
 *
 * This is the inverse of the map above, and it exists because Claude Code reports its own
 * coordinate — never the provider's — to anything that asks it how full the window is. A
 * surface that prints those tokens verbatim states a 200k window for a 500k model, and the
 * breakdown beside them partitions the same wrong total. Measured on xAI Grok 4.6: the child
 * reported 15,785 of 200,000 while the provider had actually consumed 45,473 of 500,000, and
 * this inverse recovers 45,478 of it — five tokens, invisible at the thousands granularity
 * every caller displays.
 *
 * `claudeCoordinate` is what the child said its window is, and it is checked rather than
 * trusted: only Claude's two real coordinates admit an inverse, so any other value (a host
 * that moved the child's ceiling, a future release with a third coordinate) returns the input
 * untouched instead of inventing a scale. The forward map's upstream-window narrowing has no
 * inverse either — a caller holding only the catalog window cannot know which turn was served
 * by a narrower alias — so the result is an occupancy on the advertised window, never a claim
 * about which model served it.
 */
export function unprojectClaudeContextInputTokens(
  projectedTokens: number,
  advertisedContextWindow: number | undefined,
  claudeCoordinate: number | undefined,
  compactCeiling?: CompactCeiling | null,
): number {
  if (!Number.isFinite(projectedTokens) || projectedTokens < 0) return projectedTokens;
  const advertisedWindow = positiveContextWindow(advertisedContextWindow);
  if (advertisedWindow === undefined) return projectedTokens;
  if (claudeCoordinate !== CLAUDE_DEFAULT_CONTEXT_WINDOW
    && claudeCoordinate !== CLAUDE_COMPAT_CONTEXT_WINDOW) {
    return projectedTokens;
  }
  const claudeCompactThreshold = claudeCoordinate - CLAUDE_COMPACT_RESERVE;
  if (claudeCompactThreshold <= 0) return projectedTokens;
  const providerCompactThreshold = compactThresholdTokens(advertisedWindow, compactCeiling);
  if (providerCompactThreshold <= 0) return projectedTokens;
  return Math.min(
    advertisedWindow,
    Math.round(projectedTokens * providerCompactThreshold / claudeCompactThreshold),
  );
}

/** Tokens of the real provider window at which Claude Code should compact. */
export function compactThresholdTokens(
  window: number,
  compactCeiling?: CompactCeiling | null,
): number {
  if (!Number.isFinite(window) || window <= 0) return window;
  const percent = compactCeilingPercent(compactCeiling);
  if (percent === undefined) return window - PROVIDER_COMPACT_RESERVE;
  return Math.floor(window * percent / 100);
}

function compactCeilingPercent(
  compactCeiling?: CompactCeiling | null,
): number | undefined {
  if (compactCeiling === "early") return COMPACT_CEILING_EARLY_PERCENT;
  if (compactCeiling === "late") return COMPACT_CEILING_LATE_PERCENT;
  if (typeof compactCeiling === "number" && Number.isInteger(compactCeiling)
    && compactCeiling >= COMPACT_CEILING_CUSTOM_MIN
    && compactCeiling <= COMPACT_CEILING_CUSTOM_MAX) {
    return compactCeiling;
  }
  return undefined;
}

export function normalizeCompactCeiling(value: unknown): CompactCeiling | undefined {
  if (value === "early" || value === "late") return value;
  if (typeof value === "number" && Number.isInteger(value)
    && value >= COMPACT_CEILING_CUSTOM_MIN
    && value <= COMPACT_CEILING_CUSTOM_MAX) {
    return value;
  }
  return undefined;
}

/**
 * Rewrite Anthropic input and cache usage in bounded SSE or JSON responses, and
 * optionally restore the client-requested model id over the provider's wire id.
 * Unsupported media types and unparseable payloads remain byte-for-byte intact.
 */
export async function* projectAnthropicResponseUsage(
  chunks: AsyncIterable<Uint8Array>,
  options: AnthropicResponseUsageProjectionOptions,
): AsyncGenerator<Uint8Array> {
  const contextWindow = positiveContextWindow(options.contextWindow);
  const responseModel = typeof options.responseModel === "string"
    && options.responseModel.length > 0
    ? options.responseModel
    : undefined;
  if (contextWindow === undefined && responseModel === undefined) {
    yield* chunks;
    return;
  }

  const mediaType = options.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/event-stream") {
    yield* projectSseUsage(
      chunks,
      contextWindow,
      responseModel,
      positiveLimit(options.maxSseFrameBytes, DEFAULT_MAX_SSE_FRAME_BYTES),
      options.compactCeiling,
    );
    return;
  }
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
    yield* projectJsonUsage(
      chunks,
      contextWindow,
      responseModel,
      positiveLimit(options.maxJsonBytes, DEFAULT_MAX_JSON_BYTES),
      options.compactCeiling,
    );
    return;
  }
  yield* chunks;
}

async function* projectJsonUsage(
  chunks: AsyncIterable<Uint8Array>,
  contextWindow: number | undefined,
  responseModel: string | undefined,
  maxBytes: number,
  compactCeiling?: CompactCeiling | null,
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
  const projected = projectJsonBytes(original, contextWindow, responseModel, compactCeiling);
  yield projected ?? original;
}

async function* projectSseUsage(
  chunks: AsyncIterable<Uint8Array>,
  contextWindow: number | undefined,
  responseModel: string | undefined,
  maxFrameBytes: number,
  compactCeiling?: CompactCeiling | null,
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
        : projectSseFrame(frame, contextWindow, responseModel, compactCeiling);
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

function projectJsonBytes(
  bytes: Uint8Array,
  contextWindow: number | undefined,
  responseModel: string | undefined,
  compactCeiling?: CompactCeiling | null,
): Uint8Array | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  const projected = projectAnthropicUsageEnvelope(parsed, contextWindow, responseModel, compactCeiling);
  return projected.changed
    ? new TextEncoder().encode(JSON.stringify(projected.value))
    : undefined;
}

function projectSseFrame(
  frame: Uint8Array,
  contextWindow: number | undefined,
  responseModel: string | undefined,
  compactCeiling?: CompactCeiling | null,
): Uint8Array | undefined {
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
  const projected = projectAnthropicUsageEnvelope(parsed, contextWindow, responseModel, compactCeiling);
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
  contextWindow: number | undefined,
  responseModel: string | undefined,
  compactCeiling?: CompactCeiling | null,
): Projection<unknown> {
  if (!isRecord(value)) return { changed: false, value };

  let projectedValue = value;
  let changed = false;
  if (contextWindow !== undefined) {
    const topLevelUsage = projectUsageProperty(projectedValue, "usage", contextWindow, compactCeiling);
    if (topLevelUsage.changed) {
      projectedValue = topLevelUsage.value;
      changed = true;
    }

    const message = projectedValue.message;
    if (isRecord(message)) {
      const messageUsage = projectUsageProperty(message, "usage", contextWindow, compactCeiling);
      if (messageUsage.changed) {
        projectedValue = { ...projectedValue, message: messageUsage.value };
        changed = true;
      }
    }
  }

  if (responseModel !== undefined) {
    // 비-스트리밍 JSON은 최상위 model에, SSE message_start 프레임은 message.model에
    // provider의 wire id가 실린다. 어느 쪽이든 클라이언트가 요청한 id로 되돌린다.
    if (typeof projectedValue.model === "string" && projectedValue.model !== responseModel) {
      projectedValue = { ...projectedValue, model: responseModel };
      changed = true;
    }
    const message = projectedValue.message;
    if (isRecord(message) && typeof message.model === "string" && message.model !== responseModel) {
      projectedValue = { ...projectedValue, message: { ...message, model: responseModel } };
      changed = true;
    }
  }
  return { changed, value: projectedValue };
}

function projectUsageProperty(
  container: Record<string, unknown>,
  property: string,
  contextWindow: number,
  compactCeiling?: CompactCeiling | null,
): Projection<Record<string, unknown>> {
  const usage = container[property];
  if (!isRecord(usage)) return { changed: false, value: container };

  const coordinates = ANTHROPIC_INPUT_USAGE_FIELDS.map((field) => {
    const tokens = usage[field];
    return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0
      ? { field, tokens }
      : undefined;
  }).filter((entry): entry is { field: typeof ANTHROPIC_INPUT_USAGE_FIELDS[number]; tokens: number } => (
    entry !== undefined
  ));
  if (coordinates.length === 0) return { changed: false, value: container };

  const total = coordinates.reduce((sum, entry) => sum + entry.tokens, 0);
  const projectedTotal = projectClaudeContextInputTokens(total, contextWindow, contextWindow, compactCeiling);
  if (projectedTotal === total) return { changed: false, value: container };

  const projectedUsage = { ...usage };
  const remainderField = coordinates.some((entry) => entry.field === "input_tokens")
    ? "input_tokens"
    : coordinates[0]!.field;
  let assigned = 0;
  for (const entry of coordinates) {
    if (entry.field === remainderField) continue;
    const projectedTokens = total === 0
      ? 0
      : Math.floor(entry.tokens * projectedTotal / total);
    projectedUsage[entry.field] = projectedTokens;
    assigned += projectedTokens;
  }
  projectedUsage[remainderField] = projectedTotal - assigned;
  return { changed: true, value: { ...container, [property]: projectedUsage } };
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

/** Claude Code's own preamble on a skill body it has loaded into the conversation. */
const CLAUDE_SKILL_BODY_PREFIX = "Base directory for this skill:";
/** Claude Code's own preamble on the skill listing it attaches to a conversation. */
const CLAUDE_SKILL_LISTING_PREFIX = "The following skills are available for use with the Skill tool:";
/** Entry line in that listing: `- <name>: <description>`, continued by unprefixed lines. */
const CLAUDE_SKILL_LISTING_ENTRY = /^- ([A-Za-z0-9_.:-]+): /;
/**
 * Share of a model's real window one skill body may occupy before it is withheld.
 *
 * Calibrated against the catalog so a model that can afford a payload keeps it. At this
 * share the measured 162,681-token skill passes on every window of 1M or more — 16% of
 * one, leaving 824k to work in — and is refused on every window below that, including
 * the 272,000-token model it overran. No branch on the window is needed: the fraction
 * lands the split exactly where affordability does.
 *
 * The largest skill this repository ships estimates at 8,303 tokens, more than 4x under
 * the ceiling this produces for even the smallest catalog window, so an ordinary skill
 * never reaches the rule.
 */
export const CLAUDE_SKILL_BODY_BUDGET_FRACTION = 0.2;

interface ClaudeTextBlockLike {
  readonly type?: unknown;
  readonly text?: unknown;
}

/** Structural shape of an Anthropic message, kept local so this module stays a leaf. */
interface ClaudeMessageLike {
  readonly content: unknown;
  readonly role?: unknown;
}

export interface ClaudeSkillPruneOptions {
  /** The model's real context window. Omit to leave skill bodies untouched. */
  readonly contextWindow?: number;
  /** Upstream wire model id, for the estimator's characters-per-token ratio. */
  readonly model?: string;
  /** Skills already withheld on this connection. Their listing entries go before turn one. */
  readonly withheld?: ReadonlySet<string>;
  /** Share of the window one skill body may occupy. Defaults to the exported fraction. */
  readonly budgetFraction?: number;
}

export interface ClaudeWithheldSkill {
  readonly name: string;
  readonly tokens: number;
}

export interface ClaudeSkillPruneResult<M> {
  readonly messages: readonly M[];
  readonly changed: boolean;
  /** Skill bodies replaced by a stub in this request. */
  readonly withheld: readonly ClaudeWithheldSkill[];
  /** Listing entries removed in this request. */
  readonly delisted: readonly string[];
}

/**
 * Withhold skill payloads a model's window cannot afford, and hide the skills they
 * came from.
 *
 * A Claude Code skill body arrives as one user text block and is re-sent every turn,
 * so an oversized one is a fixed tax the client's own compaction can never reclaim —
 * it only ever shrinks the conversation around it. One measured skill body occupied
 * 162,681 estimated tokens, 60% of a 272,000-token window, before the agent had read
 * a single file.
 *
 * Size is the test, never a name: skills ship inside the client binary, change with
 * every release, and are not on disk until the moment they are loaded, so a list of
 * bad names cannot be written in advance or kept correct. The only layer that can see
 * how large one actually is, is the one the bytes pass through.
 *
 * Withholding a body also teaches the caller that skill's name, which removes its
 * listing entry from then on so the model stops spending a turn loading something it
 * will never receive. The caller owns that set, and its lifetime is the caller's:
 * hold it for the process and the cost is one stubbed turn, ever.
 */
export function pruneClaudeSkillPayloads<M extends ClaudeMessageLike>(
  messages: readonly M[],
  options: ClaudeSkillPruneOptions = {},
): ClaudeSkillPruneResult<M> {
  const budget = skillBodyBudget(options);
  const known = new Set(options.withheld ?? []);
  const withheld: ClaudeWithheldSkill[] = [];
  const delisted: string[] = [];
  let changed = false;

  // Bodies first: one withheld here must also leave the listing in this same request.
  const bodies = messages.map((message) => mapClaudeMessageText(message, (text) => {
    if (budget === undefined || !text.startsWith(CLAUDE_SKILL_BODY_PREFIX)) return text;
    const tokens = estimateTokens(text, options.model);
    if (tokens <= budget) return text;
    const name = claudeSkillNameFromBody(text);
    withheld.push({ name, tokens });
    known.add(name);
    changed = true;
    return withheldClaudeSkillStub(name, tokens, budget);
  }));

  if (known.size === 0) return { messages: bodies, changed, withheld, delisted };

  const listings = bodies.map((message) => mapClaudeMessageText(message, (text) => {
    if (!text.startsWith(CLAUDE_SKILL_LISTING_PREFIX)) return text;
    const next = removeClaudeSkillListingEntries(text, known, delisted);
    if (next !== text) changed = true;
    return next;
  }));

  return { messages: listings, changed, withheld, delisted };
}

function skillBodyBudget(options: ClaudeSkillPruneOptions): number | undefined {
  const window = options.contextWindow;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return undefined;
  const fraction = options.budgetFraction ?? CLAUDE_SKILL_BODY_BUDGET_FRACTION;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) return undefined;
  return Math.floor(window * fraction);
}

function mapClaudeMessageText<M extends ClaudeMessageLike>(
  message: M,
  map: (text: string) => string,
): M {
  const content = message.content;
  if (typeof content === "string") {
    const next = map(content);
    return next === content ? message : { ...message, content: next } as M;
  }
  if (!Array.isArray(content)) return message;
  let changed = false;
  const blocks = content.map((block: unknown) => {
    if (!isClaudeTextBlock(block)) return block;
    const next = map(block.text);
    if (next === block.text) return block;
    changed = true;
    return { ...block, text: next };
  });
  return changed ? { ...message, content: blocks } as M : message;
}

function isClaudeTextBlock(block: unknown): block is { readonly text: string } {
  if (typeof block !== "object" || block === null) return false;
  const candidate = block as ClaudeTextBlockLike;
  return candidate.type === "text" && typeof candidate.text === "string";
}

/** The skill directory's last segment. `.../skills/workflow` is the skill `workflow`. */
function claudeSkillNameFromBody(text: string): string {
  const breakAt = text.indexOf("\n");
  const firstLine = breakAt === -1 ? text : text.slice(0, breakAt);
  const directory = firstLine.slice(CLAUDE_SKILL_BODY_PREFIX.length).trim();
  const segments = directory.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? "";
}

/**
 * A plugin skill is listed under a namespaced name (`fleet:workflow`) but loaded from a
 * directory named for its last segment, so the listing name matches on that tail too.
 */
function claudeSkillListingMatches(entryName: string, withheldName: string): boolean {
  if (withheldName.length === 0) return false;
  if (entryName === withheldName) return true;
  return entryName.slice(entryName.lastIndexOf(":") + 1) === withheldName;
}

function removeClaudeSkillListingEntries(
  text: string,
  withheld: ReadonlySet<string>,
  delisted: string[],
): string {
  const kept: string[] = [];
  let dropping = false;
  for (const line of text.split("\n")) {
    const entry = CLAUDE_SKILL_LISTING_ENTRY.exec(line);
    if (entry) {
      const name = entry[1] ?? "";
      dropping = false;
      for (const candidate of withheld) {
        if (claudeSkillListingMatches(name, candidate)) {
          dropping = true;
          delisted.push(name);
          break;
        }
      }
    }
    if (!dropping) kept.push(line);
  }
  return kept.join("\n");
}

function withheldClaudeSkillStub(name: string, tokens: number, budget: number): string {
  return `[Fleet AI gateway withheld the "${name}" skill: its body is about ${tokens} tokens, `
    + `over the ${budget}-token ceiling one skill may take from this model's context window. `
    + `Read the skill's own files if you need it, or run this work on a model with a larger window.]`;
}

/** Claude Code's client-side Web Search tool. */
const CLAUDE_WEB_SEARCH_TOOL_NAME = "WebSearch";
/** Anthropic's server-side web search tool name. */
const ANTHROPIC_WEB_SEARCH_TOOL_NAME = "web_search";
/** Anthropic's server-side web search tool type. */
const ANTHROPIC_WEB_SEARCH_TOOL_TYPE = "web_search_20250305";

/**
 * Every spelling web search arrives under: two tool names and one server-tool type.
 * The omission matches a tool on either field, so all three withhold together.
 */
const CLAUDE_WEB_SEARCH_TOOL_IDENTIFIERS: readonly string[] = [
  CLAUDE_WEB_SEARCH_TOOL_NAME,
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
];

interface ClaudeToolLike {
  readonly name?: unknown;
  readonly type?: unknown;
}

interface ClaudeToolChoiceLike {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly disable_parallel_tool_use?: unknown;
}

/** Structural shape of an Anthropic tools request, kept local so this module stays a leaf. */
interface ClaudeToolsRequestLike<TTool, TChoice> {
  readonly tools?: readonly TTool[];
  readonly tool_choice?: TChoice;
}

export interface ClaudeToolOmitResult<R> {
  readonly request: R;
  readonly changed: boolean;
}

function matchesToolIdentifier(tool: ClaudeToolLike, identifiers: ReadonlySet<string>): boolean {
  return (typeof tool.name === "string" && identifiers.has(tool.name))
    || (typeof tool.type === "string" && identifiers.has(tool.type));
}

function matchesToolChoice(
  choice: ClaudeToolChoiceLike | undefined,
  identifiers: ReadonlySet<string>,
): boolean {
  return choice?.type === "tool"
    && typeof choice.name === "string"
    && identifiers.has(choice.name);
}

/**
 * Drop named client tool definitions from a request.
 *
 * Past `tool_use` / `tool_result` history stays in `messages` — only the catalog is
 * withheld, because rewriting history would leave a result with no call to answer.
 * A `tool_choice` pinned to a withheld tool is downgraded to `auto`; leaving it would
 * pin the request to a tool the model can no longer see.
 *
 * Which names, and which requests, are the caller's decision. This module knows how
 * Claude Code spells its tools, never which provider deserves them.
 */
export function omitClaudeClientTools<
  TTool extends ClaudeToolLike,
  TChoice extends ClaudeToolChoiceLike,
  R extends ClaudeToolsRequestLike<TTool, TChoice>,
>(request: R, names: Iterable<string>): ClaudeToolOmitResult<R> {
  const identifiers = new Set(names);
  if (identifiers.size === 0) return { request, changed: false };

  const tools = request.tools;
  const kept = tools?.filter((tool) => !matchesToolIdentifier(tool, identifiers));
  const toolsChanged = tools !== undefined && kept !== undefined && kept.length !== tools.length;
  const choice = request.tool_choice;
  const choiceChanged = matchesToolChoice(choice, identifiers);
  if (!toolsChanged && !choiceChanged) {
    return { request, changed: false };
  }

  const { tools: _tools, tool_choice: _toolChoice, ...rest } = request;
  return {
    request: {
      ...rest,
      ...(toolsChanged
        ? (kept.length === 0 ? {} : { tools: kept })
        : (tools === undefined ? {} : { tools })),
      ...(choiceChanged
        ? {
            tool_choice: {
              type: "auto",
              ...(choice?.disable_parallel_tool_use === undefined
                ? {}
                : { disable_parallel_tool_use: choice.disable_parallel_tool_use }),
            } as TChoice,
          }
        : (choice === undefined ? {} : { tool_choice: choice })),
    } as R,
    changed: true,
  };
}

/**
 * Claude Code's own wrap-up directive, injected when the caller's Anthropic quota nears its
 * limit.
 *
 * The client watches `anthropic-ratelimit-unified-*` on its own account and, once the
 * five-hour window passes 95%, pushes a message of its own into the conversation: finish
 * the current step, list three bullets, start no subagents. It is not a user turn — the
 * client marks it meta and never shows it — and it arrives as the last message of the
 * request, right behind the tool results it interrupts.
 *
 * The premise of that directive is the caller's Claude subscription, which has nothing to
 * do with the Cursor, Codex, xAI, Kimi or OpenCode budget actually paying for the turn it
 * lands in. One measured session ran 59 assistant turns entirely on a gateway model and
 * still carried it. So the text either misleads a provider that is nowhere near a limit, or
 * truthfully shrinks the work on one whose spend the number does not describe. Neither is
 * something this gateway should forward, and the strip is unconditional for the same reason
 * the injection is: the request cannot tell whether the account it describes is the account
 * being billed.
 *
 * Shape is the test, never the wording. These sentences ship inside the client binary,
 * three variants already differ between the approaching and grace cases, and any of them
 * can be reworded by the next release — a list of exact strings would go stale silently. A
 * bracketed line opening with `Usage limit ` that is the entire text of its block is not
 * something a person types into a prompt.
 */
const CLAUDE_USAGE_LIMIT_DIRECTIVE = /^\s*\[Usage limit [^\]]*\]\s*$/;

export interface ClaudeUsageLimitStripResult<M> {
  readonly messages: readonly M[];
  readonly changed: boolean;
  /** Directive blocks dropped from this request. */
  readonly removed: number;
}

/**
 * Drop every usage-limit directive from a conversation before it leaves for a provider.
 *
 * A directive owns its whole text block, so removing it empties the message it arrived in
 * and that message goes too — leaving an empty text block behind would be rejected by the
 * wire, and leaving the message with no blocks says nothing either.
 *
 * Removing the last message of a request is the one way this can do harm: a conversation
 * that ends on an assistant turn reads as a continuation to ask for, and one that ends
 * nowhere is not a request at all. Measured, the directive always lands behind a user
 * message (13 of 14 behind tool results), so the guard never fires in the observed shape —
 * it exists because the cost of being wrong once is a failed turn, while the cost of
 * declining to strip is one directive that gets through.
 */
export function stripClaudeUsageLimitDirectives<M extends ClaudeMessageLike>(
  messages: readonly M[],
): ClaudeUsageLimitStripResult<M> {
  let removed = 0;
  const kept: M[] = [];
  for (const message of messages) {
    const stripped = stripUsageLimitBlocks(message);
    removed += stripped.removed;
    if (stripped.message !== null) kept.push(stripped.message);
  }
  if (removed === 0) return { messages, changed: false, removed: 0 };
  const last = kept[kept.length - 1];
  if (last === undefined || last.role === "assistant") {
    return { messages, changed: false, removed: 0 };
  }
  return { messages: kept, changed: true, removed };
}

function stripUsageLimitBlocks<M extends ClaudeMessageLike>(
  message: M,
): { readonly message: M | null; readonly removed: number } {
  const content = message.content;
  if (typeof content === "string") {
    return isClaudeUsageLimitDirective(content)
      ? { message: null, removed: 1 }
      : { message, removed: 0 };
  }
  if (!Array.isArray(content)) return { message, removed: 0 };
  const kept = content.filter(
    (block: unknown) => !(isClaudeTextBlock(block) && isClaudeUsageLimitDirective(block.text)),
  );
  const removed = content.length - kept.length;
  if (removed === 0) return { message, removed: 0 };
  if (kept.length === 0) return { message: null, removed };
  return { message: { ...message, content: kept } as M, removed };
}

/**
 * The surrounding whitespace is matched rather than trimmed away first: every text block of
 * every message reaches this test, skill bodies included, and one of those was measured at
 * 162,681 tokens. `trim()` would copy that string in full before the first character could
 * rule it out, where the anchored pattern rejects it on that character.
 */
function isClaudeUsageLimitDirective(text: string): boolean {
  return CLAUDE_USAGE_LIMIT_DIRECTIVE.test(text);
}

/** Drop Claude Code's Web Search tool definitions, in all three spellings. */
export function omitClaudeWebSearchTools<
  TTool extends ClaudeToolLike,
  TChoice extends ClaudeToolChoiceLike,
  R extends ClaudeToolsRequestLike<TTool, TChoice>,
>(request: R): ClaudeToolOmitResult<R> {
  return omitClaudeClientTools<TTool, TChoice, R>(request, CLAUDE_WEB_SEARCH_TOOL_IDENTIFIERS);
}

/**
 * Anthropic's own client identity and billing metadata, as Claude Code prepends them to
 * `system`.
 *
 * Two separate leaks share one strip because they arrive together and are removed for the
 * same reason. The billing line is Anthropic's internal telemetry — client version and
 * entrypoint — and a third-party provider has no business receiving it. The identity
 * sentence tells the model it is Claude Code or a Claude Agent SDK agent, which is simply
 * false once the turn is served by Gemini, Grok, GPT, Kimi or MiniMax; a model told it is
 * Claude answers as Claude, cites Claude model ids, and describes a product it is not.
 *
 * This is the same judgement the usage-limit strip above makes about a Claude subscription
 * number reaching a provider that is not billing it, with one difference that decides where
 * it runs: that one has to reach native Anthropic requests too, so it sits unconditional in
 * the router. This one must **not** — on the Anthropic passthrough both lines are true and
 * the caller's bytes are forwarded untouched — so it is a policy step every gateway provider
 * declares instead.
 *
 * The two are judged differently, because only one of them is self-identifying. Nothing but
 * that header opens with `x-anthropic-billing-header:`, so a prefix test is enough and has to
 * be: the line carries a client version that changes every release. The identity sentence has
 * no such token — `You are Claude Code` is also how a caller's own prompt can open — so it is
 * matched as one of the exact sentences measured on the wire, not by shape.
 *
 * Two attempts at a shape test are the reason. Anchoring on the opener deleted
 * `You are Claude Code. Always answer in Korean.`; additionally requiring one sentence naming
 * Anthropic still deleted `You are Claude Code, Anthropic's coding assistant, and you must
 * always answer in Korean.` Every heuristic loose enough to survive a rewording is loose
 * enough to swallow a real instruction, because unlike the bracketed usage-limit directive
 * this text is ordinary prose a caller can plausibly write.
 *
 * The asymmetry settles it. Failing to strip a reworded sentence restores the old, loud
 * symptom — the identity leaks and Cloud Code Assist refuses the turn outright — which surfaces
 * on the first run and is fixed by adding the new spelling here. Stripping a caller's real
 * instruction deletes prompt content silently, and nothing downstream can tell it ever
 * existed. So this list is deliberately literal, and going stale is its intended failure mode.
 *
 * Both still have to be the whole of their block: measured across an interactive turn, a
 * headless turn and a subagent turn, Claude Code always ships each on a `system` block of its
 * own, and a block is only ever removed whole.
 */
const CLAUDE_BILLING_HEADER_BLOCK = /^\s*x-anthropic-billing-header:[^\n]*[ \t]*$/;

/** The exact identity sentences measured on the wire: the interactive CLI's, and the Agent SDK's. */
const CLAUDE_CLIENT_IDENTITY_SENTENCES: readonly string[] = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
];

/** Longest sentence plus room for the whitespace a block may be padded with. */
const CLAUDE_IDENTITY_MAX_BLOCK_LENGTH =
  Math.max(...CLAUDE_CLIENT_IDENTITY_SENTENCES.map((sentence) => sentence.length)) + 16;

export interface ClaudeClientIdentityStripResult<B> {
  /** The surviving blocks, or `undefined` when every one of them was metadata. */
  readonly system: readonly B[] | undefined;
  readonly changed: boolean;
  /** Blocks dropped from this request. */
  readonly removed: number;
}

/**
 * Drop Anthropic's client identity and billing blocks from a system prompt.
 *
 * A dropped block leaves nothing behind: emptying its text would keep a blank paragraph in
 * the joined instructions, and on a wire that rejects an empty text block it would fail the
 * turn outright. When the whole prompt was metadata the result is `undefined` rather than an
 * empty array, so the caller drops `system` entirely instead of sending an empty one.
 */
export function stripClaudeClientIdentity<B extends ClaudeTextBlockLike>(
  system: readonly B[] | undefined,
): ClaudeClientIdentityStripResult<B> {
  if (system === undefined) return { system, changed: false, removed: 0 };
  const kept = system.filter((block) => !isClaudeClientIdentityBlock(block));
  const removed = system.length - kept.length;
  if (removed === 0) return { system, changed: false, removed: 0 };
  return { system: kept.length > 0 ? kept : undefined, changed: true, removed };
}

/**
 * The length gate comes before the comparison for the same reason the usage-limit test is
 * anchored: a system block can be the whole of a skill body, and trimming one to compare it
 * would copy the entire string before the first character could rule it out.
 */
function isClaudeClientIdentityBlock(block: ClaudeTextBlockLike): boolean {
  const text = block.text;
  if (typeof text !== "string") return false;
  if (CLAUDE_BILLING_HEADER_BLOCK.test(text)) return true;
  if (text.length > CLAUDE_IDENTITY_MAX_BLOCK_LENGTH) return false;
  const trimmed = text.trim();
  return CLAUDE_CLIENT_IDENTITY_SENTENCES.includes(trimmed);
}
