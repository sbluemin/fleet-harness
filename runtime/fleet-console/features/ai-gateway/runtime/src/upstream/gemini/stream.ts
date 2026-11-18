import { randomUUID } from "node:crypto";

import type {
  CanonicalError,
  CanonicalResponseEvent,
  CanonicalUsage,
} from "../../canonical/index.js";
import { ContextWindowExceededError } from "../../canonical/index.js";
import type { GeminiBlockObservation, GeminiUsagePort } from "../../quota/gemini-usage.js";
import { UpstreamProtocolError } from "../../transport/upstream-sse.js";
import { logRawWireEvent } from "../../transport/wire-log.js";
import { isGeminiModelId } from "./coordinates.js";
import {
  GEMINI_REASONING_ORIGIN,
  isGeminiSignature,
  type GeminiSignatureLedger,
  type ToolNameCodec,
} from "./wire.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * `usageMetadata`를 canonical 사용량으로.
 *
 * `totalTokenCount`는 `candidatesTokenCount`가 빼는 생각 토큰을 포함하므로, 출력은 보이는 토큰에
 * 숨은 토큰을 더해 보고한다. 그러지 않으면 생각 542 + 보이는 51 토큰 턴이 51로 센다.
 */
export function geminiCanonicalUsage(value: unknown): CanonicalUsage | null {
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

/**
 * 오류 본문의 `error`. 두 모양이 같이 산다:
 * - google.rpc: `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":...,"details":[...]}}`
 *   (2026-11-18 사령관 실측: 잘못된 키 → `code 400, status INVALID_ARGUMENT, details[].reason API_KEY_INVALID`).
 * - api-errors 문서의 문자열 코드: `{"error":{"code":"payment_required","message":...}}`
 *   (문서의 표는 Interactions API 기준이라 v1beta REST가 이 모양을 쓴다고 확인된 바는 없다. 둘 다 읽는다.)
 */
function errorRecord(value: unknown): Record<string, unknown> | undefined {
  const error = isRecord(value) ? value.error : undefined;
  return isRecord(error) ? error : undefined;
}

/** 잘못된 키. v1beta REST는 401이 아니라 `400 INVALID_ARGUMENT` + `details[].reason === "API_KEY_INVALID"`로 답한다(2026-11-18 사령관 실측). */
export function isInvalidApiKeyError(value: unknown): boolean {
  const error = errorRecord(value);
  if (!error || !Array.isArray(error.details)) return false;
  return error.details.some((detail) => isRecord(detail) && detail.reason === "API_KEY_INVALID");
}

/**
 * 402·429로 읽히는 차단. HTTP 상태가 있으면 그것이 먼저고(스트림 중 오류 프레임에는 없다),
 * 없으면 본문의 숫자 `code`, google.rpc `status`, 문서의 문자열 코드 순으로 본다.
 * 근거: 문서 api-errors(402 `payment_required`, 429 `rate_limit_exceeded`·`quota_exceeded`·
 * `too_many_requests`)와 rate-limits(지출 한도 초과는 `429 RESOURCE_EXHAUSTED`), 2026-11-18 확인.
 */
export function geminiBlock(
  value: unknown,
  httpStatus: number | undefined,
): Pick<GeminiBlockObservation, "httpStatus" | "reason" | "code" | "message"> | undefined {
  const error = errorRecord(value);
  const status = typeof error?.status === "string" ? error.status : undefined;
  const code = error?.code;
  const stringCode = typeof code === "string" ? code : undefined;
  let blocked: 402 | 429 | undefined;
  if (httpStatus === 402 || httpStatus === 429) blocked = httpStatus;
  else if (httpStatus === undefined || httpStatus === 200) {
    if (code === 402 || stringCode === "payment_required") blocked = 402;
    else if (
      code === 429
      || status === "RESOURCE_EXHAUSTED"
      || stringCode === "rate_limit_exceeded"
      || stringCode === "quota_exceeded"
      || stringCode === "too_many_requests"
    ) blocked = 429;
  }
  if (blocked === undefined) return undefined;
  const machineCode = status ?? stringCode;
  const message = typeof error?.message === "string" && error.message.length > 0
    ? error.message.slice(0, 500)
    : undefined;
  return {
    httpStatus: blocked,
    reason: blocked === 402 ? "balance_depleted" : "rate_limited",
    ...(machineCode === undefined ? {} : { code: machineCode }),
    ...(message === undefined ? {} : { message }),
  };
}

/**
 * 503 UNAVAILABLE(용량 거절). 402·429와 달리 차단이 아니다 — 원장에 알리지 않는다. 숫자 `code`, google.rpc
 * `status`, 문서의 문자열 코드(`service_unavailable`)를 모두 읽는다.
 */
export function isUnavailableError(value: unknown): boolean {
  const error = errorRecord(value);
  return error?.code === 503 || error?.status === "UNAVAILABLE" || error?.code === "service_unavailable";
}

/** `{error:{code,message,status}}`. 본문과 스트림 프레임이 같은 모양을 쓴다. */
export function geminiError(value: unknown): CanonicalError | undefined {
  const error = errorRecord(value);
  if (!error) return undefined;
  const message = typeof error.message === "string" && error.message.length > 0
    ? error.message
    : "Gemini request failed";
  const status = typeof error.status === "string" ? error.status : undefined;
  const code = typeof error.code === "number" ? error.code : undefined;
  // Vertex가 입력 토큰 초과를 400 INVALID_ARGUMENT로 문서화한다. 429 한도와는 무관하다.
  if ((status === "INVALID_ARGUMENT" || code === 400)
    && (status === undefined || status === "INVALID_ARGUMENT")
    && (code === undefined || code === 400)
    && (/^Request exceeds the model['’]s input token limit\.?$/i.test(message)
      || /^The input token count \(\d+\) exceeds the maximum number of tokens allowed \(\d+\)\.?$/i.test(message))) {
    const tokens = /^The input token count \((\d+)\) exceeds the maximum number of tokens allowed \((\d+)\)/i.exec(message);
    throw new ContextWindowExceededError(tokens ? Number(tokens[1]) : undefined, tokens ? Number(tokens[2]) : undefined);
  }
  if (isInvalidApiKeyError(value)) return { type: "authentication_error", message };
  return { type: canonicalErrorType(status, code, typeof error.code === "string" ? error.code : undefined), message };
}

function canonicalErrorType(status: string | undefined, code: number | undefined, stringCode: string | undefined): string {
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
  if (stringCode === "payment_required") return "billing_error";
  if (code === 401) return "authentication_error";
  if (code === 402) return "billing_error";
  if (code === 403) return "permission_error";
  if (code === 429) return "rate_limit_error";
  if (code === 400 || code === 404) return "invalid_request_error";
  if (code === 503) return "overloaded_error";
  return "api_error";
}

/** 후보가 끝났다는 `finishReason`. `FINISH_REASON_UNSPECIFIED`는 문서상 쓰이지 않는다. */
const GEMINI_COMPLETE_REASONS: ReadonlySet<string> = new Set(["STOP", "FINISH_REASON_UNSPECIFIED"]);

/** 안전·콘텐츠 필터 중단. `finishReason`과 `promptFeedback.blockReason`을 가로지른다. */
const GEMINI_CONTENT_FILTER_REASONS: ReadonlySet<string> = new Set([
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
 * 업스트림이 답을 미완으로 선언했는가, 왜인가.
 *
 * Anthropic stop reason이 있는 건 한도와 필터뿐이다. 그 밖의 중단 — `OTHER`,
 * `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, `MISSING_THOUGHT_SIGNATURE`(공식 reference의
 * finishReason 목록, 2026-11-18), 이 목록보다 새 값 — 은 공급자 값을 그대로 두어 하류 wire가
 * 완결로 위장하지 않고 그 이름을 단 오류로 바꾸게 한다.
 *
 * `finishReason`도 `blockReason`도 없이 끝난 스트림은 말없이 잘린 것이고 같은 사유 없는 오류가 된다.
 */
function geminiIncomplete(
  finishReason: string | undefined,
  promptBlockReason: string | undefined,
): { reason?: string } | undefined {
  if (finishReason !== undefined) {
    if (GEMINI_COMPLETE_REASONS.has(finishReason)) return undefined;
    if (finishReason === "MAX_TOKENS") return { reason: "max_output_tokens" };
    if (GEMINI_CONTENT_FILTER_REASONS.has(finishReason)) return { reason: "content_filter" };
    return { reason: finishReason };
  }
  if (promptBlockReason !== undefined) {
    if (GEMINI_CONTENT_FILTER_REASONS.has(promptBlockReason)) return { reason: "content_filter" };
    return { reason: `prompt blocked: ${promptBlockReason}` };
  }
  return {};
}

export interface GeminiFrame {
  readonly response?: Record<string, unknown>;
  readonly error?: unknown;
}

/**
 * SSE 프레임 하나를 파싱한다. 공개 API는 `data: {...}` 줄에 Gemini 응답을 그대로 싣는다
 * (2026-11-18 사령관 실측). `error` 프레임은 HTTP 200 뒤에도 올 수 있다. 둘 다 없는 프레임은
 * keepalive라 아무것도 내지 않는다.
 */
export function parseGeminiFrame(data: string): GeminiFrame | undefined {
  const trimmed = data.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new UpstreamProtocolError("Gemini stream frame was not valid JSON");
  }
  if (!isRecord(parsed)) return undefined;
  logRawWireEvent("gemini.wire.event", undefined, parsed);
  if (isRecord(parsed.error)) return { error: parsed };
  return { response: parsed };
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
  return isGeminiSignature(direct) ? direct : undefined;
}

export interface TranslateStreamOptions {
  readonly codec: ToolNameCodec;
  readonly ledger: GeminiSignatureLedger;
  /** 업스트림이 모델을 알려 주지 않을 때 되돌려 쓰는 카탈로그 모델 id. 사용량 관찰에도 이 id를 쓴다. */
  readonly model: string;
  /**
   * 요청마다 유일한 `call_id` 접두어.
   *
   * `functionCall.id`는 이 wire에서 선택이다. 관측한 응답에는 늘 있었지만 없으면 만들어야 하고,
   * call id는 자기 응답을 넘어 사는 유일한 id다(클라이언트가 다음 턴 `tool_result`로 돌려보내고
   * 재생된 history가 그 id로 묶인다). 스트림별 카운터만 쓰면 2턴이 1턴과 같은 `agc_0`을 받아
   * `linkFunctionResponseNames`가 앞 호출의 결과에 뒤 호출의 이름을 붙인다.
   */
  readonly callIdPrefix: string;
  /** 지출 원장 포트. 없으면 사용량·차단을 아무 데도 알리지 않는다. */
  readonly usage?: GeminiUsagePort;
}

/** 포트는 동기·무예외여야 하지만, 추론 경로가 원장의 버그에 막히지 않도록 여기서도 삼킨다. */
function observe(callback: () => void): void {
  try {
    callback();
  } catch {
    // 원장이 던져도 응답 스트림은 계속된다.
  }
}

/**
 * Gemini 스트림을 canonical 이벤트로 번역한다.
 *
 * 순서가 핵심이다. 추론 항목은 자기가 속한 `function_call` **앞**에 내보낸다. Anthropic 인코더가 이를
 * 클라이언트가 그대로 돌려줄 thinking 블록의 signature로 바꾸고, 요청 번역기는 thinking 블록을 뒤따르는
 * 도구 호출과 짝짓기 때문이다. 호출 뒤에 내보내면 blob이 다음 도구 호출에 넘어가 그 턴이 업스트림에서
 * 실패한다. 병렬 호출은 첫 호출에만 서명이 붙고(선행 실측 2026-08-22) 이 짝짓기가 그대로 재현한다.
 *
 * 사용량: `usageMetadata`는 매 청크에 누적값으로 온다(2026-11-18 사령관 실측, 청크1 prompt 7·thoughts 25
 * → 마지막 prompt 38·thoughts 25). 합산하지 않고 마지막 값을 쓰며, 턴이 완결했을 때 한 번만 포트에 보낸다.
 */
export async function* translateGeminiStream(
  frames: AsyncIterable<GeminiFrame>,
  options: TranslateStreamOptions,
): AsyncGenerator<CanonicalResponseEvent> {
  let started = false;
  let responseId = "";
  let model = options.model;
  let usage: CanonicalUsage | null = null;
  let usageMetadata: Record<string, unknown> | undefined;
  let outputIndex = 0;
  let sequence = 0;

  // JavaScript 호출자가 아무것도 안 넘길 수 있다. `agc_undefined_0`은 카운터만 쓸 때처럼 충돌한다.
  const callIdPrefix = options.callIdPrefix && options.callIdPrefix.length > 0
    ? options.callIdPrefix
    : randomUUID();

  let textItemId: string | undefined;
  let reasoningItemId: string | undefined;
  let finishReason: string | undefined;
  let promptBlockReason: string | undefined;
  let failed: CanonicalError | undefined;
  let failedFrame: unknown;

  const snapshot = () => ({ id: responseId, model, usage });

  function* closeText(): Generator<CanonicalResponseEvent> {
    if (textItemId === undefined) return;
    yield { type: "response.output_text.done", item_id: textItemId, output_index: outputIndex, content_index: 0, text: "" };
    outputIndex += 1;
    textItemId = undefined;
  }

  /** 열린 추론 구간을 닫고 업스트림이 그 구간에 발행한 blob을 붙인다. */
  function* closeReasoning(signature: string | undefined): Generator<CanonicalResponseEvent> {
    if (reasoningItemId === undefined && signature === undefined) return;
    const id = reasoningItemId ?? `gmr_${sequence++}`;
    yield {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        id,
        type: "reasoning",
        ...(signature === undefined ? {} : { encrypted_content: signature }),
        origin: GEMINI_REASONING_ORIGIN,
      },
    };
    outputIndex += 1;
    reasoningItemId = undefined;
  }

  for await (const frame of frames) {
    if (frame.error !== undefined) {
      failedFrame = frame.error;
      failed = geminiError(frame.error) ?? { type: "api_error", message: "Gemini request failed" };
      break;
    }
    const response = frame.response;
    if (!response) continue;

    if (typeof response.responseId === "string" && responseId.length === 0) responseId = response.responseId;
    if (typeof response.modelVersion === "string" && response.modelVersion.length > 0) {
      model = response.modelVersion;
    }
    if (isRecord(response.usageMetadata)) {
      usageMetadata = response.usageMetadata;
      usage = geminiCanonicalUsage(response.usageMetadata);
    }

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
        const itemId = `gmf_${sequence++}`;
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
            reasoningItemId = `gmr_${sequence++}`;
          }
          yield { type: "response.reasoning_summary_text.delta", item_id: reasoningItemId, output_index: outputIndex, delta: text };
        }
        // thought 파트 자신의 서명이 그 구간을 닫는다.
        if (signature !== undefined) yield* closeReasoning(signature);
        continue;
      }

      if (text.length > 0) {
        yield* closeReasoning(undefined);
        if (textItemId === undefined) {
          textItemId = `gmm_${sequence++}`;
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
      // Gemini는 텍스트 턴을 그 턴의 blob을 실은 빈 파트로 닫는다(2026-11-18 사령관 실측: 마지막 청크
      // `{"text":"","thoughtSignature":...}`). blob은 assistant 메시지에 속하고, 클라이언트가
      // 그 메시지를 재생해 주므로 우리는 되돌려 받는다.
      if (signature !== undefined) yield* closeReasoning(signature);
    }
  }

  yield* closeText();
  yield* closeReasoning(undefined);

  if (failed) {
    const block = geminiBlock(failedFrame, undefined);
    if (block && isGeminiModelId(options.model)) {
      const observation: GeminiBlockObservation = { model: options.model, at: Date.now(), ...block };
      observe(() => options.usage?.observeBlock(observation));
    }
    yield { type: "response.failed", response: { ...snapshot(), error: failed } };
    return;
  }
  if (!started) {
    throw new UpstreamProtocolError("Gemini stream produced no response frames");
  }
  if (usageMetadata !== undefined && isGeminiModelId(options.model)) {
    const meta = usageMetadata;
    const serviceTier = typeof meta.serviceTier === "string" && meta.serviceTier.length > 0 ? meta.serviceTier : undefined;
    const observedModel = options.model;
    observe(() => options.usage?.observeUsage({
      model: observedModel,
      at: Date.now(),
      ...(serviceTier === undefined ? {} : { serviceTier }),
      promptTokens: positiveNumber(meta.promptTokenCount) ?? 0,
      cachedTokens: positiveNumber(meta.cachedContentTokenCount) ?? 0,
      candidatesTokens: positiveNumber(meta.candidatesTokenCount) ?? 0,
      thoughtsTokens: positiveNumber(meta.thoughtsTokenCount) ?? 0,
    }));
  }
  const incomplete = geminiIncomplete(finishReason, promptBlockReason);
  yield {
    type: "response.completed",
    response: {
      ...snapshot(),
      ...(incomplete === undefined ? {} : { incomplete }),
    },
  };
}
