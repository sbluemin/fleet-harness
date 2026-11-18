import type {
  AnthropicBlockObservation,
  AnthropicUsageObservation,
  AnthropicUsagePort,
} from "../../quota/anthropic-usage.js";
import type { ProviderRateLimit, ProviderRateLimitWindow } from "../../quota/types.js";

/**
 * Anthropic API 키 passthrough의 관찰 tap.
 *
 * 응답 바이트는 한 글자도 바꾸지 않고 흘려 보내면서, 옆에서 세 가지를 읽는다: ① `anthropic-ratelimit-*`
 * 헤더, ② SSE `message_start`·`message_delta`의 usage(턴이 끝나면 지출 원장으로), ③ 크레딧·지출 한도·
 * 속도 한도 거절. 이 모듈은 어떤 값도 꾸며 내지 않는다 — 정상 종료하지 않았거나 usage가 없으면 지출을 보고하지
 * 않는다.
 */
export interface AnthropicPassthroughObserver {
  /** 상류 응답을 받은 직후(본문 전). */
  readonly response: (status: number, headers: Headers) => void;
  /** 상류 본문 청크. 원문 그대로다. */
  readonly chunk: (chunk: Uint8Array) => void;
  /** 본문을 끝까지 읽었을 때만. 중간에 끊기면 부르지 않는다. */
  readonly end: () => void;
}

export interface AnthropicObserverOptions {
  /** 카탈로그의 상류 모델 id(Claude Code 동기화가 알려 준 값). 단가가 없는 가족도 관찰은 한다 — 값은 원장이 가린다. */
  readonly model: string;
  readonly port: AnthropicUsagePort;
  /**
   * 요청이 1시간 TTL 캐시 중단점을 하나라도 실었는가. 스트림 usage에 `cache_creation` 분해가 없을 때만
   * 쓰는 대체 판정이다 — 아래 `splitCacheWrites` 참조.
   */
  readonly oneHourCache: boolean;
  readonly now?: () => number;
}

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/**
 * 요청 본문이 1시간 TTL 캐시를 요구하는가. `system`·`tools`·`messages[].content`의 `cache_control.ttl`과
 * 최상위 `cache_control`(자동 캐싱)만 본다. Claude Code는 구독 상태로 호출하면 1시간 TTL을 요청한다
 * (Agent SDK 비용 문서) — 그 자식이 구독 로그인인 채로 크레딧 모델을 부르므로 이 값이 참일 수 있다.
 */
export function requestUsesOneHourCache(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const marks = (value: unknown): boolean => isRecord(value) && isRecord(value.cache_control) && value.cache_control.ttl === "1h";
  const anyMark = (list: unknown): boolean => Array.isArray(list) && list.some(marks);
  if (marks(body)) return true;
  if (anyMark(body.system) || anyMark(body.tools)) return true;
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isRecord(message) && anyMark(message.content)) return true;
    }
  }
  return false;
}

const RATE_LIMIT_GROUPS = [
  ["requests", "requests"],
  ["input-tokens", "inputTokens"],
  ["output-tokens", "outputTokens"],
] as const;

function rateLimitWindow(headers: Headers, group: string): ProviderRateLimitWindow | undefined {
  const rawLimit = headers.get(`anthropic-ratelimit-${group}-limit`);
  const rawRemaining = headers.get(`anthropic-ratelimit-${group}-remaining`);
  const rawReset = headers.get(`anthropic-ratelimit-${group}-reset`);
  if (rawLimit === null || rawRemaining === null || rawReset === null) return undefined;
  const limit = Number(rawLimit);
  const remaining = Number(rawRemaining);
  const reset = Date.parse(rawReset);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(reset)) return undefined;
  return { limit, remaining, resetsAt: reset };
}

/**
 * `anthropic-ratelimit-{requests,input-tokens,output-tokens}-{limit,remaining,reset}`
 * (https://platform.claude.com/docs/en/api/rate-limits, 2026-11-18). 리셋은 RFC 3339다. 세 값이 다 읽히는
 * 묶음만 싣고, 하나도 없으면 undefined다. `anthropic-ratelimit-tokens-*`(입력+출력 합산)는 쓰지 않는다.
 */
export function parseAnthropicRateLimit(headers: Headers, observedAt: number): ProviderRateLimit | undefined {
  const windows: Partial<Record<"requests" | "inputTokens" | "outputTokens", ProviderRateLimitWindow>> = {};
  for (const [group, key] of RATE_LIMIT_GROUPS) {
    const window = rateLimitWindow(headers, group);
    if (window !== undefined) windows[key] = window;
  }
  if (Object.keys(windows).length === 0) return undefined;
  return { observedAt, ...windows };
}

const CREDIT_BALANCE = /credit balance (?:is )?too low/i;
const SPEND_LIMIT_MESSAGE = /reached your (?:specified )?(?:workspace )?api usage limits/i;

/**
 * 거절 하나가 "차단"인지, 맞다면 어떤 사유인지 가린다. **상태 코드가 아니라 `error.type`·`message`·
 * `details.error_code`로** 판정한다 — 잔액 소진이 400으로도 402로도 보고되고(공식 오류 표에는 400이 "지출
 * 한도", 402가 "결제 정보 문제"), 같은 400이 모델 제약 위반이기도 하다. 그래서 모델 제약 400·인증 401·403은
 * 차단이 아니다.
 *
 * - 크레딧 소진: 메시지 "Credit balance is too low"(`billing_error`, 2026-11-18 Agent SDK/대화형 CLI 실측) 또는
 *   "Your credit balance is too low to access the Anthropic API"(HTTP 400 `invalid_request_error`, 비공식 보고),
 *   또는 `billing_error` 타입 → `balance_depleted`. 상태가 400·402·429 밖이면 `billing_error`의 의미인 402로 둔다.
 * - 지출 한도: 400 "You have reached your specified … API usage limits", 또는 429 + `details.error_code
 *   = "enforced_spend_limit_reached"` → `spend_limit`.
 * - 429 `rate_limit_error`(램프 한도 `ramp_limit_exceeded` 포함) → `rate_limited`.
 */
export function classifyAnthropicBlock(
  status: number,
  body: unknown,
): Omit<AnthropicBlockObservation, "model" | "at"> | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const type = typeof body.error.type === "string" ? body.error.type : undefined;
  const message = typeof body.error.message === "string" ? body.error.message : undefined;
  const details = isRecord(body.error.details) ? body.error.details : undefined;
  const detailCode = typeof details?.error_code === "string" ? details.error_code : undefined;
  const code = detailCode ?? type;
  const text = {
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
  };
  const knownStatus = (value: number): value is 400 | 402 | 429 => value === 400 || value === 402 || value === 429;
  if (type === "billing_error" || (message !== undefined && CREDIT_BALANCE.test(message))) {
    return { httpStatus: knownStatus(status) ? status : 402, reason: "balance_depleted", ...text };
  }
  if (detailCode === "enforced_spend_limit_reached" || (status === 400 && message !== undefined && SPEND_LIMIT_MESSAGE.test(message))) {
    return { httpStatus: status === 400 ? 400 : 429, reason: "spend_limit", ...text };
  }
  if (status === 429 && type === "rate_limit_error") {
    return { httpStatus: 429, reason: "rate_limited", ...text };
  }
  return undefined;
}

/** 스트림 중 `event: error`는 HTTP 상태가 200이라, 오류 타입이 상태 의미를 대신한다. */
const MIDSTREAM_STATUS: Readonly<Record<string, number>> = {
  billing_error: 402,
  rate_limit_error: 429,
  invalid_request_error: 400,
};

/**
 * 캐시 쓰기 토큰을 5분/1시간으로 가른다. `usage.cache_creation{ephemeral_5m_input_tokens,
 * ephemeral_1h_input_tokens}`가 오면 그것이 정답이다(문서: 비스트리밍 응답과 같은 모양이 `message_start`에 실린다고
 * 기대하지만 **스트림에서 오는지는 확인하지 못했다**). 합계(`cache_creation_input_tokens`)가 분해의 합보다 크거나
 * 분해가 없으면 남는 몫은 **요청이 1시간 TTL을 요구했는가**로 정한다 — 요청이 1시간 중단점을 하나라도 실었으면
 * 1시간, 아니면 5분. 1시간 쪽이 단가가 높아 지출을 부풀릴 수 있는 방향이지만, 크레딧이 모자라는 쪽의 오차보다
 * 안전하다(과소 집계가 더 해롭다).
 */
function splitCacheWrites(
  total: number,
  breakdown: Json | undefined,
  oneHourCache: boolean,
): { readonly write5m: number; readonly write1h: number } {
  const known5m = count(breakdown?.ephemeral_5m_input_tokens) ?? 0;
  const known1h = count(breakdown?.ephemeral_1h_input_tokens) ?? 0;
  const residual = Math.max(0, total - known5m - known1h);
  return oneHourCache
    ? { write5m: known5m, write1h: known1h + residual }
    : { write5m: known5m + residual, write1h: known1h };
}

interface UsageFacts {
  readonly start?: Json;
  readonly delta?: Json;
}

function pick(facts: UsageFacts, key: string): number | undefined {
  return count(facts.delta?.[key]) ?? count(facts.start?.[key]);
}

/** 스트림 두 usage(또는 비스트리밍 하나)에서 한 턴의 관측을 만든다. 출력 토큰이 없으면 undefined다. */
function buildUsageObservation(
  facts: UsageFacts,
  model: string,
  at: number,
  oneHourCache: boolean,
): AnthropicUsageObservation | undefined {
  // 출력은 `message_start`에서 자리표시값(1~3)이라 최종값만 쓴다. 최종 usage가 없으면 지출을 지어내지 않는다.
  const output = count(facts.delta?.output_tokens);
  if (output === undefined) return undefined;
  const cacheWriteTotal = pick(facts, "cache_creation_input_tokens") ?? 0;
  const breakdown = isRecord(facts.delta?.cache_creation)
    ? facts.delta.cache_creation
    : isRecord(facts.start?.cache_creation) ? facts.start.cache_creation : undefined;
  const { write5m, write1h } = splitCacheWrites(cacheWriteTotal, breakdown, oneHourCache);
  const tools = isRecord(facts.delta?.server_tool_use) ? facts.delta.server_tool_use
    : isRecord(facts.start?.server_tool_use) ? facts.start.server_tool_use : undefined;
  const geo = typeof facts.delta?.inference_geo === "string" ? facts.delta.inference_geo
    : typeof facts.start?.inference_geo === "string" ? facts.start.inference_geo : undefined;
  return {
    model,
    at,
    inputTokens: pick(facts, "input_tokens") ?? 0,
    outputTokens: output,
    cacheReadTokens: pick(facts, "cache_read_input_tokens") ?? 0,
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    webSearchRequests: count(tools?.web_search_requests) ?? 0,
    ...(geo !== undefined ? { inferenceGeo: geo } : {}),
  };
}

export function createAnthropicApiObserver(options: AnthropicObserverOptions): AnthropicPassthroughObserver {
  const model = options.model;
  const now = options.now ?? Date.now;
  const decoder = new TextDecoder();
  let status = 0;
  let isEventStream = false;
  let pending = "";
  let errorBody = "";
  let errorBytes = 0;
  let jsonBody = "";
  let jsonBytes = 0;
  let jsonOverflow = false;
  let start: Json | undefined;
  let delta: Json | undefined;
  let stopped = false;
  let streamBlocked = false;

  const safe = (action: () => void): void => {
    try {
      action();
    } catch {
      // 관찰은 응답을 바꾸는 이유가 되면 안 된다.
    }
  };

  const handleEvent = (event: unknown): void => {
    if (!isRecord(event)) return;
    if (event.type === "message_start" && isRecord(event.message) && isRecord(event.message.usage)) {
      start = event.message.usage;
    } else if (event.type === "message_delta" && isRecord(event.usage)) {
      // 누적값이다 — 합산하지 않고 마지막 것이 이긴다(문서). 이전에 없던 필드는 보존한다.
      delta = { ...delta, ...event.usage };
    } else if (event.type === "message_stop") {
      stopped = true;
    } else if (event.type === "error" && isRecord(event.error) && typeof event.error.type === "string") {
      const midstream = MIDSTREAM_STATUS[event.error.type];
      const block = midstream === undefined ? undefined : classifyAnthropicBlock(midstream, event);
      if (block !== undefined) {
        streamBlocked = true;
        options.port.observeBlock({ model, at: now(), ...block });
      }
    }
  };

  const consumeLines = (flush: boolean): void => {
    const lines = pending.split("\n");
    pending = flush ? "" : lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data.length === 0) continue;
      try {
        handleEvent(JSON.parse(data));
      } catch {
        // 알 수 없는 프레임은 무시한다. 응답은 이미 그대로 나갔다.
      }
    }
  };

  return {
    response(responseStatus, headers) {
      safe(() => {
        status = responseStatus;
        isEventStream = (headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
        const rateLimit = parseAnthropicRateLimit(headers, now());
        if (rateLimit !== undefined) options.port.observeRateLimit(rateLimit);
      });
    },

    chunk(chunk) {
      safe(() => {
        if (status < 200 || status >= 300) {
          if (errorBytes < MAX_ERROR_BODY_BYTES) {
            errorBytes += chunk.byteLength;
            errorBody += decoder.decode(chunk, { stream: true });
          }
          return;
        }
        if (isEventStream) {
          pending += decoder.decode(chunk, { stream: true });
          consumeLines(false);
          return;
        }
        if (jsonOverflow) return;
        jsonBytes += chunk.byteLength;
        if (jsonBytes > MAX_JSON_BODY_BYTES) {
          jsonOverflow = true;
          jsonBody = "";
          return;
        }
        jsonBody += decoder.decode(chunk, { stream: true });
      });
    },

    end() {
      safe(() => {
        if (status < 200 || status >= 300) {
          const block = classifyAnthropicBlock(status, JSON.parse(errorBody + decoder.decode()));
          if (block !== undefined) options.port.observeBlock({ model, at: now(), ...block });
          return;
        }
        if (isEventStream) {
          pending += decoder.decode();
          consumeLines(true);
          // 완결(`message_stop`)한 스트림만 지출로 센다. 도중 오류 이벤트로 끝난 턴은 세지 않는다.
          if (!stopped || streamBlocked) return;
          const observation = buildUsageObservation({ ...(start ? { start } : {}), ...(delta ? { delta } : {}) }, model, now(), options.oneHourCache);
          if (observation !== undefined) options.port.observeUsage(observation);
          return;
        }
        if (jsonOverflow) return;
        const message: unknown = JSON.parse(jsonBody + decoder.decode());
        if (!isRecord(message) || !isRecord(message.usage)) return;
        // 비스트리밍 응답은 usage가 한 벌이라 시작·최종이 같다.
        const observation = buildUsageObservation({ start: message.usage, delta: message.usage }, model, now(), options.oneHourCache);
        if (observation !== undefined) options.port.observeUsage(observation);
      });
    },
  };
}
