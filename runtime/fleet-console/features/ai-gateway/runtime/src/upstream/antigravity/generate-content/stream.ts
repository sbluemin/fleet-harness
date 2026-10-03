import { randomUUID } from "node:crypto";

import type {
  CanonicalError,
  CanonicalResponseEvent,
  CanonicalUsage,
} from "../../../canonical/index.js";
import { UpstreamProtocolError } from "../../../transport/upstream-sse.js";
import { logRawWireEvent } from "../../../transport/wire-log.js";
import {
  ANTIGRAVITY_REASONING_ORIGIN,
  isAntigravitySignature,
  type AntigravitySignatureLedger,
  type ToolNameCodec,
} from "./wire.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * `usageMetadata`, as Cloud Code Assist reports it.
 *
 * `totalTokenCount` includes the reasoning tokens that `candidatesTokenCount`
 * excludes, so output is reported as the visible tokens plus the hidden ones
 * rather than as `candidatesTokenCount` alone — otherwise a turn that spent 542
 * reasoning tokens and 51 visible ones would bill as 51.
 */
export function antigravityUsage(value: unknown): CanonicalUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = positiveNumber(value.promptTokenCount) ?? 0;
  const visibleOutput = positiveNumber(value.candidatesTokenCount) ?? 0;
  const reasoning = positiveNumber(value.thoughtsTokenCount);
  const cached = positiveNumber(value.cachedContentTokenCount);
  const total = positiveNumber(value.totalTokenCount);
  return {
    input_tokens: inputTokens,
    output_tokens: visibleOutput + (reasoning ?? 0),
    ...(cached === undefined ? {} : { cached_input_tokens: cached }),
    ...(reasoning === undefined ? {} : { reasoning_output_tokens: reasoning }),
    ...(total === undefined ? {} : { total_tokens: total }),
  };
}

/** `{error:{code,message,status}}`, the shape both the body and a stream frame use. */
export function antigravityError(value: unknown): CanonicalError | undefined {
  const error = isRecord(value) ? value.error : undefined;
  if (!isRecord(error)) return undefined;
  const message = typeof error.message === "string" && error.message.length > 0
    ? error.message
    : "Antigravity request failed";
  const status = typeof error.status === "string" ? error.status : undefined;
  const code = typeof error.code === "number" ? error.code : undefined;
  return { type: canonicalErrorType(status, code), message };
}

function canonicalErrorType(status: string | undefined, code: number | undefined): string {
  switch (status) {
    case "UNAUTHENTICATED":
      return "authentication_error";
    case "PERMISSION_DENIED":
      return "permission_error";
    case "RESOURCE_EXHAUSTED":
      return "rate_limit_error";
    case "INVALID_ARGUMENT":
    case "NOT_FOUND":
      return "invalid_request_error";
    case "UNAVAILABLE":
      return "overloaded_error";
    default:
      break;
  }
  if (code === 401) return "authentication_error";
  if (code === 403) return "permission_error";
  if (code === 429) return "rate_limit_error";
  if (code === 400 || code === 404) return "invalid_request_error";
  if (code === 503) return "overloaded_error";
  return "api_error";
}

/** `finishReason` values that mean the candidate finished; `FINISH_REASON_UNSPECIFIED` is documented as unused. */
const ANTIGRAVITY_COMPLETE_REASONS: ReadonlySet<string> = new Set(["STOP", "FINISH_REASON_UNSPECIFIED"]);

/**
 * Safety and content-filter stops, across `finishReason` and `promptFeedback.blockReason` as the
 * Gemini API and Vertex AI document them (`MODEL_ARMOR` and `JAILBREAK` are Vertex-only).
 */
const ANTIGRAVITY_CONTENT_FILTER_REASONS: ReadonlySet<string> = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "MODEL_ARMOR",
  "JAILBREAK",
]);

/**
 * Whether the upstream declared the answer unfinished, and why.
 *
 * Only a cap and a filter have Anthropic stop reasons. Every other stop — `OTHER`,
 * `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, a value newer than this list — keeps the
 * provider's own value, so the downstream wire turns it into an error that names it instead of
 * ending the turn as if the answer were complete.
 *
 * A stream that ends with neither a `finishReason` nor a `blockReason` was cut off without
 * saying so, and becomes the same reasonless error. Every live answer measured 2026-10-04 —
 * text, tool calls, parallel calls and the turn after a tool result, on Gemini 3.8 Flash and
 * 3.1 Pro — ended with `STOP`, so this never fires on a normal answer. gemini-cli
 * (`NO_FINISH_REASON`) exempts a stream that carried a tool call, but every tool-call answer
 * measured here carried `STOP` as well.
 */
function antigravityIncomplete(
  finishReason: string | undefined,
  promptBlockReason: string | undefined,
): { reason?: string } | undefined {
  if (finishReason !== undefined) {
    if (ANTIGRAVITY_COMPLETE_REASONS.has(finishReason)) return undefined;
    if (finishReason === "MAX_TOKENS") return { reason: "max_output_tokens" };
    if (ANTIGRAVITY_CONTENT_FILTER_REASONS.has(finishReason)) return { reason: "content_filter" };
    return { reason: finishReason };
  }
  if (promptBlockReason !== undefined) {
    if (ANTIGRAVITY_CONTENT_FILTER_REASONS.has(promptBlockReason)) return { reason: "content_filter" };
    return { reason: `prompt blocked: ${promptBlockReason}` };
  }
  return {};
}

export interface AntigravityFrame {
  readonly response?: Record<string, unknown>;
  readonly error?: unknown;
}

/**
 * Parse one SSE frame.
 *
 * Cloud Code Assist nests the Gemini payload under `response` and adds its own
 * `traceId`/`metadata` beside it. A frame with neither `response` nor `error` is
 * a keepalive and yields nothing.
 */
export function parseAntigravityFrame(data: string): AntigravityFrame | undefined {
  const trimmed = data.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new UpstreamProtocolError("Antigravity stream frame was not valid JSON");
  }
  if (!isRecord(parsed)) return undefined;
  logRawWireEvent("antigravity.wire.event", undefined, parsed);
  if (isRecord(parsed.error)) return { error: parsed };
  const response = isRecord(parsed.response) ? parsed.response : undefined;
  return response === undefined ? undefined : { response };
}

interface GeminiResponsePart {
  readonly text?: unknown;
  readonly thought?: unknown;
  readonly thoughtSignature?: unknown;
  readonly thought_signature?: unknown;
  readonly functionCall?: unknown;
}

function partSignature(part: GeminiResponsePart): string | undefined {
  const direct = part.thoughtSignature ?? part.thought_signature;
  return isAntigravitySignature(direct) ? direct : undefined;
}

export interface TranslateStreamOptions {
  readonly codec: ToolNameCodec;
  readonly ledger: AntigravitySignatureLedger;
  /** The catalog model id, echoed when the upstream reports none. */
  readonly model: string;
  /**
   * Request-unique prefix for a fabricated `call_id`.
   *
   * `functionCall.id` is optional on this wire. Every live response observed
   * carried one, but where it is absent the id has to be invented — and a call
   * id is the only id here that outlives its own response: the client returns it
   * on the next turn's `tool_result`, and the replayed history is keyed by it.
   * A per-stream counter alone would hand turn 2 the same `agc_0` turn 1 used,
   * and `linkFunctionResponseNames` would then label the earlier call's result
   * with the later call's name. The item ids below stay counter-only because
   * nothing outside one response ever reads them.
   */
  readonly callIdPrefix: string;
}

/**
 * Translate the Gemini stream into canonical events.
 *
 * The ordering is the load-bearing part. A reasoning item is emitted **before**
 * the `function_call` it belongs to, because the Anthropic encoder turns it into
 * a thinking block whose signature the client returns verbatim, and the request
 * translator pairs a thinking block with the tool call that follows it. Emitting
 * the reasoning item after the call would hand the blob to the *next* tool call
 * and fail that turn upstream.
 *
 * Only the first call of a parallel batch carries a signature (measured
 * 2026-08-22: two calls in one turn, blob on the first only), and this pairing
 * reproduces that exactly — the second call gets no reasoning item and replays
 * none.
 */
export async function* translateAntigravityStream(
  frames: AsyncIterable<AntigravityFrame>,
  options: TranslateStreamOptions,
): AsyncGenerator<CanonicalResponseEvent> {
  let started = false;
  let responseId = "";
  let model = options.model;
  let usage: CanonicalUsage | null = null;
  let outputIndex = 0;
  let sequence = 0;

  // A caller that reaches this from JavaScript can still pass nothing; an id
  // reading `agc_undefined_0` would collide exactly as the counter alone did.
  const callIdPrefix = options.callIdPrefix && options.callIdPrefix.length > 0
    ? options.callIdPrefix
    : randomUUID();

  let textItemId: string | undefined;
  let reasoningItemId: string | undefined;
  let finishReason: string | undefined;
  let promptBlockReason: string | undefined;
  let failed: CanonicalError | undefined;

  const snapshot = () => ({ id: responseId, model, usage });

  function* closeText(): Generator<CanonicalResponseEvent> {
    if (textItemId === undefined) return;
    yield { type: "response.output_text.done", item_id: textItemId, output_index: outputIndex, content_index: 0, text: "" };
    outputIndex += 1;
    textItemId = undefined;
  }

  /** Close the open reasoning run, attaching the blob the upstream issued for it. */
  function* closeReasoning(signature: string | undefined): Generator<CanonicalResponseEvent> {
    if (reasoningItemId === undefined && signature === undefined) return;
    const id = reasoningItemId ?? `agr_${sequence++}`;
    yield {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        id,
        type: "reasoning",
        ...(signature === undefined ? {} : { encrypted_content: signature }),
        origin: ANTIGRAVITY_REASONING_ORIGIN,
      },
    };
    outputIndex += 1;
    reasoningItemId = undefined;
  }

  for await (const frame of frames) {
    if (frame.error !== undefined) {
      failed = antigravityError(frame.error) ?? { type: "api_error", message: "Antigravity request failed" };
      break;
    }
    const response = frame.response;
    if (!response) continue;

    if (typeof response.responseId === "string" && responseId.length === 0) responseId = response.responseId;
    if (typeof response.modelVersion === "string" && response.modelVersion.length > 0) {
      model = response.modelVersion;
    }
    const frameUsage = antigravityUsage(response.usageMetadata);
    if (frameUsage) usage = frameUsage;

    if (!started) {
      started = true;
      yield { type: "response.created", response: { id: responseId, model, usage: null } };
    }

    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    const candidate = isRecord(candidates[0]) ? candidates[0] : undefined;
    if (typeof candidate?.finishReason === "string") {
      finishReason = candidate.finishReason;
    }
    // 프롬프트 자체가 차단되면 candidates 없이 promptFeedback.blockReason만 온다.
    const promptFeedback = isRecord(response.promptFeedback) ? response.promptFeedback : undefined;
    if (typeof promptFeedback?.blockReason === "string") {
      promptBlockReason = promptFeedback.blockReason;
    }
    const content = isRecord(candidate?.content) ? candidate.content : undefined;
    const parts: GeminiResponsePart[] = Array.isArray(content?.parts)
      ? content.parts.filter(isRecord)
      : [];

    for (const part of parts) {
      const call = isRecord(part.functionCall) ? part.functionCall : undefined;
      if (call) {
        yield* closeText();
        const signature = partSignature(part);
        yield* closeReasoning(signature);
        const wireName = typeof call.name === "string" ? call.name : "";
        const callId = typeof call.id === "string" && call.id.length > 0
          ? call.id
          : `agc_${callIdPrefix}_${sequence++}`;
        if (signature !== undefined) options.ledger.record(callId, signature);
        const args = JSON.stringify(isRecord(call.args) ? call.args : {});
        const itemId = `agf_${sequence++}`;
        yield {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: {
            id: itemId,
            type: "function_call",
            call_id: callId,
            name: options.codec.fromWire(wireName),
            arguments: "",
          },
        };
        yield { type: "response.function_call_arguments.delta", item_id: itemId, output_index: outputIndex, delta: args };
        yield { type: "response.function_call_arguments.done", item_id: itemId, output_index: outputIndex, arguments: args };
        yield {
          type: "response.output_item.done",
          output_index: outputIndex,
          item: {
            id: itemId,
            type: "function_call",
            call_id: callId,
            name: options.codec.fromWire(wireName),
            arguments: args,
          },
        };
        outputIndex += 1;
        continue;
      }

      const text = typeof part.text === "string" ? part.text : "";
      const signature = partSignature(part);
      if (part.thought === true) {
        if (text.length > 0) {
          if (reasoningItemId === undefined) {
            yield* closeText();
            reasoningItemId = `agr_${sequence++}`;
          }
          yield { type: "response.reasoning_summary_text.delta", item_id: reasoningItemId, output_index: outputIndex, delta: text };
        }
        // A thought part's own signature closes the run it belongs to.
        if (signature !== undefined) yield* closeReasoning(signature);
        continue;
      }

      if (text.length > 0) {
        yield* closeReasoning(undefined);
        if (textItemId === undefined) {
          textItemId = `agm_${sequence++}`;
          yield {
            type: "response.content_part.added",
            item_id: textItemId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: "output_text", text: "" },
          };
        }
        yield { type: "response.output_text.delta", item_id: textItemId, output_index: outputIndex, content_index: 0, delta: text };
      }
      // Gemini closes a text turn with an empty part carrying the turn's blob;
      // it belongs to the assistant message, which the client replays for us.
      if (signature !== undefined) yield* closeReasoning(signature);
    }
  }

  yield* closeText();
  yield* closeReasoning(undefined);

  if (failed) {
    yield { type: "response.failed", response: { ...snapshot(), error: failed } };
    return;
  }
  if (!started) {
    throw new UpstreamProtocolError("Antigravity stream produced no response frames");
  }
  const incomplete = antigravityIncomplete(finishReason, promptBlockReason);
  yield {
    type: "response.completed",
    response: {
      ...snapshot(),
      ...(incomplete === undefined ? {} : { incomplete }),
    },
  };
}
