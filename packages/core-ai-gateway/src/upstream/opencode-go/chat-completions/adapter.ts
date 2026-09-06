import type {
  AdapterCallOptions,
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalError,
  CanonicalFunctionTool,
  CanonicalInputMessage,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CanonicalUsage,
} from "../../../canonical/index.js";
import { canonicalMessageText, clampReasoningEffort, type ReasoningEffort } from "../../../canonical/index.js";
import { OPENCODE_SUBSCRIPTION_MODELS, upstreamModelId } from "../../../models.js";
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
} from "../../../transport/upstream-sse.js";
import { logRawWireEvent, wireLog, type RawWireEventPayload } from "../../../transport/wire-log.js";

/** OpenCode Go 구독이 노출하는 Chat Completions 네임스페이스 엔드포인트. */
export const OPENCODE_GO_CHAT_COMPLETIONS_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const DEFAULT_CHAT_MAX_UPSTREAM_BODY_BYTES = 64 * 1024 * 1024;
/**
 * Longest the upstream may send no bytes at all before the read is abandoned.
 *
 * Calibrated against what the caller tolerates, not against how fast a short turn answers.
 * Claude Code's own byte-stream idle watchdog waits 300s, so anything tighter here converts a
 * turn the client was still willing to wait for into a failure the client never asked for.
 * Measured 2026-08-21 on a live session: 30s killed 20 turns whose upstream was simply thinking,
 * and the rate climbed through the session as the conversation grew and the gaps grew with it.
 */
const DEFAULT_CHAT_UPSTREAM_IDLE_TIMEOUT_MS = 300_000;

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
  | { role: "system" | "user"; content: string | ChatWireContentPart[] }
  | { role: "assistant"; content: string | ChatWireContentPart[]; reasoning_content?: string }
  | { role: "assistant"; content: string | null; tool_calls: ChatWireToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatWireRequest {
  model: string;
  messages: ChatWireMessage[];
  tools?: { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  /** OpenCode Go 백엔드가 받는 추론 강도. 카탈로그가 사다리를 선언한 모델에만 실린다. */
  reasoning_effort?: ReasoningEffort;
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
 * - Chat Completions 규격에는 이식 가능한 `reasoning` 요청 파라미터가 없다. 그래서 effort는
 *   기본적으로 wire에 싣지 않고, 백엔드가 자기 사다리를 실측으로 밝힌 provider instance의
 *   선언 모델에 한해 `reasoning_effort`로만 나간다(아래 reasoningEffortPolicy). Provider가
 *   보낸 `reasoning_content`는 canonical reasoning으로 보존하고, 이전 assistant 추론은 wire
 *   요구가 실측된 모델에만 재생한다.
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
    const supportsImageInput = imageInputPolicy.get(this)?.(request.model) ?? true;
    const omitTools = toolOmissionPolicy.has(this) && shouldOmitTools(request);
    const requestedEffort = request.reasoning?.effort;
    const reasoningEffort = requestedEffort === undefined
      ? undefined
      : reasoningEffortPolicy.get(this)?.(request.model, requestedEffort);
    const payload = forChatCompletionsBackend(request, supportsImageInput, omitTools, reasoningEffort);
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
      events: translateChatCompletionsStream(
        response.body,
        { ...readOptions, onClose: unlinkAbort },
        argumentPruningPolicy.has(this) ? declaredToolSchemas(request) : EMPTY_TOOL_SCHEMAS
      ),
    };
  }
}

const imageInputPolicy = new WeakMap<
  OpenAIChatCompletionsAdapter,
  (model: string) => boolean
>();

/**
 * Which instances prune undeclared tool-call argument keys on the way in.
 *
 * The measurement behind the pruning is OpenCode's alone, and a generic instance can be
 * constructed against any Chat Completions endpoint, so — like the image policy — this
 * binds to the provider instance instead of widening the public generic class.
 */
const argumentPruningPolicy = new WeakMap<OpenAIChatCompletionsAdapter, true>();

/**
 * OpenCode 인스턴스는 `shouldOmitTools`가 참일 때 wire에서 도구 catalog를 통째로 뺀다.
 * 이 omission은 provider 실측에 근거하므로 generic class에는 결합하지 않는다.
 */
const toolOmissionPolicy = new WeakMap<OpenAIChatCompletionsAdapter, true>();

/**
 * 어떤 instance가 canonical effort를 wire에 싣는지, 그리고 어떤 모델에 어떤 단으로 싣는지.
 *
 * Chat Completions 규격에는 reasoning 파라미터가 없으므로 generic instance는 계속 아무것도
 * 싣지 않는다. 실을 수 있다는 근거는 백엔드별 실측뿐이라 — image/pruning 정책과 같은 이유로 —
 * provider instance에만 결합한다. 반환이 undefined면 그 모델에는 싣지 않는다.
 */
const reasoningEffortPolicy = new WeakMap<
  OpenAIChatCompletionsAdapter,
  (model: string, effort: ReasoningEffort) => ReasoningEffort | undefined
>();
const CLAUDE_CODE_SUGGESTION_MODE_PREFIX =
  "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]";
const CLAUDE_CODE_SUGGESTION_MODE_SUFFIXES = [
  "Reply with ONLY the suggestion.",
  "Reply with ONLY the suggestion, no quotes or explanation.",
] as const;

export interface OpencodeGoChatCompletionsAdapterOptions {
  fetch?: FetchLike;
  maxBodyBytes?: number;
  idleTimeoutMs?: number;
  /** 구독 경로가 요구하는 추가 헤더. */
  headers?: Readonly<Record<string, string>>;
}

/**
 * OpenCode Go 소유 chat-completions 어댑터.
 *
 * 레거시 `OpenAIChatCompletionsAdapter`는 공개 호환용으로 유지하되, 이 provider 래퍼는
 * 항상 `OPENCODE_GO_CHAT_COMPLETIONS_URL`을 타깃하고 url 옵션을 노출하지 않는다 —
 * 임의 엔드포인트 오버라이드가 provider 어댑터를 다시 범용화하지 않도록 고정한다.
 */
export class OpencodeGoChatCompletionsAdapter extends OpenAIChatCompletionsAdapter {
  constructor(options: OpencodeGoChatCompletionsAdapterOptions = {}) {
    super({
      url: OPENCODE_GO_CHAT_COMPLETIONS_URL,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      // `!== undefined` 여야 명시적 0이 상속된 positiveInteger 검증을 통과한다.
      ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });
    // DeepSeek V4 텍스트 모델은 image_url을 거부하지만 Vision Exp는 이미지 입력을 받는다.
    // 기존 차단을 유지하되 공식 Go 카탈로그의 Vision 모델만 예외로 둔다.
    imageInputPolicy.set(this, (model) =>
      model === "deepseek-v4-flash-vision-exp" || !model.startsWith("deepseek-v4-"));
    // 미선언 인자 키 정화도 같은 이유로 provider instance 한정이다 — 이 wire가 strict를
    // 무시한다는 실측은 OpenCode의 것이고, 다른 백엔드에 대해서는 측정된 바가 없다.
    argumentPruningPolicy.set(this, true);
    // no-tools 조건은 Suggestion Mode에 더해 `tool_choice: "none"`까지 wire에서 catalog를
    // 뺀다 — generic class의 호환 동작은 바꾸지 않고 provider instance에만 결합한다.
    toolOmissionPolicy.set(this, true);
    // OpenCode Go의 Chat 백엔드는 `reasoning_effort`를 받고, 거부 메시지로 자기 사다리를
    // 직접 밝힌다(ox-alpha-free: low/high/max, 2026-08-21 실측). 사다리를 선언한 모델에만
    // 실어야 한다 — 선언 없는 모델에 보내면 그 백엔드가 받는다는 근거가 없다.
    reasoningEffortPolicy.set(this, opencodeGoChatReasoningEffort);
  }

  /**
   * preflight sizing은 wire에 실릴 catalog로 세야 한다. no-tools 조건에서는 실제 wire에
   * 도구가 없는데 전체 catalog를 청구하면 발생하지 않는 비용이 잡힌다.
   */
  wireTools(request: CanonicalResponseRequest): readonly CanonicalFunctionTool[] {
    return shouldOmitTools(request) ? [] : request.tools ?? [];
  }
}

/**
 * 카탈로그가 effort 사다리를 선언한 OpenCode Go chat-completions 모델의 wire effort.
 *
 * 사다리는 카탈로그 한 곳에서만 산다. 선언이 없으면 undefined를 돌려 이 wire의 기본 동작
 * (싣지 않음)을 유지하고, 있으면 그 사다리 안으로 하향 클램프한다 — 라우터가 이미 같은
 * 사다리로 클램프하지만, canonical을 직접 부르는 호출자에게도 같은 계약이 서야 한다.
 */
function opencodeGoChatReasoningEffort(
  model: string,
  effort: ReasoningEffort,
): ReasoningEffort | undefined {
  const entry = OPENCODE_SUBSCRIPTION_MODELS.find(
    (candidate) => upstreamModelId(candidate) === model,
  );
  if (entry?.effort.supported !== true) return undefined;
  return clampReasoningEffort(effort, entry.effort.levels, model);
}

/**
 * OpenCode Go 인스턴스가 wire에서 도구 catalog를 생략할 조건.
 *
 * `tool_choice: "none"`은 모델이 도구를 호출하지 말라는 명시이고, Suggestion Mode는
 * wire 자체가 도구 스키마를 거부한다. 두 경우 모두 도구 정의는 호출 결과에 관여하지 않고
 * wire payload만 키운다.
 */
function shouldOmitTools(request: CanonicalResponseRequest): boolean {
  return request.tool_choice === "none" || isClaudeCodeSuggestionMode(request);
}

function isClaudeCodeSuggestionMode(request: CanonicalResponseRequest): boolean {
  if (request.tool_choice === "required" || typeof request.tool_choice === "object") return false;
  const last = request.input.at(-1);
  if (last?.type !== "message" || last.role !== "user" || typeof last.content !== "string") {
    return false;
  }
  const content = last.content;
  return content.startsWith(CLAUDE_CODE_SUGGESTION_MODE_PREFIX)
    && CLAUDE_CODE_SUGGESTION_MODE_SUFFIXES.some((suffix) => content.endsWith(suffix));
}

function forChatCompletionsBackend(
  request: CanonicalResponseRequest,
  supportsImageInput: boolean,
  omitTools = false,
  reasoningEffort?: ReasoningEffort,
): ChatWireRequest {
  const messages: ChatWireMessage[] = [];
  if (request.instructions !== undefined && request.instructions.length > 0) {
    messages.push({ role: "system", content: request.instructions });
  }

  // Chat Completions는 tool 응답이 tool_calls를 실은 assistant 메시지 바로 뒤에 오기를
  // 요구하지만, Anthropic 원문은 호출과 결과 사이에 텍스트를 허용하고 canonical 번역이
  // 그 블록 순서를 보존한다. 인접성과 대화 순서를 함께 지키기 위해:
  // - 같은 턴의 assistant 텍스트는 Chat 와이어의 정식 표현인 content+tool_calls 단일
  //   assistant 메시지로 병합하고,
  // - 사이에 낀 user/developer 텍스트는 해당 호출의 결과 뒤로 미룬다(원문에서도 결과와
  //   함께 도착한 발화이므로 결과 직후가 의미상 제자리다).
  // DeepSeek V4 assistant/tool-turn reasoning 재생은 레거시 generic 어댑터의 HEAD
  // 공개 동작으로 유지한다. OpenCode 전용 정책은 instance-bound gate로만 적용한다.
  const replayReasoning = request.model.startsWith("deepseek-v4-");
  let pendingToolCalls: ChatWireToolCall[] = [];
  let pendingAssistantText: string | undefined;
  let pendingAssistantReasoning: string | undefined;
  let deferredMessages: ChatWireMessage[] = [];
  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    messages.push({
      role: "assistant",
      content: pendingAssistantText ?? null,
      tool_calls: pendingToolCalls,
      ...(replayReasoning && pendingAssistantReasoning
        ? { reasoning_content: pendingAssistantReasoning }
        : {}),
    });
    pendingToolCalls = [];
    pendingAssistantText = undefined;
    pendingAssistantReasoning = undefined;
  };
  const flushDeferredMessages = (): void => {
    if (deferredMessages.length === 0) return;
    messages.push(...deferredMessages);
    deferredMessages = [];
  };

  for (const item of request.input) {
    if (item.type === "function_call") {
      flushDeferredMessages();
      pendingToolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
      if (replayReasoning && item.reasoning_content) {
        pendingAssistantReasoning ??= item.reasoning_content;
      }
      continue;
    }
    if (item.type === "function_call_output") {
      flushToolCalls();
      messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
      continue;
    }
    if (pendingToolCalls.length > 0) {
      if (item.role === "assistant") {
        const text = canonicalMessageText(item.content);
        if (text.length > 0) {
          pendingAssistantText = pendingAssistantText === undefined ? text : `${pendingAssistantText}\n\n${text}`;
        }
      } else {
        deferredMessages.push(chatWireMessage(item, replayReasoning, supportsImageInput));
      }
      continue;
    }
    flushDeferredMessages();
    messages.push(chatWireMessage(item, replayReasoning, supportsImageInput));
  }
  flushToolCalls();
  flushDeferredMessages();

  const payload: ChatWireRequest = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  const tools = (omitTools ? [] : request.tools ?? []).map((tool) => ({
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

  const toolChoice = omitTools ? undefined : request.tool_choice;
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
  if (reasoningEffort !== undefined) {
    payload.reasoning_effort = reasoningEffort;
  }
  return payload;
}

function chatWireMessage(
  item: CanonicalInputMessage,
  replayReasoning: boolean,
  supportsImageInput: boolean,
): ChatWireMessage {
  // canonical developer = system 성격 메시지 (Codex 백엔드 전용 표기). Chat 와이어의
  // 보편 표기는 system이다.
  const role = item.role === "developer" ? "system" : item.role;
  if (role === "assistant") {
    return {
      role,
      content: canonicalMessageText(item.content),
      ...(replayReasoning && item.reasoning_content
        ? { reasoning_content: item.reasoning_content }
        : {}),
    };
  }
  if (typeof item.content === "string") {
    return { role, content: item.content };
  }
  // 이미지 파트는 user 멀티모달 메시지에서만 의미가 있다. system과 텍스트 전용
  // 모델은 텍스트로 접는다.
  if (role === "system" || !supportsImageInput) {
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

/** Tool name to the JSON Schema the client declared for it in this request. */
type DeclaredToolSchemas = ReadonlyMap<string, Record<string, unknown>>;

/** An instance outside the pruning policy resolves no schema, so every argument passes through. */
const EMPTY_TOOL_SCHEMAS: DeclaredToolSchemas = new Map();

function declaredToolSchemas(request: CanonicalResponseRequest): DeclaredToolSchemas {
  const schemas = new Map<string, Record<string, unknown>>();
  for (const tool of request.tools ?? []) schemas.set(tool.name, tool.parameters);
  return schemas;
}

/**
 * Removes argument keys the tool's own schema never declared.
 *
 * This wire cannot be made to honour a schema on the way out. OpenCode Zen accepts
 * `strict: true` on a function and still returns undeclared keys — measured against
 * deepseek-v4-flash on 2026-08-07, 5 of 5 runs, with `additionalProperties: false`
 * and every property required. Pruning on the way in is therefore the only place the
 * guarantee can be made, and unlike an outbound rewrite it cannot provoke a 400.
 *
 * Only a closed object — one that says `additionalProperties: false` — is pruned; an
 * open object declares extra keys legal and must survive untouched. Any schema shape this
 * walker cannot resolve leaves its subtree exactly as it arrived: `$ref`, a branching
 * keyword, absent `properties`, or a keyword that legalizes keys `properties` never names
 * (`patternProperties`, `dependentSchemas`, `if`, `unevaluatedProperties`). The asymmetry
 * is deliberate: a key wrongly dropped is silent data loss, while a key wrongly kept is
 * only the behaviour that already ships.
 */
function pruneUndeclaredArguments(
  raw: string,
  schema: Record<string, unknown> | undefined
): string {
  if (schema === undefined || raw.length === 0) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A truncated or malformed payload is the client's to diagnose, not ours to rewrite.
    return raw;
  }
  const pruned = pruneUndeclaredValue(parsed, schema);
  // Re-serializing an untouched payload would churn key order and spacing for nothing.
  return pruned === parsed ? raw : JSON.stringify(pruned);
}

/** Returns `value` itself when nothing was dropped, so a no-op is detectable by identity. */
function pruneUndeclaredValue(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) return value;
  // A branching or referenced schema does not name one closed set of legal keys.
  if (typeof schema.$ref === "string") return value;
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf) || Array.isArray(schema.allOf)) {
    return value;
  }
  // Keywords that legalize keys `properties` never names — `patternProperties` alone makes
  // `x-id` valid under `additionalProperties: false`. Evaluating them is out of scope, so
  // the declared set is unresolvable and the object stays whole.
  if (
    isRecord(schema.patternProperties)
    || isRecord(schema.dependentSchemas)
    || schema.if !== undefined
    || schema.unevaluatedProperties !== undefined
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    if (!isRecord(schema.items)) return value;
    let changed = false;
    const next = value.map((entry) => {
      const pruned = pruneUndeclaredValue(entry, schema.items);
      if (pruned !== entry) changed = true;
      return pruned;
    });
    return changed ? next : value;
  }

  if (!isRecord(value)) return value;
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (properties === undefined) return value;
  const closed = schema.additionalProperties === false;

  let changed = false;
  const next: Record<string, unknown> = { ...value };
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(properties, key)) {
      if (!closed) continue;
      delete next[key];
      changed = true;
      continue;
    }
    const pruned = pruneUndeclaredValue(entry, properties[key]);
    if (pruned !== entry) {
      next[key] = pruned;
      changed = true;
    }
  }
  return changed ? next : value;
}

/**
 * Chat Completions 청크 스트림을 canonical 이벤트로 번역한다.
 *
 * tool call 인자는 조각으로 흘러오지만 delta로 중계하지 않고 완결 시점에
 * `response.output_item.done` 하나로 내보낸다 — Responses 어댑터가 인자 delta를
 * 버리는 것과 같은 계약을 유지해, 하류가 두 어댑터에서 같은 모양을 본다.
 *
 * That single completion point is also where undeclared argument keys are pruned:
 * a partial fragment cannot be parsed, so pruning has nowhere else to stand.
 */
async function* translateChatCompletionsStream(
  body: ReadableStream<Uint8Array> | null,
  options: UpstreamReadOptions & { onClose: () => void },
  toolSchemas: DeclaredToolSchemas
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
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        yield {
          type: "response.reasoning_summary_text.delta",
          item_id: `${MESSAGE_ITEM_ID}_reasoning`,
          output_index: 0,
          delta: delta.reasoning_content,
        };
      }
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
      const args = pruneUndeclaredArguments(pending.arguments, toolSchemas.get(pending.name));
      // added→arguments.done→done 3종을 모두 낸다. 스트리밍 변환은 어느 조합이든
      // 합성하지만, 비스트리밍 collect는 added에서만 client tool_use 블록을 만들므로
      // done 단독 방출은 tool call을 통째로 삼킨다.
      const item = {
        id,
        type: "function_call" as const,
        call_id: id,
        name: pending.name,
        arguments: args,
      };
      yield { type: "response.output_item.added", output_index: outputIndex, item: { ...item, arguments: "" } };
      yield {
        type: "response.function_call_arguments.done",
        item_id: id,
        output_index: outputIndex,
        arguments: args,
      };
      yield { type: "response.output_item.done", output_index: outputIndex, item };
      outputIndex += 1;
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
        const frameData = chatFrameData(frame);
        if (frameData !== undefined) {
          // Raw provider payload before canonical consumeChunk assembly.
          logRawWireEvent("openai-chat.wire.event", frameData.event, frameData.data);
          yield* consumeChunk(frameData.data);
        }
        boundary = nextEventBoundary(buffer);
      }
    }

    if (buffer.trim().length > 0) {
      const frameData = chatFrameData(buffer);
      if (frameData !== undefined) {
        logRawWireEvent("openai-chat.wire.event", frameData.event, frameData.data);
        yield* consumeChunk(frameData.data);
      }
    }
    yield* finish();
  } finally {
    await reader.cancel().catch(() => undefined);
    options.onClose();
  }
}

function chatFrameData(frame: string): RawWireEventPayload | undefined {
  const { event: eventName, data } = parseSseFrameFields(frame);
  if (data.length === 0 || data === "[DONE]") {
    return undefined;
  }
  try {
    return {
      ...(eventName === undefined ? {} : { event: eventName }),
      data: JSON.parse(data) as unknown,
    };
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
