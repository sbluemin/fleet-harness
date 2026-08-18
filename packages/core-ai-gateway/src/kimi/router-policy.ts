import type { GatewayRequestPolicy } from "../gateway-router/router-policy.js";

/**
 * Kimi is served over Anthropic's own wire and keeps the caller's catalog.
 *
 * Web Search is a Claude- and Kimi-owned capability, so unlike every other provider
 * this one is left to service the call itself. Only the skill pruning applies, and
 * that one is a window budget rather than a capability judgement.
 */
export const kimiRequestPolicy: GatewayRequestPolicy = {
  provider: "kimi",
  shapeRequest: (request, steps) => steps.pruneSkillPayloads(request),
};
