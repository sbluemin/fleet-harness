import type { AiGatewayAdapter } from "../../canonical/index.js";
import type { GatewayModel } from "../../models.js";
import type { FetchLike } from "../../transport/upstream-sse.js";
import { OpencodeGoChatCompletionsAdapter } from "./chat-completions/adapter.js";
import { OpencodeGoResponsesAdapter } from "./responses/adapter.js";

export interface OpencodeGoAdapterOptions {
  readonly fetch?: FetchLike;
}

/**
 * 카탈로그가 선언한 모델별 wire를 전송 수단으로 바꾼다.
 *
 * Go 플랜은 모델마다 네이티브 wire 하나로만 서빙한다(DeepSeek는 Chat Completions, Muse Spark는
 * Responses). Anthropic `/messages` 트랜스코더는 이 공급자의 범위가 아니다 — wire를 선언하지 않은
 * 항목은 Anthropic으로 떨어지지 않고 여기서 거절된다.
 */
export function createOpencodeGoAdapter(
  model: Pick<GatewayModel, "id" | "wire">,
  options: OpencodeGoAdapterOptions = {},
): AiGatewayAdapter {
  const transport = options.fetch ? { fetch: options.fetch } : {};
  if (model.wire === "responses") return new OpencodeGoResponsesAdapter(transport);
  if (model.wire === "chat-completions") return new OpencodeGoChatCompletionsAdapter(transport);
  throw new Error(`OpenCode Go model declares no supported wire: ${model.id}`);
}
