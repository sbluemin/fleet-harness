import type { GatewayRequestPolicy } from "../../router/request-policy.js";

/**
 * Kimi is served over Anthropic's own wire and keeps the caller's catalog.
 *
 * Web Search is a Claude- and Kimi-owned capability, so unlike every other provider
 * this one is left to service the call itself. No tool is withheld here at all; the
 * skill pruning that remains is a window budget rather than a capability judgement.
 *
 * Anthropic's client identity and billing blocks still go. Sharing Anthropic's wire is
 * a transport fact and nothing more: it does not make Moonshot's model Claude Code, nor
 * entitle it to Anthropic's client telemetry.
 */
export const kimiRequestPolicy: GatewayRequestPolicy = {
  provider: "kimi",
  shapeRequest: (request, steps) => steps.stripClientIdentity(steps.pruneSkillPayloads(request)),
};
