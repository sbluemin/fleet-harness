import { projectAnthropicResponseUsage } from "@dotobokuri/core-ai-gateway";
import type {
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicToolDefinition,
} from "@dotobokuri/core-ai-gateway";

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
  const responseBody = options.contextWindow === undefined && options.responseModel === undefined
    ? rawBody
    : projectAnthropicResponseUsage(rawBody, {
        contentType: upstream.headers.get("content-type"),
        contextWindow: options.contextWindow,
        responseModel: options.responseModel,
      });
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

/**
 * Anthropic 호환 passthrough upstream은 Fleet의 지연 로딩 도구 확장을 모른다.
 * 도구는 eager로 펼치고 tool_reference 결과 블록은 텍스트로 강등한다.
 */
export function eagerAnthropicRequestBody(
  body: AnthropicMessagesRequest,
  model: string,
): AnthropicMessagesRequest {
  return {
    ...body,
    model,
    messages: body.messages.map(eagerAnthropicMessage),
    ...(body.tools === undefined ? {} : { tools: body.tools.map(eagerAnthropicTool) }),
  };
}

function eagerAnthropicTool(tool: AnthropicToolDefinition): AnthropicToolDefinition {
  if (!("input_schema" in tool)) return tool;
  const { defer_loading: _deferLoading, ...eagerTool } = tool;
  return eagerTool;
}

function eagerAnthropicMessage(message: AnthropicMessage): AnthropicMessage {
  if (typeof message.content === "string") return message;
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) return block;
      return {
        ...block,
        content: block.content.map((result) => {
          if (result.type !== "tool_reference") return result;
          const toolName = typeof result.tool_name === "string" && result.tool_name.length > 0
            ? result.tool_name
            : "(invalid reference)";
          return { type: "text" as const, text: `Tool available: ${toolName}` };
        }),
      };
    }),
  };
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
