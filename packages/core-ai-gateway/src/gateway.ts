import { collectAnthropicMessage, encodeAnthropicSse, translateAnthropicRequest } from "./anthropic.js";
import type {
  AnthropicMessagesRequest,
  TranslateAnthropicRequestOptions
} from "./anthropic.js";
import { canonicalMessageText } from "./canonical.js";
import type {
  AiGatewayAdapter,
  CanonicalFunctionTool,
  CanonicalResponseRequest,
} from "./canonical.js";
import { OpenAIResponsesAdapter } from "./openai-responses-adapter.js";
import { logCanonicalEvents, wireLog, wireLogEnabled } from "./wire-log.js";

const DEFAULT_CHARS_PER_TOKEN = 4;
const CODE_MODEL_CHARS_PER_TOKEN = 3.5;
const CJK_CHARS_PER_TOKEN = 2.5;
const CJK_RATIO_THRESHOLD = 0.3;
const CODE_MODEL_PREFIXES = ["kiro", "claude", "deepseek", "minimax", "glm", "qwen"];
const CJK_RE = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF]/;

export function estimateTokens(text: string, modelId?: string): number {
  if (text.length === 0) return 0;
  let charsPerToken = modelCharsPerToken(modelId);
  if (cjkRatio(text) > CJK_RATIO_THRESHOLD) {
    charsPerToken = Math.min(charsPerToken, CJK_CHARS_PER_TOKEN);
  }
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

function modelCharsPerToken(modelId: string | undefined): number {
  const normalized = modelId?.toLowerCase();
  return normalized && CODE_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ? CODE_MODEL_CHARS_PER_TOKEN
    : DEFAULT_CHARS_PER_TOKEN;
}

function cjkRatio(text: string): number {
  const stride = text.length > 2_048 ? Math.ceil(text.length / 2_048) : 1;
  let cjk = 0;
  let sampled = 0;
  for (let index = 0; index < text.length; index += stride) {
    sampled += 1;
    if (CJK_RE.test(text[index] ?? "")) cjk += 1;
  }
  return sampled === 0 ? 0 : cjk / sampled;
}

/** Claude Code recognizes this prefix and routes the failed turn through reactive compaction. */
export class ContextWindowExceededError extends Error {
  constructor(
    readonly requestTokens: number,
    readonly contextWindow: number,
  ) {
    super(`Prompt is too long: ${requestTokens} tokens > ${contextWindow} maximum`);
    this.name = "ContextWindowExceededError";
  }
}

export interface AnthropicGatewayCallOptions extends TranslateAnthropicRequestOptions {
  apiKey: string;
  /**
   * Projection denominator for Claude Code's own context meter. Set ONLY when the
   * caller selected Claude Code's `[1m]` coordinate; it rescales reported usage
   * onto the 1M axis and is never a limit.
   */
  contextWindow?: number;
  /**
   * The model's real usable context window. Always set by the caller, regardless of
   * whether the `[1m]` coordinate applies, and used only by the pre-flight overflow
   * guard — never as a projection denominator.
   */
  modelContextWindow?: number;
  /** 새로 여는 provider trace가 진단 이벤트를 낼지 결정한다. 생략하면 adapter 기본값을 유지한다. */
  diagnosticsEnabled?: boolean;
  signal?: AbortSignal;
}

export interface AnthropicGatewayResponse {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array>;
}

export class AnthropicMessagesGateway {
  constructor(private readonly adapter: AiGatewayAdapter = new OpenAIResponsesAdapter()) {}

  async stream(
    request: AnthropicMessagesRequest,
    options: AnthropicGatewayCallOptions
  ): Promise<AnthropicGatewayResponse> {
    // Inbound Anthropic tool catalog, verbatim. This is the only place the client's own
    // `input_schema` (its `required` array and any `strict` flag) is visible before any
    // translation touches it.
    wireLog("anthropic.request", {
      model: request.model,
      resolvedModel: options.model,
      stream: request.stream,
      tool_choice: request.tool_choice,
      tools: request.tools,
    });
    const canonical = translateAnthropicRequest(request, {
      ...(options.model ? { model: options.model } : {}),
      ...(options.catalog ? { catalog: options.catalog } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      ...(options.reasoningEfforts ? { reasoningEfforts: options.reasoningEfforts } : {}),
      ...(this.adapter.capabilities?.nativeTools
        ? { nativeTools: this.adapter.capabilities.nativeTools }
        : {}),
    });
    wireLog("canonical.request", {
      model: canonical.model,
      tool_choice: canonical.tool_choice,
      parallel_tool_calls: canonical.parallel_tool_calls,
      reasoning: canonical.reasoning,
      tools: canonical.tools,
    });
    guardModelContextWindow(canonical, options.modelContextWindow, this.adapter);
    const upstream = await this.adapter.stream(canonical, {
      apiKey: options.apiKey,
      ...(options.diagnosticsEnabled === undefined
        ? {}
        : { diagnosticsEnabled: options.diagnosticsEnabled }),
      signal: options.signal
    });

    if (!upstream.ok) {
      wireLog("upstream.error", {
        status: upstream.status,
        body: new TextDecoder().decode(upstream.body),
      });
      const translated = translateUpstreamError(upstream.body);
      const headers = new Headers(upstream.headers);
      if (translated.changed) {
        headers.set("content-type", "application/json");
        headers.set("content-length", String(translated.body.byteLength));
      }
      return {
        status: upstream.status,
        headers,
        body: oneChunk(translated.body)
      };
    }

    // One wrapper at the canonical boundary covers every adapter, and carries the argument
    // JSON the model actually produced for each tool call.
    const events = wireLogEnabled()
      ? logCanonicalEvents(upstream.events, "canonical.event")
      : upstream.events;

    if (request.stream === true) {
      return {
        status: upstream.status,
        headers: new Headers({
          "cache-control": "no-cache",
          "content-type": "text/event-stream; charset=utf-8"
        }),
        body: encodeAnthropicSse(events, {
          contextWindow: options.contextWindow,
          model: request.model,
        })
      };
    }

    // Claude Code는 일부 요청을 비스트리밍으로 보낸다. 그때는 이벤트를 모아 단일 Messages 응답을 준다.
    const message = await collectAnthropicMessage(events, request.model, {
      contextWindow: options.contextWindow,
      model: request.model,
    });
    return {
      status: upstream.status,
      headers: new Headers({ "content-type": "application/json" }),
      body: oneChunk(new TextEncoder().encode(JSON.stringify(message)))
    };
  }
}

async function* oneChunk(body: Uint8Array): AsyncGenerator<Uint8Array> {
  yield body;
}

/**
 * Pre-flight overflow guard.
 *
 * Upstream providers report an overflow in provider-specific wire shapes we do not
 * translate, so a turn that exceeds the model window can die without any text Claude
 * Code can classify. Refusing the turn locally with the literal `Prompt is too long:`
 * prefix keeps reactive compaction reachable.
 *
 * The estimate is a conservative character-based heuristic (see `estimateTokens`), not
 * a tokenizer. It is a last-resort backstop behind correct window accounting, never the
 * primary defence, so it only fires when the estimate is strictly over the window.
 *
 * Only the tools the adapter actually serializes upstream are counted. Cursor drops
 * deferred tools and caps the rest, so counting the declared catalog would refuse turns
 * whose real request is far under the window — and, because the catalog is re-declared
 * every turn while reactive compaction only shrinks the conversation, a catalog large
 * enough to overflow on its own would lock the model out permanently instead of
 * degrading.
 */
function guardModelContextWindow(
  canonical: CanonicalResponseRequest,
  modelContextWindow: number | undefined,
  adapter: AiGatewayAdapter,
): void {
  if (
    typeof modelContextWindow !== "number"
    || !Number.isFinite(modelContextWindow)
    || modelContextWindow <= 0
  ) {
    return;
  }
  const wireTools = adapter.wireTools?.(canonical) ?? canonical.tools ?? [];
  const requestTokens = estimateCanonicalRequestTokens(canonical, wireTools);
  if (requestTokens > modelContextWindow) {
    throw new ContextWindowExceededError(requestTokens, modelContextWindow);
  }
}

/** Deterministic character-based input estimate over instructions, input items, and tools. */
function estimateCanonicalRequestTokens(
  canonical: CanonicalResponseRequest,
  wireTools: readonly CanonicalFunctionTool[],
): number {
  const parts: string[] = [];
  if (canonical.instructions !== undefined) parts.push(canonical.instructions);
  for (const item of canonical.input) {
    if (item.type === "message") {
      parts.push(canonicalMessageText(item.content));
    } else if (item.type === "function_call") {
      parts.push(item.name, item.arguments);
    } else {
      parts.push(item.output);
    }
  }
  for (const tool of wireTools) {
    parts.push(tool.name);
    if (tool.description !== undefined) parts.push(tool.description);
    parts.push(JSON.stringify(tool.parameters));
  }
  return estimateTokens(parts.join("\n"), canonical.model);
}

function translateUpstreamError(body: Uint8Array): {
  body: Uint8Array;
  changed: boolean;
} {
  const text = new TextDecoder().decode(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body, changed: false };
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) {
    return { body, changed: false };
  }
  if (parsed.type === "error") {
    return { body, changed: false };
  }
  if (typeof parsed.error.message !== "string") {
    return { body, changed: false };
  }

  const error = {
    ...parsed.error,
    type:
      typeof parsed.error.type === "string"
        ? parsed.error.type
        : typeof parsed.error.code === "string"
          ? parsed.error.code
          : "api_error",
    message: parsed.error.message
  };
  return {
    body: new TextEncoder().encode(JSON.stringify({ type: "error", error })),
    changed: true
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
