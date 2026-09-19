import { collectAnthropicMessage, encodeAnthropicSse, translateAnthropicRequest } from "./protocol.js";
import type {
  AnthropicMessagesRequest,
  TranslateAnthropicRequestOptions,
  UsageProjection,
} from "./protocol.js";
import { ContextWindowExceededError, canonicalMessageText } from "../../../canonical/index.js";
import type {
  AiGatewayAdapter,
  CanonicalFunctionTool,
  CanonicalResponseRequest,
} from "../../../canonical/index.js";
import { OpenAIResponsesAdapter } from "../../../upstream/codex/responses/adapter.js";
import { withSseKeepAlive } from "../../../transport/sse-keepalive.js";
import { estimateTokens } from "../../../transport/token-estimate.js";
import { logCanonicalEvents, wireLog, wireLogEnabled } from "../../../transport/wire-log.js";

export { ContextWindowExceededError } from "../../../canonical/index.js";

export interface AnthropicGatewayCallOptions extends TranslateAnthropicRequestOptions {
  apiKey: string;
  /**
   * Projection denominator for the client's own context meter — the coordinate the
   * harness told the client this model has. Never a limit.
   */
  contextWindow?: number;
  /** Harness-owned occupancy map, applied to every usage frame this turn emits. */
  projectInputTokens?: UsageProjection;
  /**
   * Lift an upstream refusal onto a status the client's retry budget acts on.
   *
   * Which statuses a client retries is that client's contract, so the map arrives from
   * the harness. Absent forwards the upstream status unchanged.
   */
  retryableStatus?: (status: number) => number;
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

  async streamCanonical(
    request: AnthropicMessagesRequest,
    canonical: CanonicalResponseRequest,
    options: AnthropicGatewayCallOptions,
  ): Promise<AnthropicGatewayResponse> {
    return this.streamTranslated(request, canonical, options);
  }

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
      // 하네스 id 문법으로 카탈로그를 찾는 방법도 함께 넘긴다. 옵션 타입이 상속만 하고
      // 전달하지 않으면, model override 없이 부르는 호출자는 자기 문법이 조용히 무시된 채
      // DEFAULT_CODEX_MODEL로 떨어진다 — 라우터는 override를 늘 보내서 가려질 뿐이다.
      ...(options.findModel ? { findModel: options.findModel } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      ...(options.reasoningEfforts ? { reasoningEfforts: options.reasoningEfforts } : {}),
      ...(this.adapter.capabilities?.nativeTools
        ? { nativeTools: this.adapter.capabilities.nativeTools }
        : {}),
    });
    return this.streamTranslated(request, canonical, options);
  }

  private async streamTranslated(
    request: AnthropicMessagesRequest,
    canonical: CanonicalResponseRequest,
    options: AnthropicGatewayCallOptions,
  ): Promise<AnthropicGatewayResponse> {
    wireLog("canonical.request", {
      model: canonical.model,
      tool_choice: canonical.tool_choice,
      parallel_tool_calls: canonical.parallel_tool_calls,
      reasoning: canonical.reasoning,
      tools: canonical.tools,
    });
    // One estimate serves both the overflow guard and the usage floor below: the guard refuses
    // a turn that cannot fit, and the floor keeps `message_start` from claiming zero input on
    // providers whose `response.created` carries no usage.
    const estimatedInputTokens = estimateCanonicalRequestTokens(
      canonical,
      this.adapter.wireTools?.(canonical) ?? canonical.tools ?? [],
    );
    guardModelContextWindow(canonical, options.modelContextWindow, estimatedInputTokens);
    const upstream = await this.adapter.stream(canonical, {
      apiKey: options.apiKey,
      ...(options.modelContextWindow === undefined
        ? {}
        : { modelContextWindow: options.modelContextWindow }),
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
        // The upstream body is forwarded with its wording intact so the client can still read
        // what happened; only the status is lifted onto a code the client's retry budget acts on.
        status: options.retryableStatus?.(upstream.status) ?? upstream.status,
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
        body: withSseKeepAlive(encodeAnthropicSse(events, {
          contextWindow: options.contextWindow,
          projectInputTokens: options.projectInputTokens,
          model: request.model,
          estimatedInputTokens,
        }))
      };
    }

    // Claude Code는 일부 요청을 비스트리밍으로 보낸다. 그때는 이벤트를 모아 단일 Messages 응답을 준다.
    const message = await collectAnthropicMessage(events, request.model, {
      contextWindow: options.contextWindow,
      projectInputTokens: options.projectInputTokens,
      model: request.model,
      estimatedInputTokens,
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
  requestTokens: number,
): void {
  if (
    typeof modelContextWindow !== "number"
    || !Number.isFinite(modelContextWindow)
    || modelContextWindow <= 0
  ) {
    return;
  }
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
