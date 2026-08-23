import { AnthropicMessagesGateway } from "../downstream/wire/anthropic-messages/inbound.js";
import type { AnthropicMessagesRequest } from "../downstream/wire/anthropic-messages/protocol.js";
import {
  createOpencodeGoAdapter,
  OPENCODE_GO_MESSAGES_URL,
  opencodeGoWire,
} from "../upstream/opencode-go/index.js";
import {
  opencodeAnthropicHeaders,
  opencodeRequestBody,
} from "../upstream/opencode-go/anthropic/index.js";
import type { GatewayModel, GatewayModelWire } from "../models.js";
import type { PassthroughRelay } from "./router.js";

import {
  proxyAnthropicMessages,
  type GatewayProxyResponse,
} from "./passthrough.js";

/**
 * 라우터가 OpenCode Go로 나가는 두 경로를 고르는 디스패치 글루.
 *
 * upstream 폴더가 아니라 여기 있다: 이 파일은 인바운드 번역기를 만들고 라우터의 패스스루를
 * 호출하므로, upstream/에 두면 공급자가 downstream과 router를 거꾸로 붙잡는다. 공급자가
 * 소유하는 것은 헤더·본문 정책(`upstream/opencode-go/`)이고, 어느 경로로 보낼지는 라우터가 정한다.
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
  fetchImpl?: typeof fetch,
): AnthropicMessagesGateway {
  // fetch를 넘기지 않으면 어댑터가 globalThis.fetch로 떨어져 라우터의 업스트림 게이트를 우회한다.
  return new AnthropicMessagesGateway(createOpencodeGoAdapter(
    wire,
    fetchImpl ? { fetch: fetchImpl } : {},
  ));
}

export async function proxyToOpencode(
  requestHeaders: Record<string, unknown>,
  res: GatewayProxyResponse,
  body: AnthropicMessagesRequest,
  model: string,
  contextWindow: number | undefined,
  projection: PassthroughRelay,
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
    ...projection,
    responseModel,
    keepAlive: true,
    fetchImpl,
    headers,
    signal,
    url: OPENCODE_GO_MESSAGES_URL,
    wireEventLabel: "opencode-go-anthropic.wire.event",
  });
}
