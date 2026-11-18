import type { GatewayRequestPolicy } from "../../router/request-policy.js";

/**
 * Anthropic API 키 모델은 요청을 **다듬지 않는다**.
 *
 * 이 공급자는 Claude Code의 `/v1/messages` 본문을 Anthropic 와이어 그대로 상류에 되돌려 보내는 passthrough라,
 * 다른 공급자가 지우는 것들이 여기서는 오히려 정확하다: 시스템 프롬프트의 클라이언트 정체·billing 블록은
 * Anthropic이 읽도록 만들어진 계측이고(진입점 `sdk-ts`가 그 안에 있다 — 크레딧 적용 판정이 그것에 기대므로
 * 고쳐 보내면 안 된다), Web Search 도구도 Anthropic이 서비스한다. 바꾸는 것은 라우터의 passthrough 분기가
 * 본문 `model`과 `speed`에 하는 두 가지뿐이다.
 */
export const anthropicRequestPolicy: GatewayRequestPolicy = {
  provider: "anthropic",
  shapeRequest: (request) => request,
};
