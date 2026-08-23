import { eagerAnthropicRequestBody } from "../downstream/wire/anthropic-messages/passthrough.js";
import { withSseKeepAlive } from "../transport/sse-keepalive.js";
import { logRawPassthroughBody } from "../transport/wire-log.js";
import type { AnthropicMessagesRequest } from "../downstream/wire/anthropic-messages/protocol.js";
import type { PassthroughBodyProjection } from "../downstream/harness/contract.js";

import { drain, type GatewayProxyResponse } from "./http.js";

// 도구 eager 정규화는 core-ai-gateway 소유로 이전됐다. 기존 런타임 소비자(ai-gateway-routes)를
// 위해 이 모듈의 이름으로 재수출한다.
export { eagerAnthropicRequestBody };
export type { GatewayProxyResponse };

/**
 * Anthropic passthrough 공용 프리미티브.
 *
 * upstream wire가 downstream wire와 같은 공급자(Kimi, OpenCode Go의 Anthropic 모델,
 * 네이티브 Anthropic)는 canonical 번역 없이 요청 본문과 응답 스트림을 그대로 중계한다.
 * 그 경로가 공유하는 전송·정규화 조각들이 여기 모여 있고, provider별 본문 성형(모델
 * 재작성·effort 정책)은 각 소유 모듈에 남는다.
 */
export interface AnthropicProxyOptions {
  readonly contextWindow?: number;
  /**
   * Harness-owned rewrite of the relayed body. Absent relays the provider's bytes
   * unchanged — which is also what a client that reads the provider's real window wants.
   */
  readonly projectResponseBody?: PassthroughBodyProjection;
  /** Harness-owned status lift. Absent forwards the upstream status unchanged. */
  readonly retryableStatus?: (status: number) => number;
  /**
   * 클라이언트가 요청한 모델 id. 지정하면 upstream이 에코한 wire id를 이 값으로
   * 되돌려 본다 — Claude Code가 자기 요청 모델과 응답 모델을 대조할 수 있게 한다.
   */
  readonly responseModel?: string;
  /** Provider가 Anthropic 이벤트를 내지 않는 동안에도 gateway alias의 downstream 생존성을 유지한다. */
  readonly keepAlive?: boolean;
  /** Raw response event label. Caller-owned so this shared proxy stays provider-neutral. */
  readonly wireEventLabel?: string;
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
  res.writeHead(options.retryableStatus?.(upstream.status) ?? upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  const rawBody = readResponseBody(upstream.body);
  const contentType = upstream.headers.get("content-type");
  // Observation tap: records provider response payloads before projection while passing the
  // upstream bytes through unchanged. The label is caller-owned so this proxy stays neutral.
  const observedBody = options.wireEventLabel === undefined
    ? rawBody
    : logRawPassthroughBody(rawBody, {
        label: options.wireEventLabel,
        contentType,
      });
  // contextWindow이 없어도 responseModel이 있으면 재작성이 필요하므로 변환기를 탄다.
  const projectedBody = options.projectResponseBody === undefined
    || (options.contextWindow === undefined && options.responseModel === undefined)
    ? observedBody
    : options.projectResponseBody(observedBody, {
        contentType,
        ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
        ...(options.responseModel === undefined ? {} : { responseModel: options.responseModel }),
      });
  const responseBody = options.keepAlive === true && contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream"
    ? withSseKeepAlive(projectedBody)
    : projectedBody;
  for await (const chunk of responseBody) {
    if (!res.write(chunk)) await drain(res);
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
