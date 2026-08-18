import type { GatewayRequestPolicy } from "../gateway-router/router-policy.js";

/**
 * Codex receives Claude Code's own search tools.
 *
 * Web Search stays withheld — that one is Claude- and Kimi-owned, and no Codex model
 * can service a call to it.
 */
export const codexRequestPolicy: GatewayRequestPolicy = {
  provider: "codex",
  shapeRequest: (request, steps) => steps.withholdWebSearchTools(steps.pruneSkillPayloads(request)),
};
