import { AnthropicMessagesGateway } from "../anthropic/gateway.js";
import type { AnthropicMessagesRequest } from "../anthropic/protocol.js";
import {
  createOpencodeGoAdapter,
  OPENCODE_GO_MESSAGES_URL,
  opencodeGoWire,
} from "../opencode-go/index.js";
import {
  opencodeAnthropicHeaders,
  opencodeRequestBody,
} from "../opencode-go/anthropic/index.js";
import type { GatewayModel, GatewayModelWire } from "../models.js";

import {
  proxyAnthropicMessages,
  type GatewayProxyResponse,
} from "./proxy.js";

/**
 * OpenCode Go provider의 서버측 소유 모듈.
 *
 * 레지스트리가 선언한 모델별 wire에 따라 두 경로로 갈라진다:
 * - `anthropic` — 네이티브 Anthropic 모델. canonical 번역 없이 `/zen/go/v1/messages`로
 *   passthrough한다(서버측 트랜스코더는 이 모델들에서만 신뢰 가능).
 * - `responses`/`chat-completions` — 네이티브 OpenAI 계열 모델. 기존 번역 경로에
 *   해당 wire의 어댑터를 끼워 canonical로 오간다. Anthropic `/messages` 트랜스코더는
 *   이 모델들에서 스트림 프레이밍이 깨지므로(2026-08-03 실측) 쓰지 않는다.
 */

export { OPENCODE_GO_MESSAGES_URL, opencodeGoWire };

export function isOpencodeAnthropicPassthrough(model: Pick<GatewayModel, "wire">): boolean {
  return opencodeGoWire(model) === "anthropic";
}

/** 번역 경로용 게이트웨이. 요청마다 생성해도 되는 무상태 어댑터를 감싼다. */
export function createOpencodeGateway(
  wire: Exclude<GatewayModelWire, "anthropic">,
): AnthropicMessagesGateway {
  return new AnthropicMessagesGateway(createOpencodeGoAdapter(wire));
}

export async function proxyToOpencode(
  requestHeaders: Record<string, unknown>,
  res: GatewayProxyResponse,
  body: AnthropicMessagesRequest,
  model: string,
  contextWindow: number | undefined,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<void> {
  // 헤더·본문 정책은 core-ai-gateway가 소유한다. 여기는 요청을 실어 보낼 뿐이다.
  const headers = opencodeAnthropicHeaders(requestHeaders, apiKey);
  // 클라이언트 요청 model은 provider wire id로 재작성되기 전 원본을 에코용으로 남긴다.
  const responseModel = typeof body.model === "string" ? body.model : undefined;
  await proxyAnthropicMessages(res, opencodeRequestBody(body, model), {
    contextWindow,
    responseModel,
    keepAlive: true,
    fetchImpl,
    headers,
    signal,
    url: OPENCODE_GO_MESSAGES_URL,
    wireEventLabel: "opencode-go-anthropic.wire.event",
  });
}
