import { withSseKeepAlive } from "../transport/sse-keepalive.js";
import { logRawPassthroughBody } from "../transport/wire-log.js";
import type { AnthropicMessagesRequest } from "../downstream/wire/anthropic-messages/protocol.js";
import type { AnthropicPassthroughObserver } from "../upstream/anthropic/observe.js";

import { applyDecisiveRefusalHeaders, drain, type GatewayProxyResponse } from "./http.js";

export type { GatewayProxyResponse };

/**
 * Anthropic passthrough 공용 프리미티브.
 *
 * upstream wire가 downstream wire와 같은 공급자(네이티브 Anthropic)는 canonical 번역 없이 요청 본문과 응답 스트림을 그대로 중계한다.
 * 그 경로가 공유하는 전송·정규화 조각들이 여기 모여 있고, provider별 본문 성형(모델
 * 재작성·effort 정책)은 각 소유 모듈에 남는다.
 */
export interface AnthropicProxyOptions {
  /** Harness-owned status lift. Absent forwards the upstream status unchanged. */
  readonly retryableStatus?: (status: number) => number;
  /**
   * Harness-owned "do not retry" headers for a refusal. Absent leaves upstream
   * headers untouched, including on `429` and `5xx`.
   */
  readonly decisiveRefusalHeaders?: (status: number) => Readonly<Record<string, string>> | undefined;
  /** Provider가 Anthropic 이벤트를 내지 않는 동안에도 gateway alias의 downstream 생존성을 유지한다. */
  readonly keepAlive?: boolean;
  /** Raw response event label. Caller-owned so this shared proxy stays provider-neutral. */
  readonly wireEventLabel?: string;
  /** Client session the router read from the request; ties wire log entries to its transcript. */
  readonly wireSessionId?: string;
  /**
   * 응답을 바꾸지 않고 옆에서 읽는 관찰자(헤더·usage·거절). 상류 바이트는 그대로 나가고, 관찰자가 던져도
   * 응답은 영향받지 않는다(관찰자 쪽이 삼킨다). 본문을 끝까지 읽었을 때만 `end`가 불린다.
   */
  readonly observe?: AnthropicPassthroughObserver;
  readonly fetchImpl: typeof fetch;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly url: string;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export async function proxyAnthropicMessages(
  res: GatewayProxyResponse,
  body: AnthropicMessagesRequest,
  options: AnthropicProxyOptions,
): Promise<void> {
  const upstream = await options.fetchImpl(options.url, {
    method: "POST",
    headers: options.headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key)) responseHeaders[key] = value;
  });
  // Passthrough forwards the provider's own bytes, but a status the client refuses to retry
  // would strand a transient upstream failure that one attempt would have cleared.
  // Native Anthropic's 401 belongs to the caller's own credential and stays unchanged.
  const status = options.retryableStatus?.(upstream.status) ?? upstream.status;
  // 관찰자는 하네스가 바꾼 상태가 아니라 상류가 실제로 답한 상태를 본다 — 차단 분류가 그 값에 기댄다.
  options.observe?.response(upstream.status, upstream.headers);
  res.writeHead(status, applyDecisiveRefusalHeaders(status, responseHeaders, options.decisiveRefusalHeaders));
  if (!upstream.body) {
    res.end();
    return;
  }
  const rawBody = options.observe === undefined ? readResponseBody(upstream.body) : observeResponseBody(readResponseBody(upstream.body), options.observe);
  const contentType = upstream.headers.get("content-type");
  const upstreamRequestId = upstream.headers.get("request-id");
  // Observation tap: records provider response payloads while passing the upstream bytes
  // through unchanged. The label is caller-owned so this proxy stays neutral.
  const observedBody = options.wireEventLabel === undefined
    ? rawBody
    : logRawPassthroughBody(rawBody, {
        label: options.wireEventLabel,
        contentType,
        correlation: {
          ...(options.wireSessionId === undefined ? {} : { sessionId: options.wireSessionId }),
          // Anthropic 와이어의 요청 id. Claude Code transcript가 같은 값을 requestId로 남긴다.
          ...(upstreamRequestId === null ? {} : { requestId: upstreamRequestId }),
        },
      });
  const responseBody = options.keepAlive === true && contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream"
    ? withSseKeepAlive(observedBody)
    : observedBody;
  for await (const chunk of responseBody) {
    if (!res.write(chunk)) await drain(res, options.signal);
  }
  res.end();
}

/** 청크를 관찰자에게 보여 주되 그대로 흘린다. 끝까지 읽혔을 때만 `end`를 부른다(중단·오류는 부르지 않는다). */
async function* observeResponseBody(
  body: AsyncGenerator<Uint8Array>,
  observer: AnthropicPassthroughObserver,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of body) {
    observer.chunk(chunk);
    yield chunk;
  }
  observer.end();
}

async function* readResponseBody(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
