/**
 * Native Anthropic passthrough 정책.
 *
 * Anthropic 원문 모델은 canonical 번역 없이 요청 본문과 응답 스트림을 그대로 중계한다.
 * 이 모듈이 그 경로의 엔드포인트와 헤더 정책을 소유하고, 런타임은 본문/응답 펌핑만 담당한다.
 */

import { ContextWindowExceededError } from "../../canonical/index.js";
import { linkAbortSignal, parseSseFrameFields, parseUpstreamSseStream, readBoundedBody } from "../../transport/upstream-sse.js";

/** Native Anthropic Messages 엔드포인트. */
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/**
 * Native Anthropic passthrough 요청 헤더.
 *
 * content-type과 anthropic-version을 고정(호출자가 보낸 버전이 있으면 보존)하고,
 * authorization/x-api-key/anthropic-beta/user-agent를 호출자 요청에서 그대로 전달한다.
 * 자격증명을 교체하지 않는다 — 청구 주체는 호출자로 남는다.
 */
export function anthropicNativeHeaders(
  requestHeaders: Readonly<Record<string, unknown>>,
  contextWindow?: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": typeof requestHeaders["anthropic-version"] === "string"
      ? requestHeaders["anthropic-version"]
      : "2023-06-01",
  };
  for (const name of ["authorization", "x-api-key", "anthropic-beta", "user-agent"]) {
    const value = requestHeaders[name];
    if (typeof value === "string") headers[name] = value;
  }
  if (contextWindow !== undefined && contextWindow >= 1_000_000) {
    const betas = new Set((headers["anthropic-beta"] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
    betas.add("context-1m-2025-08-07");
    headers["anthropic-beta"] = [...betas].join(",");
  }
  return headers;
}

/** 원문 중계에서도 입력 초과만 복구 가능한 413으로 올린다. 바이트 제한 413은 그대로다. */
export function withAnthropicContextOverflow(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const streaming = response.ok && response.headers.get("content-type")?.includes("text/event-stream") === true;
    if (response.status !== 400 && !streaming) return response;
    const controller = new AbortController();
    const unlink = linkAbortSignal(init?.signal ?? undefined, controller);
    if (streaming) {
      const events = parseUpstreamSseStream(response.body, {
        controller, idleTimeoutMs: 300_000, maxBodyBytes: 64 * 1024 * 1024,
        onClose: unlink, missingBodyMessage: "Anthropic streaming response had no body",
      }, (frame) => {
        const { data } = parseSseFrameFields(frame);
        let value: unknown;
        try { value = JSON.parse(data); } catch { /* 원문이 JSON이 아닌 SSE 주석도 보존한다. */ }
        refuseAnthropicContextOverflow(value);
        return new TextEncoder().encode(`${frame}\n\n`);
      });
      const iterator = events[Symbol.asyncIterator]();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(destination) {
          try {
            const next = await iterator.next();
            if (next.done) destination.close();
            else destination.enqueue(next.value);
          } catch (error) {
            destination.error(error);
          }
        },
        async cancel() {
          controller.abort(new DOMException("stream cancelled", "AbortError"));
          await iterator.return?.(undefined);
        },
      }), { status: response.status, headers: response.headers });
    }
    try {
      const body = await readBoundedBody(response.body, {
        controller,
        idleTimeoutMs: 300_000,
        maxBodyBytes: 64 * 1024 * 1024,
      });
      let value: unknown;
      try { value = JSON.parse(new TextDecoder().decode(body)); } catch { /* 원문 비JSON 오류는 보존한다. */ }
      refuseAnthropicContextOverflow(value);
      return new Response(Uint8Array.from(body), { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      unlink();
    }
  };
}

function refuseAnthropicContextOverflow(value: unknown): void {
  if (!value || typeof value !== "object" || !("error" in value)) return;
  const error = value.error;
  if (error && typeof error === "object" && "type" in error && "message" in error
    && error.type === "invalid_request_error" && typeof error.message === "string"
    && /^prompt is too long\b/i.test(error.message)) {
    const tokens = /^prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i.exec(error.message);
    throw new ContextWindowExceededError(tokens ? Number(tokens[1]) : undefined, tokens ? Number(tokens[2]) : undefined);
  }
}
