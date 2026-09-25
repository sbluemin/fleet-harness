import type { GatewayRequestPolicy } from "../../router/request-policy.js";

/**
 * Muse Code는 Claude Code의 검색 도구를 그대로 받는다.
 *
 * Web Search는 Claude 소유 도구라 Muse 모델이 처리할 수 없으므로 뺀다. Anthropic 클라이언트
 * 신원·과금 블록도 뺀다 — Muse 모델은 Claude Code가 아니고 그 텔레메트리는 Meta와 무관하다.
 */
export const museCodeRequestPolicy: GatewayRequestPolicy = {
  provider: "muse-code",
  shapeRequest: (request, steps) =>
    steps.stripClientIdentity(steps.withholdWebSearchTools(steps.pruneSkillPayloads(request))),
};
