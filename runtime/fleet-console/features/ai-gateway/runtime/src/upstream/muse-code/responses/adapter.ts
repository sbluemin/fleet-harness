import type {
  AdapterCallOptions,
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalError,
  CanonicalFunctionTool,
  CanonicalOutputItem,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CanonicalResponseSnapshot,
  CanonicalUsage,
} from "../../../canonical/index.js";
import { withoutReplayMetadata } from "../../../canonical/index.js";
import {
  UpstreamProtocolError,
  linkAbortSignal,
  parseSseFrameFields,
  parseUpstreamSseStream,
  positiveInteger,
  readBoundedBody,
  type FetchLike,
} from "../../../transport/upstream-sse.js";
import { logRawWireEvent, wireLog } from "../../../transport/wire-log.js";
import type { QuotaWindow } from "../../../quota/types.js";
import { parseMuseCodeSubscriptionUsage } from "../quota.js";

/**
 * Muse Code 구독 키가 쓰는 Meta Model API Responses 엔드포인트.
 * 근거는 Muse Code CLI 문자열·oh-my-pi다. Fleet 실측(2026-09-25)은 contributor 모델의 짧은 도구 루프
 * 하나가 HTTP 200 SSE로 끝난 것까지다. 범용 어댑터가 되지 않도록 오버라이드는 두지 않는다.
 */
export const MUSE_CODE_RESPONSES_URL = "https://api.meta.ai/v1/responses";
export const MUSE_CODE_API_VERSION = "1.0.0";
/** 이 어댑터가 내보내는 reasoning blob의 출처이자, 재생을 허용하는 유일한 출처. 공급자 id와 같다. */
export const MUSE_CODE_REASONING_ORIGIN = "muse-code";
/** 현세대 Muse Spark의 출력 상한(소스 기반). */
export const MUSE_CODE_MAX_OUTPUT_TOKENS = 131_072;

const DEFAULT_MUSE_CODE_MAX_UPSTREAM_BODY_BYTES = 64 * 1024 * 1024;
/** 무응답 허용 시간. Claude Code의 유휴 감시(300s)보다 짧으면 클라이언트가 기다릴 턴을 먼저 끊는다. */
const DEFAULT_MUSE_CODE_UPSTREAM_IDLE_TIMEOUT_MS = 300_000;

/** 다음 턴이 재생할 수 있게 암호화 reasoning blob을 돌려받는다. */
const MUSE_CODE_REASONING_INCLUDE = "reasoning.encrypted_content";

/**
 * Muse Code 소유 Responses 와이어 형태. 같은 OpenAI 와이어라도 다른 공급자의 의미를 가져오지 않는다.
 * 아래 제약은 참고 소스(oh-my-pi 기록·Muse CLI 문자열)의 호환 정책이다. Fleet 실측(2026-09-25,
 * contributor, 2턴 도구 루프)은 이 요청 형태가 받아들여지는 것까지 확인했다: function 도구, strict 없음,
 * `tool_choice` 생략, `store:false`, `include`. 거부 사례(custom 도구, `auto` 외 선택)는 직접 확인하지 않았다.
 *
 * - function 도구만 보내며 Fleet이 strict를 추가하거나 스키마를 재작성하지 않는다. 호출자가 보낸
 *   strict는 그대로 보존하되, 이 엔드포인트의 strict:true 수락은 미검증이다. 참고 소스는 `custom`
 *   도구가 400이라 기록한다. strict 재작성과 null 제거는 둘 다 없고, 인자 delta는 그대로 흘린다.
 * - `tool_choice`는 참고 소스상 `auto`만 허용된다(나머지 400). 제약을 `auto`로 약화하지 않는다:
 *   `none`은 도구를 싣지 않는 것으로 지키고, 강제 선택은 동등 표현이 없어 전송 전에 거절한다.
 * - `metadata`·`service_tier`·호스티드 도구는 허용 근거가 없어 보내지 않는다.
 * - `reasoning`은 `effort`만 싣는다(oh-my-pi가 이 공급자에 보내는 형태, 직접 미검증).
 */
type MuseCodeWireTool = Omit<CanonicalFunctionTool, "defer_loading">;

/** 재생하는 reasoning 항목. canonical 입력에는 대응 항목이 없다. */
interface MuseCodeWireReasoningItem {
  type: "reasoning";
  id?: string;
  summary: [];
  encrypted_content: string;
}

type MuseCodeWireInputItem = MuseCodeWireReasoningItem | Record<string, unknown>;

interface MuseCodeResponsesWireRequest {
  model: string;
  input: MuseCodeWireInputItem[];
  instructions?: string;
  tools?: MuseCodeWireTool[];
  tool_choice?: "auto";
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  reasoning?: { effort: string };
  include?: string[];
  store: false;
  stream: true;
}

export interface MuseCodeResponsesAdapterOptions {
  fetch?: FetchLike;
  maxBodyBytes?: number;
  idleTimeoutMs?: number;
  /**
   * 스트림 끝의 `response.subscription_usage` 이벤트가 알려 준 구독 사용량. 응답 완료 뒤에
   * 오므로 소비자가 스트림을 끝까지 읽을 때만 불린다. 관측의 실패는 응답에 영향을 주지 않는다.
   */
  onSubscriptionUsage?: (windows: readonly QuotaWindow[]) => void;
}

export class MuseCodeResponsesAdapter implements AiGatewayAdapter {
  readonly capabilities = {} as const;
  private readonly fetchImpl: FetchLike;
  private readonly maxBodyBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly onSubscriptionUsage: ((windows: readonly QuotaWindow[]) => void) | undefined;

  constructor(options: MuseCodeResponsesAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.onSubscriptionUsage = options.onSubscriptionUsage;
    this.maxBodyBytes = positiveInteger(
      options.maxBodyBytes ?? DEFAULT_MUSE_CODE_MAX_UPSTREAM_BODY_BYTES,
      "maxBodyBytes",
    );
    this.idleTimeoutMs = positiveInteger(
      options.idleTimeoutMs ?? DEFAULT_MUSE_CODE_UPSTREAM_IDLE_TIMEOUT_MS,
      "idleTimeoutMs",
    );
  }

  wireTools(request: CanonicalResponseRequest): readonly CanonicalFunctionTool[] {
    return request.tool_choice === "none" ? [] : museCodeWireTools(request);
  }

  async stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions,
  ): Promise<AdapterResponse> {
    if (options.apiKey.length === 0) {
      throw new TypeError("apiKey must not be empty");
    }
    const refusal = unsupportedToolChoice(request);
    if (refusal !== undefined) return refusal;

    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(options.signal, controller);
    const payload = forMuseCodeResponsesBackend(request);
    // 업스트림에 보내는 본문 그대로. 키는 헤더에만 있고 본문에는 없다.
    wireLog("muse-code-responses.wire.request", { url: MUSE_CODE_RESPONSES_URL, payload });
    let response: Response;
    try {
      response = await this.fetchImpl(MUSE_CODE_RESPONSES_URL, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          "x-api-version": MUSE_CODE_API_VERSION,
        },
        body: JSON.stringify(payload),
        // 고정 엔드포인트 밖으로 본문·헤더가 재전송되지 않게 리다이렉트를 따르지 않는다.
        // 기본값은 307/308에서 본문을 다른 출처로 다시 보낸다(로컬 fixture로 확인).
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      unlinkAbort();
      throw error;
    }

    if (!response.ok) {
      try {
        const body = await readBoundedBody(response.body, {
          controller,
          idleTimeoutMs: this.idleTimeoutMs,
          maxBodyBytes: this.maxBodyBytes,
        });
        return {
          ok: false,
          status: response.status,
          headers: response.headers,
          body: response.status === 401 || response.status === 403
            ? signInRefusedBody(response.status)
            : body,
        };
      } finally {
        unlinkAbort();
      }
    }

    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      events: parseUpstreamSseStream(
        response.body,
        {
          controller,
          idleTimeoutMs: this.idleTimeoutMs,
          maxBodyBytes: this.maxBodyBytes,
          onClose: unlinkAbort,
          missingBodyMessage: "Muse Code streaming response had no body",
        },
        (frame) => parseEventFrame(frame, this.onSubscriptionUsage),
      ),
    };
  }
}

/**
 * 키 거부는 CLI에서 다시 로그인해 고칠 문제다. 거부 본문이 무엇을 되돌려 주는지 검증되지
 * 않았으므로 원문은 중계하지 않고 안내로 바꾼다.
 */
function signInRefusedBody(status: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    error: {
      type: status === 401 ? "authentication_error" : "permission_error",
      message: `Muse Code refused the local sign-in (HTTP ${status}). Run \`muse login\` again, then retry.`,
    },
  }));
}

/**
 * 이 엔드포인트가 표현할 수 없는 강제 도구 선택은 요청을 쓰기 전에 거절한다. `auto`로 보내면
 * 모델이 산문으로 답해도 되므로 호출자의 계약이 조용히 깨진다.
 */
function unsupportedToolChoice(request: CanonicalResponseRequest): AdapterResponse | undefined {
  const choice = request.tool_choice;
  if (choice === undefined || choice === "auto" || choice === "none") return undefined;
  const wanted = choice === "required" ? "a required tool call" : `a forced call to "${choice.name}"`;
  return {
    ok: false,
    status: 400,
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode(JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: `Muse Code accepts only automatic tool choice and cannot honor ${wanted}.`,
      },
    })),
  };
}

function forMuseCodeResponsesBackend(request: CanonicalResponseRequest): MuseCodeResponsesWireRequest {
  const input: MuseCodeWireInputItem[] = [];
  for (const item of request.input) {
    if (item.type === "function_call_output") {
      const { is_error: _isError, tool_references: _toolReferences, ...wireItem } = item;
      input.push(wireItem);
      continue;
    }
    if (item.type !== "message" && item.type !== "function_call") {
      input.push(withoutReplayMetadata(item) as Record<string, unknown>);
      continue;
    }
    const encrypted = museCodeReplayBlob(item);
    // blob은 이 항목을 만든 턴의 것이므로 와이어가 낸 위치 그대로 바로 앞에 둔다.
    if (encrypted !== undefined) {
      input.push({
        type: "reasoning",
        ...(item.reasoning_id ? { id: upstreamItemId(item.reasoning_id) } : {}),
        summary: [],
        encrypted_content: encrypted,
      });
    }
    input.push(withoutReplayMetadata(item));
  }

  // `none`은 도구를 호출하지 말라는 뜻이므로 도구를 싣지 않는 것이 정확한 동등 표현이다.
  const tools = request.tool_choice === "none" ? [] : museCodeWireTools(request);
  const maxOutputTokens = request.max_output_tokens === undefined
    ? undefined
    : Math.min(request.max_output_tokens, MUSE_CODE_MAX_OUTPUT_TOKENS);

  return {
    model: request.model,
    input,
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(tools.length > 0 && request.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: request.parallel_tool_calls }
      : {}),
    ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    ...(request.reasoning?.effort === undefined ? {} : { reasoning: { effort: request.reasoning.effort } }),
    include: [MUSE_CODE_REASONING_INCLUDE],
    // 상태 없는 재생은 암호화 reasoning으로 하고, 업스트림에 응답을 저장하지 않는다(oh-my-pi와 같은 형태, contributor 짧은 경로에서 수락 확인).
    store: false,
    stream: true,
  };
}

/** 이 공급자가 발급한 blob만 재생한다. 출처가 없는 v1 서명도 다른 공급자의 것일 수 있어 제외한다. */
function museCodeReplayBlob(item: { reasoning_encrypted?: string; reasoning_origin?: string }): string | undefined {
  const encrypted = item.reasoning_encrypted;
  if (encrypted === undefined || encrypted.length === 0) return undefined;
  return item.reasoning_origin === MUSE_CODE_REASONING_ORIGIN ? encrypted : undefined;
}

/**
 * Muse는 reasoning 항목 id를 `rs_<hex>:rs_<hex>`처럼 콜론을 넣어 보낸다(실측). reasoning 서명은 콜론이
 * 있는 id를 싣지 못해 blob을 버리므로, 이 어댑터는 모든 항목 id를 되돌릴 수 있게 이스케이프해 canonical에
 * 넘기고 재생할 때 원래 id로 복원한다. 항목 id와 그 id를 가리키는 event의 `item_id`가 같은 변환을 거쳐야
 * 블록 짝이 맞는다. `%`를 먼저 바꿔야 원래 `%3A`와 섞이지 않는다.
 */
function canonicalItemId(id: string): string {
  return id.replace(/%/g, "%25").replace(/:/g, "%3A");
}

function upstreamItemId(id: string): string {
  return id.replace(/%3A/g, ":").replace(/%25/g, "%");
}

function museCodeWireTools(request: CanonicalResponseRequest): MuseCodeWireTool[] {
  return (request.tools ?? []).map(({ defer_loading: _deferLoading, ...tool }) => {
    const parameters = readablePatternParameters(tool.parameters);
    return parameters === tool.parameters ? tool : { ...tool, parameters };
  });
}

/**
 * 읽지 못할 수 있는 `pattern`을 선제적으로 뺀다. 이 엔드포인트에서는 직접 검증하지 않았다.
 * 근거는 다른 경로의 관찰뿐이다: OpenCode Go 경유 `muse-spark-1.3-contributor`에서 역슬래시+숫자
 * (`\0`, `\1`)가 요청 전체를 400으로 실패시켰다(2026-09-19, OpenCode 어댑터 기록). 같은 모델이라
 * 재발할 수 있고, `pattern`은 권고일 뿐 강제되지 않아 빼도 관찰 가능한 손실이 없다. lookaround·Unicode
 * 속성 이스케이프는 다른 Responses 어댑터와 같은 규칙으로 뺀다.
 */
const UNREADABLE_PATTERN = /\(\?[=!<]|\\[pP]\{|\\[0-9]/u;

function readablePatternParameters(schema: Record<string, unknown>): Record<string, unknown> {
  const converted = readablePatternSchema(schema);
  return isRecord(converted) ? converted : schema;
}

/** `pattern` 키의 문자열만 뺀다(이름이 `pattern`인 프로퍼티는 유지). 바뀌지 않은 노드는 그대로 돌려준다. */
function readablePatternSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    const next = value.map(readablePatternSchema);
    return next.some((entry, index) => entry !== value[index]) ? next : value;
  }
  if (!isRecord(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "pattern" && typeof entry === "string" && UNREADABLE_PATTERN.test(entry)) {
      changed = true;
      continue;
    }
    const converted = readablePatternSchema(entry);
    if (converted !== entry) changed = true;
    next[key] = converted;
  }
  return changed ? next : value;
}

function parseEventFrame(
  frame: string,
  onSubscriptionUsage?: (windows: readonly QuotaWindow[]) => void,
): CanonicalResponseEvent | undefined {
  const { event: eventName, data } = parseSseFrameFields(frame);
  if (data.length === 0 || data === "[DONE]") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new UpstreamProtocolError(
      `Muse Code SSE contained invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  logRawWireEvent("muse-code-responses.wire.event", eventName, parsed);
  if (isRecord(parsed) && typeof parsed.type !== "string" && eventName !== undefined) {
    parsed = { ...parsed, type: eventName };
  }
  if (isRecord(parsed) && parsed.type === "response.subscription_usage") {
    observeSubscriptionUsage(parsed.subscription, onSubscriptionUsage);
    return undefined;
  }
  return canonicalEvent(parsed);
}

/** 사용량은 부가 정보다. 모양이 틀리거나 관측자가 실패해도 응답 스트림은 계속된다. */
function observeSubscriptionUsage(
  subscription: unknown,
  onSubscriptionUsage: ((windows: readonly QuotaWindow[]) => void) | undefined,
): void {
  if (!onSubscriptionUsage) return;
  const windows = parseMuseCodeSubscriptionUsage(subscription);
  if (!windows) return;
  try {
    onSubscriptionUsage(windows);
  } catch {
    // 관측자의 실패를 응답 실패로 바꾸지 않는다.
  }
}

function canonicalEvent(value: unknown): CanonicalResponseEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new UpstreamProtocolError("Muse Code SSE event was not an object with a type");
  }
  switch (value.type) {
    case "response.created":
      return { type: value.type, response: responseSnapshot(value.response) };
    case "response.content_part.added": {
      const part = record(value.part, "response.content_part.added.part");
      if (part.type !== "output_text") return undefined;
      return {
        type: value.type,
        item_id: canonicalItemId(string(value.item_id, "item_id")),
        output_index: number(value.output_index, "output_index"),
        content_index: number(value.content_index, "content_index"),
        part: { type: "output_text", text: typeof part.text === "string" ? part.text : "" },
      };
    }
    case "response.output_text.delta":
      return {
        type: value.type,
        item_id: canonicalItemId(string(value.item_id, "item_id")),
        output_index: number(value.output_index, "output_index"),
        content_index: number(value.content_index, "content_index"),
        delta: string(value.delta, "delta"),
      };
    case "response.output_text.done":
      return {
        type: value.type,
        item_id: canonicalItemId(string(value.item_id, "item_id")),
        output_index: number(value.output_index, "output_index"),
        content_index: number(value.content_index, "content_index"),
        text: string(value.text, "text"),
      };
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta":
      return {
        type: "response.reasoning_summary_text.delta",
        item_id: canonicalItemId(string(value.item_id, "item_id")),
        output_index: number(value.output_index, "output_index"),
        delta: string(value.delta, "delta"),
      };
    case "response.output_item.added":
    case "response.output_item.done": {
      const item = outputItem(value.item);
      if (item === undefined) return undefined;
      return { type: value.type, output_index: number(value.output_index, "output_index"), item };
    }
    // strict 재작성이 없으므로 조각이 모델 원문 그대로라 바로 흘려도 된다.
    case "response.function_call_arguments.delta":
      return {
        type: value.type,
        item_id: canonicalItemId(string(value.item_id, "item_id")),
        output_index: number(value.output_index, "output_index"),
        delta: string(value.delta, "delta"),
      };
    case "response.function_call_arguments.done":
      return {
        type: value.type,
        item_id: canonicalItemId(string(value.item_id, "item_id")),
        output_index: number(value.output_index, "output_index"),
        arguments: string(value.arguments, "arguments"),
      };
    case "response.completed":
      return { type: value.type, response: responseSnapshot(value.response) };
    case "response.failed": {
      const response = record(value.response, "response.failed.response");
      return {
        type: value.type,
        response: { ...responseSnapshot(response), error: canonicalError(response.error) },
      };
    }
    case "error":
      return { type: "error", error: canonicalError(value.error ?? value) };
    default:
      return undefined;
  }
}

function responseSnapshot(value: unknown): CanonicalResponseSnapshot {
  const response = record(value, "response");
  return {
    id: string(response.id, "response.id"),
    model: string(response.model, "response.model"),
    usage: response.usage === null || response.usage === undefined ? null : usage(response.usage),
  };
}

function usage(value: unknown): CanonicalUsage {
  const parsed = record(value, "usage");
  const inputTokens = number(parsed.input_tokens, "usage.input_tokens");
  const outputTokens = number(parsed.output_tokens, "usage.output_tokens");
  const inputDetails = optionalRecord(parsed.input_tokens_details, "usage.input_tokens_details");
  const cachedInputTokens = inputDetails === undefined
    ? undefined
    : optionalNonNegativeNumber(inputDetails.cached_tokens, "usage.input_tokens_details.cached_tokens");
  const outputDetails = optionalRecord(parsed.output_tokens_details, "usage.output_tokens_details");
  const reasoningOutputTokens = outputDetails === undefined
    ? undefined
    : optionalNonNegativeNumber(outputDetails.reasoning_tokens, "usage.output_tokens_details.reasoning_tokens");
  const totalTokens = optionalNonNegativeNumber(parsed.total_tokens, "usage.total_tokens");
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cached_input_tokens: cachedInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoning_output_tokens: reasoningOutputTokens }),
    ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
  };
}

function outputItem(value: unknown): CanonicalOutputItem | undefined {
  const item = record(value, "item");
  if (item.type === "message") {
    return { id: canonicalItemId(string(item.id, "item.id")), type: "message", role: "assistant" };
  }
  if (item.type === "function_call") {
    const id = string(item.id, "item.id");
    return {
      id: canonicalItemId(id),
      type: "function_call",
      // call_id는 tool_use id로 왕복해 그대로 돌아오므로 원문을 둔다.
      call_id: typeof item.call_id === "string" ? item.call_id : id,
      name: string(item.name, "item.name"),
      arguments: typeof item.arguments === "string" ? item.arguments : "",
    };
  }
  // 다음 턴 재생용 blob만 내보낸다. 텍스트는 이미 reasoning delta로 흘렀다.
  if (item.type === "reasoning") {
    const encrypted = typeof item.encrypted_content === "string" && item.encrypted_content.length > 0
      ? item.encrypted_content
      : undefined;
    if (encrypted === undefined) return undefined;
    return {
      id: typeof item.id === "string" ? canonicalItemId(item.id) : "",
      type: "reasoning",
      encrypted_content: encrypted,
      origin: MUSE_CODE_REASONING_ORIGIN,
    };
  }
  return undefined;
}

function canonicalError(value: unknown): CanonicalError {
  const error = record(value, "error");
  const message = string(error.message, "error.message");
  const type = typeof error.type === "string" && error.type !== "error"
    ? error.type
    : typeof error.code === "string"
      ? error.code
      : "api_error";
  return { type, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new UpstreamProtocolError(`${name} must be an object`);
  return value;
}

function optionalRecord(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return record(value, name);
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new UpstreamProtocolError(`${name} must be a string`);
  return value;
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UpstreamProtocolError(`${name} must be a number`);
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new UpstreamProtocolError(`${name} must be a finite nonnegative number`);
  }
  return value;
}
