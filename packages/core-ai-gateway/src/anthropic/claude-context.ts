import { estimateTokens } from "../transport/token-estimate.js";

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
  /** Usage projection denominator. Omit — or pass a window at or below Claude's 200k default — to skip that projection. */
  readonly contextWindow?: number;
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
 *
 * The result is capped at the coordinate itself. Claude Code has no representation
 * for an occupancy above the window it was told the model has: past that point it
 * reports `Context exceeds the <limit>-token limit by <n> tokens — run /compact or
 * /clear to continue.`, handing the session back to a manual step (message observed
 * in Claude Code 2.1.221, 2026-08-04; whether its own auto-compaction still fires
 * from that state was not measured, and the cap keeps sessions out of the band
 * where the answer would matter). A denominator that
 * understates the real window — or an upstream that reports more input than the
 * catalog claims the model holds — would otherwise push the session into that
 * state, so the cap is a floor under the whole projection, not a rounding detail.
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
  return Math.min(
    CLAUDE_COMPAT_CONTEXT_WINDOW,
    Math.ceil(inputTokens * CLAUDE_COMPAT_CONTEXT_WINDOW / projectionWindow),
  );
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
  const contextWindow = canProjectClaudeContextWindow(options.contextWindow)
    ? options.contextWindow
    : undefined;
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
    );
    return;
  }
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
    yield* projectJsonUsage(
      chunks,
      contextWindow,
      responseModel,
      positiveLimit(options.maxJsonBytes, DEFAULT_MAX_JSON_BYTES),
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
  const projected = projectJsonBytes(original, contextWindow, responseModel);
  yield projected ?? original;
}

async function* projectSseUsage(
  chunks: AsyncIterable<Uint8Array>,
  contextWindow: number | undefined,
  responseModel: string | undefined,
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
        : projectSseFrame(frame, contextWindow, responseModel);
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
): Uint8Array | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  const projected = projectAnthropicUsageEnvelope(parsed, contextWindow, responseModel);
  return projected.changed
    ? new TextEncoder().encode(JSON.stringify(projected.value))
    : undefined;
}

function projectSseFrame(
  frame: Uint8Array,
  contextWindow: number | undefined,
  responseModel: string | undefined,
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
  const projected = projectAnthropicUsageEnvelope(parsed, contextWindow, responseModel);
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
): Projection<unknown> {
  if (!isRecord(value)) return { changed: false, value };

  let projectedValue = value;
  let changed = false;
  if (contextWindow !== undefined) {
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
