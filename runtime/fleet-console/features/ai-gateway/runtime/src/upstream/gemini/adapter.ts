import { randomUUID } from "node:crypto";

import type {
  AdapterCallOptions,
  AdapterResponse,
  AiGatewayAdapter,
  CanonicalFunctionTool,
  CanonicalResponseRequest,
} from "../../canonical/index.js";
import type { GeminiUsagePort } from "../../quota/gemini-usage.js";
import {
  linkAbortSignal,
  parseSseFrameFields,
  parseUpstreamSseStream,
  positiveInteger,
  readBoundedBody,
  type FetchLike,
  type UpstreamReadOptions,
} from "../../transport/upstream-sse.js";
import { wireLog } from "../../transport/wire-log.js";
import { GEMINI_API_BASE_URL, isGeminiModelId } from "./coordinates.js";
import {
  geminiBlock,
  geminiError,
  isInvalidApiKeyError,
  isUnavailableError,
  parseGeminiFrame,
  translateGeminiStream,
  type GeminiFrame,
} from "./stream.js";
import {
  buildGeminiRequest,
  createGeminiSignatureLedger,
  createToolNameCodec,
  type GeminiSignatureLedger,
} from "./wire.js";

/** 모델 하나의 스트리밍 턴. `?alt=sse`가 RPC를 이벤트 스트림으로 바꾼다 — 없으면 같은 경로가 JSON 한 덩어리로 답한다. */
export function geminiStreamUrl(model: string): string {
  return `${GEMINI_API_BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

export const DEFAULT_GEMINI_MAX_UPSTREAM_BODY_BYTES = 64 * 1024 * 1024;

/**
 * 업스트림이 아무 바이트도 안 보내도 되는 최장 시간.
 *
 * 호출자가 견디는 시간에서 잡았다: Claude Code 자신의 바이트 스트림 idle 감시가 300초를 기다리므로
 * 이보다 짧으면 클라이언트가 더 기다려 줄 턴을 우리가 실패시킨다. 이 wire는 모델이 생각하는 동안
 * 조용하다 — 높은 effort 턴이 첫 보이는 바이트 전에 생각 토큰 542개를 썼다.
 */
export const DEFAULT_GEMINI_UPSTREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Flex 요청이 아무 바이트도 안 보내도 되는 최장 시간.
 *
 * 공식 flex-inference 문서(2026-11-18 확인): Flex는 best-effort이고 지연 목표가 1~15분이며 클라이언트
 * 타임아웃을 600초 이상으로 권장한다. 기본 300초 idle은 아직 큐에서 기다리는 정상 Flex 요청을 끊는다.
 * 그래서 Flex에는 문서의 최장 지연 목표인 15분을 준다. 호출자가 `idleTimeoutMs`를 직접 정했다면 그 값이
 * 우선한다. 클라이언트 쪽은 SSE keepalive가 idle 감시를 지켜 주지만, Claude Code 자신의 요청
 * 타임아웃(기본 600초)이 먼저 끊을 수 있다는 점은 실측되지 않았다.
 */
export const DEFAULT_GEMINI_FLEX_IDLE_TIMEOUT_MS = 900_000;

/**
 * Flex 요청의 응답 헤더(첫 응답)를 기다리는 한도. **지금은 한도가 없다**(`undefined`) — 값 하나만 넣으면 켜지는 자리다.
 *
 * 값이 있으면 Flex 요청의 HTTP 응답 헤더가 이 시간 안에 오지 않을 때 그 요청을 끊고 같은 요청을 한 번 Standard로 다시
 * 보낸다(503 대체와 같은 경로·같은 한 번). 배경: 2026-11-18 사령관 측정에서 Argon Flex가 476초를 기다린 뒤 503으로 끝났고,
 * 그러면 Standard 대체가 8분 늦게 시작된다. 이 한도는 헤더까지만 잰다 — 헤더가 온 뒤의 첫 프레임 대기에는 걸지 않으며, 하류로
 * 나간 프레임이 없을 때만 대체한다는 경계도 그대로다. 끊은 Flex 요청이 과금되는지는 **미확인**이다.
 */
export const GEMINI_FLEX_FIRST_RESPONSE_LIMIT_MS = undefined as number | undefined;

/**
 * 원장은 어댑터 인스턴스보다 오래 산다. 라우터가 요청마다 어댑터를 만들기 때문에, 인스턴스마다
 * 원장을 두면 도구 왕복 사이에 사라진다. 프로세스당 하나이고 크기가 묶여 있다.
 */
const sharedSignatureLedger = createGeminiSignatureLedger();

export interface GeminiAdapterOptions {
  readonly fetch?: FetchLike;
  readonly maxBodyBytes?: number;
  readonly idleTimeoutMs?: number;
  readonly signatureLedger?: GeminiSignatureLedger;
  /** 사용량·402/429 차단을 받는 지출 원장. 없으면 아무것도 보고하지 않는다. */
  readonly usage?: GeminiUsagePort;
}

/** 본문이 JSON이 아니면 `undefined`다. 오류 본문 해석은 전부 이 결과에서 시작한다. */
function parseErrorBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

/**
 * Google AI Studio Gemini API(`x-goog-api-key`) 위의 generateContent 어댑터.
 *
 * 요청은 Gemini 본문 그대로이고 모델은 URL이 정한다. 도구 이름 코덱·스키마 정화·thoughtSignature
 * 왕복은 `wire.ts`, 스트림 번역과 오류 의미는 `stream.ts`가 가진다.
 */
export class GeminiGenerateContentAdapter implements AiGatewayAdapter {
  readonly capabilities = {} as const;
  private readonly fetchImpl: FetchLike;
  private readonly maxBodyBytes: number;
  private readonly idleTimeoutMs: number;
  /** 호출자가 idle 한도를 직접 정했는가. 정했다면 Flex에도 그 값을 쓴다. */
  private readonly idleTimeoutPinned: boolean;
  private readonly ledger: GeminiSignatureLedger;
  private readonly usage: GeminiUsagePort | undefined;

  constructor(options: GeminiAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.maxBodyBytes = options.maxBodyBytes === undefined
      ? DEFAULT_GEMINI_MAX_UPSTREAM_BODY_BYTES
      : positiveInteger(options.maxBodyBytes, "maxBodyBytes");
    this.idleTimeoutMs = options.idleTimeoutMs === undefined
      ? DEFAULT_GEMINI_UPSTREAM_IDLE_TIMEOUT_MS
      : positiveInteger(options.idleTimeoutMs, "idleTimeoutMs");
    this.idleTimeoutPinned = options.idleTimeoutMs !== undefined;
    this.ledger = options.signatureLedger ?? sharedSignatureLedger;
    this.usage = options.usage;
  }

  async stream(
    request: CanonicalResponseRequest,
    options: AdapterCallOptions,
  ): Promise<AdapterResponse> {
    if (options.apiKey.length === 0) {
      throw new TypeError("apiKey must not be empty");
    }

    const controller = new AbortController();
    const unlink = linkAbortSignal(options.signal, controller);
    const codec = createToolNameCodec();
    const body = buildGeminiRequest(request, { codec, ledger: this.ledger });
    const url = geminiStreamUrl(request.model);
    // 페이로드 없는 카운터. `replayedSignatures`와 `replayableCalls`를 견주는 것이 이 wire가 가장
    // 세게 벌하는 실패를 보는 유일한 길이다 — blob 없이 재생한 `functionCall`은 하드 400이고, 이
    // 카운터가 없으면 로그에는 원인이 안 보이는 실패한 턴만 남는다. blob 자체는 기록하지 않는다.
    // 키는 헤더로만 가고 어디에도 기록되지 않는다.
    const replayable = body.contents.flatMap((content) =>
      content.role === "model" ? content.parts.filter((part) => part.functionCall !== undefined) : []);
    wireLog("gemini.wire.request", {
      url,
      model: request.model,
      serviceTier: body.serviceTier,
      contents: body.contents.length,
      replayableCalls: replayable.length,
      replayedSignatures: replayable.filter((part) => part.thoughtSignature !== undefined).length,
      tools: body.tools?.[0].functionDeclarations.length ?? 0,
      toolConfig: body.toolConfig,
      generationConfig: body.generationConfig,
    });

    const post = (payload: typeof body, signal: AbortSignal = controller.signal): Promise<Response> => this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-goog-api-key": options.apiKey,
      },
      body: JSON.stringify(payload),
      signal,
    });
    const readOptionsFor = (tier: string | undefined): UpstreamReadOptions => ({
      controller,
      idleTimeoutMs: tier === "flex" && !this.idleTimeoutPinned ? DEFAULT_GEMINI_FLEX_IDLE_TIMEOUT_MS : this.idleTimeoutMs,
      maxBodyBytes: this.maxBodyBytes,
    });

    // Flex 요청이 용량 때문에 503 UNAVAILABLE로 거절되면 같은 요청을 Standard로 한 번만 다시 보낸다(사람
    // 결정 c4b5ef9c: "기본 Flex 유지하고 503이면 Standard로"). Standard로 명시한 요청은 대체하지 않는다.
    // 대체 요청에는 대기를 넣지 않는다: 2026-11-18 사령관 측정에서 Flex 503은 1~8초 만에 왔고, 그것은 Flex
    // 용량 거절이지 Standard 풀의 일시 과부하가 아니다. 기다려도 Standard 쪽 사정은 달라지지 않는다.
    const standardBody = { ...body, serviceTier: "standard" as const };
    const fellBack = (via: "http" | "frame" | "timeout"): void => wireLog("gemini.wire.tier_fallback", { from: "flex", to: "standard", via });
    const canFallBack = body.serviceTier === "flex";

    // 첫 응답 한도(위 상수)가 있으면 Flex 시도만 따로 끊을 수 있게 시도 전용 abort를 둔다. 호출자 abort는 그대로 이어 주고
    // (연결은 응답 본문이 끝날 때까지 유지), 타이머는 헤더가 오는 순간 멈춘다. 시간 초과면 `undefined`를 돌려준다.
    const postFlexWithin = async (limitMs: number): Promise<Response | undefined> => {
      const attempt = new AbortController();
      controller.signal.addEventListener("abort", () => attempt.abort(controller.signal.reason), { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; attempt.abort(new Error(`Gemini Flex gave no response within ${limitMs}ms`)); }, limitMs);
      try {
        return await post(body, attempt.signal);
      } catch (error) {
        if (timedOut && !controller.signal.aborted) return undefined;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };

    let response: Response;
    let activeTier = body.serviceTier;
    try {
      const flexLimit = GEMINI_FLEX_FIRST_RESPONSE_LIMIT_MS;
      const first = canFallBack && flexLimit !== undefined ? await postFlexWithin(flexLimit) : await post(body);
      if (first === undefined) {
        fellBack("timeout");
        activeTier = "standard";
        response = await post(standardBody);
      } else {
        response = first;
      }
      if (canFallBack && activeTier === "flex" && response.status === 503) {
        // 읽지 않을 응답은 놓아 준다. 업스트림 게이트는 본문이 끝날 때까지 출처별 허가를 쥔다.
        await response.body?.cancel().catch(() => undefined);
        fellBack("http");
        activeTier = "standard";
        response = await post(standardBody);
      }
    } catch (error) {
      unlink();
      throw error;
    }
    const readOptions = readOptionsFor(activeTier);

    if (!response.ok) {
      try {
        const errorBody = await readBoundedBody(response.body, readOptions);
        const parsed = parseErrorBody(errorBody);
        if (response.status === 400) {
          // 입력 토큰 초과면 ContextWindowExceededError를 던져 Claude Code의 압축을 건다.
          geminiError(parsed);
          // 잘못된 키는 401이 아니라 `400 INVALID_ARGUMENT` + `details[].reason: API_KEY_INVALID`다
          // (2026-11-18 사령관 실측). 클라이언트에는 로그인 거절로 보여야 하므로 401로 올린다.
          if (isInvalidApiKeyError(parsed)) {
            const message = geminiError(parsed)?.message ?? "Gemini API key is not valid.";
            const rewritten = new TextEncoder().encode(JSON.stringify({
              type: "error",
              error: { type: "authentication_error", message },
            }));
            const headers = new Headers(response.headers);
            headers.set("content-type", "application/json");
            headers.delete("content-length");
            return { ok: false, status: 401, headers, body: rewritten };
          }
        }
        // 402·429만 원장에 알린다. 다른 상태 코드(503 포함)는 차단이 아니다.
        const block = geminiBlock(parsed, response.status);
        if (block && isGeminiModelId(request.model)) {
          try {
            this.usage?.observeBlock({ model: request.model, at: Date.now(), ...block });
          } catch {
            // 원장이 던져도 오류 응답은 그대로 간다.
          }
        }
        return { ok: false, status: response.status, headers: response.headers, body: errorBody };
      } finally {
        unlink();
      }
    }

    const framesOf = (source: Response, read: UpstreamReadOptions, onClose: () => void): AsyncGenerator<GeminiFrame> =>
      parseUpstreamSseStream(source.body, {
        ...read,
        onClose,
        missingBodyMessage: "Gemini response had no body",
      }, (frame) => parseGeminiFrame(parseSseFrameFields(frame).data));

    // 스트림이 200으로 시작한 뒤에도 503 오류 프레임이 올 수 있다. 그 프레임이 **첫 번째로 하류에 나갈
    // 것**이면(앞서 내보낸 프레임이 없으면) 하류는 아무것도 보지 못했으므로 같은 요청을 Standard로 다시 보낼
    // 수 있다. 이미 프레임을 내보낸 뒤의 503은 다시 보내지 않는다: 하류가 부분 텍스트·도구 호출·서명을 받았고,
    // 재요청은 그것을 중복하거나 어긋나게 하므로 지금처럼 오류로 끝낸다. 이 대체는 stream()을 막지 않는
    // 이벤트 제너레이터 안에서 한다 — Flex는 첫 바이트까지 수 분 걸릴 수 있어서, 여기서 첫 프레임을 기다리면
    // 그동안 하류 keepalive가 시작되지 못한다.
    let frames: AsyncGenerator<GeminiFrame>;
    if (activeTier === "flex") {
      frames = withStandardFallback(
        (onClose) => framesOf(response, readOptions, onClose),
        async () => {
          fellBack("frame");
          const retried = await post(standardBody);
          const read = readOptionsFor("standard");
          return retried.ok ? framesOf(retried, read, unlink) : errorFrames(retried, read, unlink);
        },
        unlink,
      );
    } else {
      frames = framesOf(response, readOptions, unlink);
    }

    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      events: translateGeminiStream(frames, {
        codec,
        ledger: this.ledger,
        model: request.model,
        callIdPrefix: randomUUID(),
        ...(this.usage === undefined ? {} : { usage: this.usage }),
      }),
    };
  }

  /** 선언한 도구는 모두 직렬화한다: 이 wire에는 지연 로딩 계약이 없어 사전 추정이 실제 전송량과 같다. */
  wireTools(request: CanonicalResponseRequest): readonly CanonicalFunctionTool[] {
    return request.tools ?? [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 비정상 응답 하나를 오류 프레임 하나로 바꾼다. 이미 이벤트 스트림 안에서 일어난 Standard 대체 요청이 HTTP
 * 오류로 끝났을 때, 그 사유(402·429면 차단 보고까지)를 스트림이 실을 수 있는 유일한 길이다.
 */
async function* errorFrames(response: Response, read: UpstreamReadOptions, onClose: () => void): AsyncGenerator<GeminiFrame> {
  try {
    const parsed = parseErrorBody(await readBoundedBody(response.body, read));
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
    yield { error: { error: { code: response.status, message: `Gemini request failed (HTTP ${response.status})`, ...error } } };
  } finally {
    onClose();
  }
}

/**
 * 첫 프레임이 503 오류인 Flex 스트림을 Standard 요청으로 갈아탄다.
 *
 * 경계는 "하류로 이미 나간 프레임이 있는가"다. 없으면 하류는 아무것도 보지 못했으므로 같은 요청을 다시
 * 보내도 중복·어긋남이 없다. 하나라도 나갔다면(부분 텍스트, 도구 호출, 서명) 재요청은 그것을 되풀이하거나
 * 어긋나게 하므로 대체하지 않고 오류가 그대로 간다. 첫 스트림의 정리는 갈아타는 순간 `unlink`를 건너뛴다 —
 * 같은 abort 연결을 대체 요청이 이어 쓰기 때문이다.
 */
async function* withStandardFallback(
  open: (onClose: () => void) => AsyncGenerator<GeminiFrame>,
  retry: () => Promise<AsyncGenerator<GeminiFrame>>,
  unlink: () => void,
): AsyncGenerator<GeminiFrame> {
  let retrying = false;
  let emitted = false;
  for await (const frame of open(() => { if (!retrying) unlink(); })) {
    if (!emitted && frame.error !== undefined && isUnavailableError(frame.error)) {
      retrying = true;
      break;
    }
    emitted = true;
    yield frame;
  }
  if (!retrying) return;
  let second: AsyncGenerator<GeminiFrame>;
  try {
    second = await retry();
  } catch (error) {
    unlink();
    throw error;
  }
  yield* second;
}

export function createGeminiAdapter(options: GeminiAdapterOptions = {}): GeminiGenerateContentAdapter {
  return new GeminiGenerateContentAdapter(options);
}
