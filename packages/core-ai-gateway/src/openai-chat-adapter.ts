import type {
  AdapterCallOptions,
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalError,
  CanonicalInputMessage,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CanonicalUsage,
} from "./canonical.js";
import { canonicalMessageText } from "./canonical.js";
import {
  UpstreamProtocolError,
  UpstreamBodyLimitError,
  linkAbortSignal,
  nextEventBoundary,
  parseSseFrameFields,
  positiveInteger,
  readBoundedBody,
  readWithIdleTimeout,
  type FetchLike,
  type UpstreamReadOptions,
} from "./upstream-sse.js";
import { wireLog } from "./wire-log.js";

export const DEFAULT_CHAT_MAX_UPSTREAM_BODY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CHAT_UPSTREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * OpenAI Chat Completions wire shapes. Deliberately their own types: the wire
 * nests function data under `function` keys and threads tool replies through
 * `tool` role messages, so reusing the canonical request type would blur two
 * different contracts.
 */
interface ChatWireTextPart {
  type: "text";
  text: string;
}

interface ChatWireImagePart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

type ChatWireContentPart = ChatWireTextPart | ChatWireImagePart;

interface ChatWireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChatWireMessage =
  | { role: "system" | "assistant" | "user"; content: string | ChatWireContentPart[] }
  | { role: "assistant"; content: null; tool_calls: ChatWireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatWireRequest {
  model: string;
  messages: ChatWireMessage[];
  tools?: { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  stream: true;
  stream_options: { include_usage: true };
}

export interface OpenAIChatCompletionsAdapterOptions {
  /** Chat Completions endpoint, e.g. `https://opencode.ai/zen/go/v1/chat/completions`. */
  url: string;
  fetch?: FetchLike;
  maxBodyBytes?: number;
  idleTimeoutMs?: number;
  /** 구독 백엔드가 요구하는 추가 헤더. Bearer 인증은 options.apiKey가 담당한다. */
  headers?: Readonly<Record<string, string>>;
}

/**
 * Canonical → OpenAI Chat Completions adapter.
 *
 * Two deliberate contractions against the Responses adapter:
 * - No strict-mode schema rewrite. Chat Completions backends differ on strict
 *   support, so tools ship with their original schemas and the optional-argument
 *   pollution caveat documented for Cursor applies here too.
 * - `reasoning` never reaches the wire. Chat Completions has no portable
 *   reasoning parameter, and `reasoning_content` deltas some backends stream are
 *   hidden thinking — they are dropped, surfacing only in reported usage.
 */
export class OpenAIChatCompletionsAdapter implements AiGatewayAdapter {
  private readonly fetchImpl: FetchLike;
  private readonly maxBodyBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly url: string;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  constructor(options: OpenAIChatCompletionsAdapterOptions) {
    this.url = options.url;
    this.extraHeaders = options.headers ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxBodyBytes = positiveInteger(
      options.maxBodyBytes ?? DEFAULT_CHAT_MAX_UPSTREAM_BODY_BYTES,
      "maxBodyBytes"
    );
    this.idleTimeoutMs = positiveInteger(
      options.idleTimeoutMs ?? DEFAULT_CHAT_UPSTREAM_IDLE_TIMEOUT_MS,
      "idleTimeoutMs"
    );
  }

  async stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions
  ): Promise<AdapterResponse> {
    if (options.apiKey.length === 0) {
      throw new TypeError("apiKey must not be empty");
    }

    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(options.signal, controller);
    const payload = forChatCompletionsBackend(request);
    wireLog("openai-chat.wire.request", { url: this.url, payload });
    let response: Response;

    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          ...this.extraHeaders,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      unlinkAbort();
      throw error;
    }

    const readOptions: UpstreamReadOptions = {
      controller,
      idleTimeoutMs: this.idleTimeoutMs,
      maxBodyBytes: this.maxBodyBytes,
    };

    if (!response.ok) {
      try {
        const body = await readBoundedBody(response.body, readOptions);
        return { ok: false, status: response.status, headers: response.headers, body };
      } finally {
        unlinkAbort();
      }
    }

    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      events: translateChatCompletionsStream(response.body, {
        ...readOptions,
        onClose: unlinkAbort,
      }),
    };
  }
}

function forChatCompletionsBackend(request: CanonicalResponseRequest): ChatWireRequest {
  const messages: ChatWireMessage[] = [];
  if (request.instructions !== undefined && request.instructions.length > 0) {
    messages.push({ role: "system", content: request.instructions });
  }

  // Chat Completions는 tool 응답이 tool_calls를 실은 assistant 메시지 바로 뒤에 오기를
  // 요구한다. 연속한 canonical function_call들을 하나의 assistant 메시지로 합치고,
  // 플러시는 결과 직전(또는 user/developer 턴 경계)까지 미룬다 — Anthropic 원문은
  // 한 assistant 메시지 안에서 tool_use 뒤에 텍스트가 올 수 있고, canonical 번역이
  // 그 블록 순서를 보존하므로, 같은 턴의 후행 텍스트는 호출 블록보다 앞에 배치해
  // 호출과 결과의 인접성을 지킨다.
  let pendingToolCalls: ChatWireToolCall[] = [];
  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls });
    pendingToolCalls = [];
  };

  for (const item of request.input) {
    if (item.type === "function_call") {
      pendingToolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
      continue;
    }
    if (item.type === "function_call_output") {
      flushToolCalls();
      messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
      continue;
    }
    if (item.role !== "assistant") flushToolCalls();
    messages.push(chatWireMessage(item));
  }
  flushToolCalls();

  const payload: ChatWireRequest = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  const tools = (request.tools ?? []).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.parameters,
    },
  }));
  if (tools.length > 0) {
    payload.tools = tools;
  }

  const toolChoice = request.tool_choice;
  if (toolChoice !== undefined) {
    payload.tool_choice = typeof toolChoice === "string"
      ? toolChoice
      : { type: "function", function: { name: toolChoice.name } };
  }
  if (request.parallel_tool_calls !== undefined && tools.length > 0) {
    payload.parallel_tool_calls = request.parallel_tool_calls;
  }
  if (request.max_output_tokens !== undefined) {
    payload.max_tokens = request.max_output_tokens;
  }
  return payload;
}

function chatWireMessage(item: CanonicalInputMessage): ChatWireMessage {
  // canonical developer = system 성격 메시지 (Codex 백엔드 전용 표기). Chat 와이어의
  // 보편 표기는 system이다.
  const role = item.role === "developer" ? "system" : item.role;
  if (typeof item.content === "string") {
    return { role, content: item.content };
  }
  // 이미지 파트는 user 멀티모달 메시지에서만 의미가 있다. 그 밖의 role은 텍스트로 접는다.
  if (role !== "user") {
    return { role, content: canonicalMessageText(item.content) };
  }
  const parts: ChatWireContentPart[] = item.content.map((part) => {
    if (part.type === "input_text") {
      return { type: "text", text: part.text };
    }
    return {
      type: "image_url",
      image_url: {
        url: part.image_url,
        // Chat 와이어의 detail 집합에는 original이 없다. 축소 없이 보내는 데 가장
        // 가까운 값은 high다.
        ...(part.detail === undefined ? {} : { detail: part.detail === "original" ? "high" : part.detail }),
      },
    };
  });
  return { role, content: parts };
}

interface PendingChatToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

/**
 * Chat Completions 청크 스트림을 canonical 이벤트로 번역한다.
 *
 * tool call 인자는 조각으로 흘러오지만 delta로 중계하지 않고 완결 시점에
 * `response.output_item.done` 하나로 내보낸다 — Responses 어댑터가 인자 delta를
 * 버리는 것과 같은 계약을 유지해, 하류가 두 어댑터에서 같은 모양을 본다.
 */
async function* translateChatCompletionsStream(
  body: ReadableStream<Uint8Array> | null,
  options: UpstreamReadOptions & { onClose: () => void }
): AsyncGenerator<CanonicalResponseEvent> {
  if (body === null) {
    options.onClose();
    throw new UpstreamProtocolError("Chat Completions streaming response had no body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let byteLength = 0;

  let responseId: string | undefined;
  let responseModel: string | undefined;
  let createdEmitted = false;
  let textSeen = false;
  let accumulatedText = "";
  let usage: CanonicalUsage | null = null;
  let failed = false;
  const toolCalls = new Map<number, PendingChatToolCall>();

  const MESSAGE_ITEM_ID = "chat_message_0";

  function* consumeChunk(value: unknown): Generator<CanonicalResponseEvent> {
    if (!isRecord(value)) {
      throw new UpstreamProtocolError("Chat Completions SSE event was not an object");
    }
    if (isRecord(value.error)) {
      failed = true;
      yield { type: "error", error: chatCanonicalError(value.error) };
      return;
    }
    if (typeof value.id === "string" && responseId === undefined) {
      responseId = value.id;
    }
    if (typeof value.model === "string" && responseModel === undefined) {
      responseModel = value.model;
    }
    if (!createdEmitted) {
      createdEmitted = true;
      yield {
        type: "response.created",
        response: {
          id: responseId ?? "chat_response",
          model: responseModel ?? "",
          usage: null,
        },
      };
    }
    if (isRecord(value.usage)) {
      usage = chatUsage(value.usage);
    }

    const choices = Array.isArray(value.choices) ? value.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        textSeen = true;
        accumulatedText += delta.content;
        yield {
          type: "response.output_text.delta",
          item_id: MESSAGE_ITEM_ID,
          output_index: 0,
          content_index: 0,
          delta: delta.content,
        };
      }
      const wireToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of wireToolCalls) {
        if (!isRecord(call)) continue;
        const index = typeof call.index === "number" ? call.index : 0;
        const pending = toolCalls.get(index) ?? { arguments: "" };
        if (typeof call.id === "string" && call.id.length > 0) {
          pending.id ??= call.id;
        }
        const fn = isRecord(call.function) ? call.function : {};
        if (typeof fn.name === "string" && fn.name.length > 0) {
          pending.name ??= fn.name;
        }
        if (typeof fn.arguments === "string") {
          pending.arguments += fn.arguments;
        }
        toolCalls.set(index, pending);
      }
    }
  }

  function* finish(): Generator<CanonicalResponseEvent> {
    if (failed) return;
    if (!createdEmitted) {
      createdEmitted = true;
      yield {
        type: "response.created",
        response: { id: responseId ?? "chat_response", model: responseModel ?? "", usage: null },
      };
    }
    if (textSeen) {
      yield {
        type: "response.output_text.done",
        item_id: MESSAGE_ITEM_ID,
        output_index: 0,
        content_index: 0,
        text: accumulatedText,
      };
    }
    let outputIndex = 1;
    for (const [index, pending] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
      if (pending.name === undefined) {
        throw new UpstreamProtocolError(`Chat Completions tool call ${index} ended without a name`);
      }
      const id = pending.id ?? `chat_call_${index}`;
      // 하류(anthropic 변환)는 done만으로 tool_use 블록을 합성·완결한다.
      yield {
        type: "response.output_item.done",
        output_index: outputIndex++,
        item: {
          id,
          type: "function_call",
          call_id: id,
          name: pending.name,
          arguments: pending.arguments,
        },
      };
    }
    yield {
      type: "response.completed",
      response: {
        id: responseId ?? "chat_response",
        model: responseModel ?? "",
        // 하류 message_delta는 usage가 필수다. include_usage에도 usage 청크를 주지
        // 않는 백엔드에서는 0-usage로 완결하고, 실제 회계는 provider 콘솔이 맡는다.
        usage: usage ?? { input_tokens: 0, output_tokens: 0 },
      },
    };
  }

  try {
    while (true) {
      const result = await readWithIdleTimeout(reader, options);
      if (result.done) {
        buffer += decoder.decode();
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > options.maxBodyBytes) {
        const error = new UpstreamBodyLimitError(options.maxBodyBytes);
        options.controller.abort(error);
        throw error;
      }
      buffer += decoder.decode(result.value, { stream: true });

      let boundary = nextEventBoundary(buffer);
      while (boundary !== undefined) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = chatFrameData(frame);
        if (data !== undefined) {
          yield* consumeChunk(data);
        }
        boundary = nextEventBoundary(buffer);
      }
    }

    if (buffer.trim().length > 0) {
      const data = chatFrameData(buffer);
      if (data !== undefined) {
        yield* consumeChunk(data);
      }
    }
    yield* finish();
  } finally {
    await reader.cancel().catch(() => undefined);
    options.onClose();
  }
}

function chatFrameData(frame: string): unknown | undefined {
  const { data } = parseSseFrameFields(frame);
  if (data.length === 0 || data === "[DONE]") {
    return undefined;
  }
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new UpstreamProtocolError(
      `Chat Completions SSE contained invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function chatUsage(value: Record<string, unknown>): CanonicalUsage {
  const inputTokens = nonNegativeOrZero(value.prompt_tokens);
  const outputTokens = nonNegativeOrZero(value.completion_tokens);
  const promptDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined;
  const completionDetails = isRecord(value.completion_tokens_details) ? value.completion_tokens_details : undefined;
  const cachedInputTokens = promptDetails === undefined ? undefined : optionalNonNegative(promptDetails.cached_tokens);
  const reasoningOutputTokens = completionDetails === undefined
    ? undefined
    : optionalNonNegative(completionDetails.reasoning_tokens);
  const totalTokens = optionalNonNegative(value.total_tokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cached_input_tokens: cachedInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoning_output_tokens: reasoningOutputTokens }),
    ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
  };
}

function chatCanonicalError(error: Record<string, unknown>): CanonicalError {
  const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
  const type = typeof error.type === "string" && error.type !== "error"
    ? error.type
    : typeof error.code === "string"
      ? error.code
      : "api_error";
  return { type, message };
}

function nonNegativeOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
