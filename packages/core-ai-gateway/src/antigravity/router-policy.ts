import type { GatewayRequestPolicy } from "../gateway-router/router-policy.js";

/**
 * Antigravity receives Claude Code's own search tools.
 *
 * Cloud Code Assist carries no file-search capability of its own, so a withheld
 * `Grep` would leave the model with the shell alone. Web Search stays withheld —
 * it is a client-side Anthropic helper, and a Gemini model cannot service a call
 * to it.
 *
 * Anthropic's client identity and billing blocks go as well: a Gemini model told it
 * is Claude Code answers as Claude and cites Claude model ids, and the billing line
 * is Anthropic telemetry Google was never meant to read.
 */
export const antigravityRequestPolicy: GatewayRequestPolicy = {
  provider: "antigravity",
  shapeRequest: (request, steps) =>
    steps.stripClientIdentity(steps.withholdWebSearchTools(steps.pruneSkillPayloads(request))),
};
