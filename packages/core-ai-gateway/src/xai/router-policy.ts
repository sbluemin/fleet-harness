import type { GatewayRequestPolicy } from "../gateway-router/router-policy.js";

/**
 * Grok receives Claude Code's own search tools.
 *
 * The wire carries no file-search capability of its own, so a withheld `Grep` would
 * leave the model with the shell alone. Web Search stays withheld — a Grok model
 * cannot service a call to Claude's client-side helper.
 */
export const xaiRequestPolicy: GatewayRequestPolicy = {
  provider: "xai",
  shapeRequest: (request, steps) => steps.withholdWebSearchTools(steps.pruneSkillPayloads(request)),
};
