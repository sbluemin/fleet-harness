import type { AiGatewayAdapter } from "../../canonical/index.js";
import type { GatewayModel, GatewayModelWire } from "../../models.js";
import { OpencodeGoChatCompletionsAdapter } from "./chat-completions/adapter.js";
import { OpencodeGoResponsesAdapter } from "./responses/adapter.js";
import type { FetchLike } from "../../transport/upstream-sse.js";

export * from "./anthropic/index.js";
export * from "./responses/index.js";
export * from "./chat-completions/index.js";

/**
 * OpenCode Go 구독 접속 좌표와 wire 라우팅.
 *
 * Go 플랜 API는 `/zen/go/` 네임스페이스 아래에 세 wire를 나란히 노출한다. Anthropic
 * 호환 `/messages`는 서버측 트랜스코더가 붙는 경로라 네이티브가 Anthropic인 모델에만
 * 신뢰할 수 있고(트랜스코딩되는 모델은 스트림 프레이밍이 깨지는 것을 2026-08-03
 * 실측), 나머지 모델은 각자의 네이티브 wire로 직접 접속해야 한다. 모델별 wire는
 * 레지스트리(models.json)가 선언하고, 이 모듈이 그 선언을 전송 수단으로 바꾼다.
 */

// Keep the persisted provider id stable so stored keys survive upgrades.
export const OPENCODE_AUTH_PROVIDER_ID = "Claude Code with OpenCode Go";
export const OPENCODE_GO_API_BASE_URL = "https://opencode.ai/zen/go";
// Current Anthropic-protocol Go model; key validation issues one 1-token request against it.
export const OPENCODE_GO_MODEL = "minimax-m3";

export const OPENCODE_GO_MESSAGES_URL = `${OPENCODE_GO_API_BASE_URL}/v1/messages`;
// OPENCODE_GO_RESPONSES_URL / OPENCODE_GO_CHAT_COMPLETIONS_URL는 각 wire 어댑터
// 소유이며, 위의 export * 로 이 배럴을 통해 재수출된다.

/** The wire a registry entry actually reaches; the registry omits `wire` for Anthropic natives. */
export function opencodeGoWire(model: Pick<GatewayModel, "wire">): GatewayModelWire {
  return model.wire ?? "anthropic";
}

export interface OpencodeGoAdapterOptions {
  fetch?: FetchLike;
}

/**
 * Build the translated-path adapter for a non-Anthropic OpenCode Go model.
 * Anthropic-wire models never come through here — they take the passthrough
 * proxy, which preserves native thinking blocks without a canonical round-trip.
 */
export function createOpencodeGoAdapter(
  wire: Exclude<GatewayModelWire, "anthropic">,
  options: OpencodeGoAdapterOptions = {},
): AiGatewayAdapter {
  if (wire === "responses") {
    // OpenCode Go 소유 Responses 어댑터: 기본 url이 OPENCODE_GO_RESPONSES_URL이라
    // 명시 없이도 Go 네임스페이스로 향한다.
    return new OpencodeGoResponsesAdapter({
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  // OpenCode Go 소유 chat-completions 어댑터: url이 고정된다.
  return new OpencodeGoChatCompletionsAdapter({
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
