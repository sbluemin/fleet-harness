export interface CanonicalInputTextPart {
  type: "input_text";
  text: string;
}

export interface CanonicalInputImagePart {
  type: "input_image";
  /** Fully qualified URL or `data:<media_type>;base64,...` data URL. */
  image_url: string;
  detail?: "auto" | "low" | "high" | "original";
}

export type CanonicalInputContentPart =
  | CanonicalInputTextPart
  | CanonicalInputImagePart;

export interface CanonicalInputMessage {
  type: "message";
  // ChatGPT Codex 백엔드는 role:"system"을 400으로 거절한다. system 성격 메시지는 developer로 싣는다.
  role: "user" | "assistant" | "developer";
  /** Plain text, or Responses-style multimodal parts when images are present. */
  content: string | CanonicalInputContentPart[];
  /** Provider 추론 재생 메타데이터. 어댑터가 모델별로 선택하며 visible content로 노출하지 않는다. */
  reasoning_content?: string;
  /**
   * The provider's own opaque reasoning blob for the turn this item closed, to be replayed
   * verbatim on the next request. Unlike `reasoning_content` it is never renderable text —
   * only the provider can decrypt it — so an adapter either round-trips it or drops it.
   */
  reasoning_encrypted?: string;
  /** The provider's id for the reasoning item `reasoning_encrypted` came from. */
  reasoning_id?: string;
}

/** Flatten message text for adapters that only accept a string prompt body. */
export function canonicalMessageText(
  content: CanonicalInputMessage["content"],
): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part): part is CanonicalInputTextPart => part.type === "input_text")
    .map((part) => part.text)
    .join("");
}

export function canonicalMessageImages(
  content: CanonicalInputMessage["content"],
): CanonicalInputImagePart[] {
  if (typeof content === "string") {
    return [];
  }
  return content.filter(
    (part): part is CanonicalInputImagePart => part.type === "input_image",
  );
}

/** Collapse parts back to a string when there are no images. */
export function normalizeCanonicalMessageContent(
  parts: CanonicalInputContentPart[],
): CanonicalInputMessage["content"] {
  const images = parts.filter(
    (part): part is CanonicalInputImagePart => part.type === "input_image",
  );
  if (images.length === 0) {
    return parts
      .filter((part): part is CanonicalInputTextPart => part.type === "input_text")
      .map((part) => part.text)
      .join("");
  }
  return parts;
}

export interface CanonicalFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  /** 이 assistant tool call 앞의 provider 추론. 요구하는 모델의 history에만 재생한다. */
  reasoning_content?: string;
  /** @see CanonicalInputMessage.reasoning_encrypted */
  reasoning_encrypted?: string;
  /** @see CanonicalInputMessage.reasoning_id */
  reasoning_id?: string;
}

export interface CanonicalFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
  /** Client tool failures remain successful bridge replies with an error-marked result payload. */
  is_error?: boolean;
  /** Tool names selected by a client-side discovery tool for use on the following turn. */
  tool_references?: string[];
}

export type CanonicalInputItem =
  | CanonicalInputMessage
  | CanonicalFunctionCall
  | CanonicalFunctionCallOutput;

export interface CanonicalFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  /** The client may omit this definition until a discovery result references it. */
  defer_loading?: boolean;
}

const CANONICAL_NATIVE_TOOL_NAMES = ["web_search"] as const;

export type CanonicalNativeToolName = typeof CANONICAL_NATIVE_TOOL_NAMES[number];

/** Provider-owned web search. It must never be serialized as a client function tool. */
export interface CanonicalNativeWebSearchTool {
  type: "web_search";
  allowed_domains?: string[];
  blocked_domains?: string[];
  max_uses?: number;
  /** The inbound tool choice selected this provider-owned tool explicitly. */
  required?: boolean;
}

export type CanonicalNativeTool = CanonicalNativeWebSearchTool;

export type CanonicalToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; name: string };

export const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export class UnsupportedReasoningEffortError extends RangeError {
  constructor(
    readonly requestedEffort: ReasoningEffort,
    readonly supportedEfforts: readonly ReasoningEffort[],
    readonly modelId?: string,
  ) {
    const subject = modelId ? `Model "${modelId}"` : "Selected model";
    super(`${subject} has no supported reasoning effort at or below "${requestedEffort}"`);
    this.name = "UnsupportedReasoningEffortError";
  }
}

const REASONING_EFFORT_RANK = new Map(
  REASONING_EFFORTS.map((effort, index) => [effort, index] as const),
);

/** Clamp to the highest supported rung not above the request; never silently increase effort. */
export function clampReasoningEffort(
  effort: ReasoningEffort,
  supportedEfforts: readonly ReasoningEffort[] | undefined,
  modelId?: string,
): ReasoningEffort {
  if (!supportedEfforts || supportedEfforts.length === 0 || supportedEfforts.includes(effort)) {
    return effort;
  }

  const requestedRank = REASONING_EFFORT_RANK.get(effort) ?? 0;
  const ranked = supportedEfforts
    .map((supported) => ({ supported, rank: REASONING_EFFORT_RANK.get(supported) }))
    .filter((entry): entry is { supported: ReasoningEffort; rank: number } => entry.rank !== undefined)
    .sort((left, right) => left.rank - right.rank);
  const lower = ranked.filter((entry) => entry.rank <= requestedRank).at(-1);
  if (lower) return lower.supported;
  throw new UnsupportedReasoningEffortError(effort, supportedEfforts, modelId);
}

export interface CanonicalReasoning {
  summary: "auto";
  effort?: ReasoningEffort;
}

export interface CanonicalResponseRequest {
  model: string;
  input: CanonicalInputItem[];
  instructions?: string;
  tools?: CanonicalFunctionTool[];
  /** Provider-owned tools handled outside the client function/MCP bridge. */
  native_tools?: CanonicalNativeTool[];
  tool_choice?: CanonicalToolChoice;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  metadata?: Record<string, string>;
  reasoning?: CanonicalReasoning;
  service_tier?: "priority";
  stream: true;
}

export interface CanonicalUsage {
  input_tokens: number;
  output_tokens: number;
  /** Provider-reported total context limit for this concrete model turn, when available. */
  context_window?: number;
  /** Subset of input_tokens served from an upstream prompt-cache hit. */
  cached_input_tokens?: number;
  /** Subset of input_tokens spent writing a new upstream prompt-cache entry. */
  cache_write_input_tokens?: number;
  /** Subset of output_tokens spent on hidden reasoning traces. */
  reasoning_output_tokens?: number;
  /** Provider-reported input_tokens + output_tokens total, when available. */
  total_tokens?: number;
}

export interface CanonicalResponseSnapshot {
  id: string;
  model: string;
  usage: CanonicalUsage | null;
}

export interface CanonicalMessageOutputItem {
  id: string;
  type: "message";
  role: "assistant";
}

export interface CanonicalFunctionCallOutputItem {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

/** A source cited by a completed provider web search. Never fabricated: only what the provider reported. */
export interface CanonicalWebSearchSource {
  type: string;
  url: string;
  /** The provider's real page title, when it reported one. */
  title?: string;
}

/** Provider-owned web search action. Shape varies by action type (search/open_page/find_in_page/...). */
export interface CanonicalWebSearchAction {
  type: string;
  query?: string;
  queries?: string[];
  url?: string;
  pattern?: string;
  sources?: CanonicalWebSearchSource[];
}

/** A completed provider-executed web search, translated from the wire's `web_search_call` output item. */
export interface CanonicalWebSearchCallOutputItem {
  id: string;
  type: "web_search_call";
  status?: string;
  action?: CanonicalWebSearchAction;
}

/**
 * A closed reasoning trace, carrying the provider's opaque blob when it sent one.
 *
 * The blob is what lets a stateless caller hand the model back its own prior thinking instead
 * of paying for it twice: measured against xAI's Responses wire on 2026-08-20, replaying it
 * across a tool round-trip halved the reasoning tokens of the following turn (32 vs 66) and cut
 * output tokens by ~40%. It reaches the client encoded in the thinking block's signature and
 * returns on the next request as `reasoning_encrypted`.
 */
export interface CanonicalReasoningOutputItem {
  id: string;
  type: "reasoning";
  encrypted_content?: string;
}

export interface CanonicalCompactionOutputItem {
  id?: string;
  type: "compaction";
  encrypted_content: string;
}

export type CanonicalOutputItem =
  | CanonicalMessageOutputItem
  | CanonicalFunctionCallOutputItem
  | CanonicalWebSearchCallOutputItem
  | CanonicalReasoningOutputItem
  | CanonicalCompactionOutputItem;

export type CanonicalResponseEvent =
  | {
      type: "response.created";
      response: CanonicalResponseSnapshot;
    }
  | {
      type: "response.content_part.added";
      item_id: string;
      output_index: number;
      content_index: number;
      part: { type: "output_text"; text: string };
    }
  | {
      type: "response.output_text.delta";
      item_id: string;
      output_index: number;
      content_index: number;
      delta: string;
    }
  | {
      type: "response.output_text.done";
      item_id: string;
      output_index: number;
      content_index: number;
      text: string;
    }
  | {
      type: "response.reasoning_summary_text.delta";
      item_id: string;
      output_index: number;
      delta: string;
    }
  | {
      type: "response.output_item.added";
      output_index: number;
      item: CanonicalOutputItem;
    }
  | {
      type: "response.function_call_arguments.delta";
      item_id: string;
      output_index: number;
      delta: string;
    }
  | {
      type: "response.function_call_arguments.done";
      item_id: string;
      output_index: number;
      arguments: string;
    }
  | {
      type: "response.output_item.done";
      output_index: number;
      item: CanonicalOutputItem;
    }
  | {
      type: "response.completed";
      response: CanonicalResponseSnapshot;
    }
  | {
      type: "response.failed";
      response: CanonicalResponseSnapshot & {
        error: CanonicalError;
      };
    }
  | {
      type: "error";
      error: CanonicalError;
    };

/**
 * Carrier for a provider reasoning blob across the Anthropic wire.
 *
 * A thinking block's `signature` is the only field on that wire whose value the client returns
 * untouched and never renders, which is exactly what an opaque blob needs. The prefix keeps the
 * gateway's own placeholder signatures (`gateway_...`) and any provider's real ones from being
 * mistaken for one of these, and the version segment leaves room to change the encoding without
 * a decoder guessing at which shape it holds. The id may be empty; the blob never is.
 */
const REASONING_SIGNATURE_PREFIX = "fleet-reasoning:v1:";

export function encodeReasoningSignature(id: string, encrypted: string): string {
  return `${REASONING_SIGNATURE_PREFIX}${id}:${encrypted}`;
}

export interface DecodedReasoningSignature {
  readonly id: string;
  readonly encrypted: string;
}

/** `undefined` for anything this gateway did not write — including a real provider signature. */
export function decodeReasoningSignature(signature: unknown): DecodedReasoningSignature | undefined {
  if (typeof signature !== "string" || !signature.startsWith(REASONING_SIGNATURE_PREFIX)) {
    return undefined;
  }
  const body = signature.slice(REASONING_SIGNATURE_PREFIX.length);
  const separator = body.indexOf(":");
  if (separator === -1) return undefined;
  const encrypted = body.slice(separator + 1);
  return encrypted.length > 0 ? { id: body.slice(0, separator), encrypted } : undefined;
}

export interface CanonicalError {
  type: string;
  message: string;
}

/**
 * Refusal Claude Code can recover from, rather than one that ends the turn.
 *
 * Claude Code classifies an overflow only from an HTTP **413** whose message contains
 * `context window`; that classification is what arms its reactive compaction. The
 * `Prompt is too long` prefix is a second, separate contract — the compaction routine
 * matches it to decide that its own summarization request overflowed and to retry with
 * older messages dropped. Both are required, so the message carries the prefix and the
 * phrase, and `writeAnthropicError` must send this as 413. Any other status is surfaced
 * as a plain failure and the turn dies with no compaction attempted.
 *
 * It lives in the canonical vocabulary rather than the gateway because an adapter that
 * holds a provider-measured occupancy has to raise the same refusal, and an adapter
 * importing the gateway would invert the layer.
 */
export class ContextWindowExceededError extends Error {
  constructor(
    readonly requestTokens: number,
    readonly contextWindow: number,
  ) {
    super(`Prompt is too long: ${requestTokens} tokens > ${contextWindow} maximum context window`);
    this.name = "ContextWindowExceededError";
  }
}

export interface AdapterCallOptions {
  apiKey: string;
  /**
   * The model's real usable context window. Adapters that hold a provider-measured
   * occupancy for the conversation use it to refuse a turn the estimate cannot see;
   * it is never a projection denominator and never a transport budget.
   */
  modelContextWindow?: number;
  /** 새로 여는 provider trace가 진단 이벤트를 낼지 결정한다. 생략하면 adapter 기본값을 유지한다. */
  diagnosticsEnabled?: boolean;
  signal?: AbortSignal;
}

export interface SuccessfulAdapterResponse {
  ok: true;
  status: number;
  headers: Headers;
  events: AsyncIterable<CanonicalResponseEvent>;
}

export interface FailedAdapterResponse {
  ok: false;
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export type AdapterResponse = SuccessfulAdapterResponse | FailedAdapterResponse;

export interface AiGatewayAdapterCapabilities {
  /** Provider-owned tools the adapter can execute without a client function round-trip. */
  readonly nativeTools?: readonly CanonicalNativeToolName[];
}

export interface AiGatewayAdapter {
  readonly capabilities?: AiGatewayAdapterCapabilities;
  /**
   * The declared tools this adapter actually serializes upstream for the request.
   * Adapters that drop or cap the declared catalog must implement it so pre-flight
   * sizing measures the real upstream payload instead of the canonical declaration.
   * Omitting it means every declared tool reaches the wire unchanged.
   */
  wireTools?(request: CanonicalResponseRequest): readonly CanonicalFunctionTool[];
  stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions
  ): Promise<AdapterResponse>;
}
