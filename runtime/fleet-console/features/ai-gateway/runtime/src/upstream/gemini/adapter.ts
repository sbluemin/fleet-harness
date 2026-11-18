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
  parseGeminiFrame,
  translateGeminiStream,
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
      contents: body.contents.length,
      replayableCalls: replayable.length,
      replayedSignatures: replayable.filter((part) => part.thoughtSignature !== undefined).length,
      tools: body.tools?.[0].functionDeclarations.length ?? 0,
      toolConfig: body.toolConfig,
      generationConfig: body.generationConfig,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-goog-api-key": options.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      unlink();
      throw error;
    }

    const readOptions: UpstreamReadOptions = {
      controller,
      idleTimeoutMs: this.idleTimeoutMs,
      maxBodyBytes: this.maxBodyBytes,
    };

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
        // 402·429만 원장에 알린다. 다른 상태 코드는 차단이 아니다.
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

    const frames = parseUpstreamSseStream(response.body, {
      ...readOptions,
      onClose: unlink,
      missingBodyMessage: "Gemini response had no body",
    }, (frame) => parseGeminiFrame(parseSseFrameFields(frame).data));

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

export function createGeminiAdapter(options: GeminiAdapterOptions = {}): GeminiGenerateContentAdapter {
  return new GeminiGenerateContentAdapter(options);
}
