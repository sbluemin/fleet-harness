import { withSseKeepAlive } from "../transport/sse-keepalive.js";
import { logRawPassthroughBody } from "../transport/wire-log.js";
import type { AnthropicMessagesRequest } from "../downstream/wire/anthropic-messages/protocol.js";

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
  res.writeHead(status, applyDecisiveRefusalHeaders(status, responseHeaders, options.decisiveRefusalHeaders));
  if (!upstream.body) {
    res.end();
    return;
  }
  const rawBody = readResponseBody(upstream.body);
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
