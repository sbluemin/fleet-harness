import {
  eagerAnthropicRequestBody,
  projectAnthropicResponseUsage,
  withSseKeepAlive,
} from "@dotobokuri/core-ai-gateway";
import type { AnthropicMessagesRequest } from "@dotobokuri/core-ai-gateway";

// 도구 eager 정규화는 core-ai-gateway 소유로 이전됐다. 기존 런타임 소비자(ai-gateway-routes)를
// 위해 이 모듈의 이름으로 재수출한다.
export { eagerAnthropicRequestBody };

/**
 * Anthropic passthrough 공용 프리미티브.
 *
 * Kimi와 OpenCode Go의 Anthropic-wire 모델은 canonical 번역 없이 요청 본문과 응답
 * 스트림을 그대로 중계한다. 그 경로가 공유하는 전송·정규화 조각들이 여기 모여 있고,
 * provider별 본문 성형(모델 재작성·effort 정책)은 각 소유 모듈에 남는다.
 */

export interface GatewayProxyResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: Uint8Array): boolean;
  end(body?: string): unknown;
  once(event: "drain", listener: () => void): unknown;
  readonly headersSent: boolean;
}

export interface AnthropicProxyOptions {
  readonly contextWindow?: number;
  /**
   * 클라이언트가 요청한 모델 id. 지정하면 upstream이 에코한 wire id를 이 값으로
   * 되돌려 본다 — Claude Code가 자기 요청 모델과 응답 모델을 대조할 수 있게 한다.
   */
  readonly responseModel?: string;
  /** Provider가 Anthropic 이벤트를 내지 않는 동안에도 gateway alias의 downstream 생존성을 유지한다. */
  readonly keepAlive?: boolean;
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
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  const rawBody = readResponseBody(upstream.body);
  // contextWindow이 없어도 responseModel이 있으면 재작성이 필요하므로 변환기를 탄다.
  const contentType = upstream.headers.get("content-type");
  const projectedBody = options.contextWindow === undefined && options.responseModel === undefined
    ? rawBody
    : projectAnthropicResponseUsage(rawBody, {
        contentType,
        contextWindow: options.contextWindow,
        responseModel: options.responseModel,
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

export async function drain(res: { once(event: "drain", listener: () => void): unknown }): Promise<void> {
  await new Promise<void>((resolve) => res.once("drain", resolve));
}

export function writeAnthropicError(
  res: {
    writeHead(status: number, headers: Record<string, string>): unknown;
    end(body: string): unknown;
  },
  status: number,
  type: string,
  message: string,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

/**
 * 헤더 전송 후의 유일한 통지 수단. 메시지에 따옴표/개행이 있어도 안전하도록 JSON.stringify로만 만든다.
 *
 * 선행 `\n\n`은 생략할 수 없다. passthrough 경로는 상류 네트워크 청크를 그대로 흘리므로
 * 마지막 청크가 프레임 중간에서 끊길 수 있고, 그 뒤에 곧바로 이어 붙이면 잘린 data 줄에
 * 융합되어 클라이언트 JSON 파싱이 깨진다. 이미 경계에 있을 때 덧붙는 빈 줄은 무해하다.
 */
export function writeSseErrorFrame(
  res: { write(chunk: string): boolean },
  type: string,
  message: string,
): void {
  try {
    const data = JSON.stringify({ type: "error", error: { type, message } });
    res.write(`\n\nevent: error\ndata: ${data}\n\n`);
  } catch {
    // 프레임 작성 자체가 실패해도 응답 종료는 막지 않는다.
  }
}

function findCauseCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth <= 4; depth += 1) {
    if (current === null || typeof current !== "object") return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (Object.prototype.hasOwnProperty.call(current, "code")) {
      const code = (current as Record<string, unknown>).code;
      if (typeof code === "string") return code;
    }
    current = (current as Record<string, unknown>).cause;
  }
  return undefined;
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // fetch 거절은 message가 "fetch failed"뿐이라 원인 code(cause chain)를 함께 남긴다(issue #531).
  const code = findCauseCode(error);
  return code !== undefined && !message.includes(code) ? `${message} (${code})` : message;
}
