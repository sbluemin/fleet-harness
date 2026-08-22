import type { GatewayRequestPolicy } from "../gateway-router/router-policy.js";

/**
 * Grok receives Claude Code's own search tools.
 *
 * The wire carries no file-search capability of its own, so a withheld `Grep` would
 * leave the model with the shell alone. Web Search stays withheld — a Grok model
 * cannot service a call to Claude's client-side helper.
 *
 * Anthropic's client identity and billing blocks go as well: a Grok model is not Claude
 * Code, and the billing line is Anthropic telemetry xAI has no claim on.
 */
export const xaiRequestPolicy: GatewayRequestPolicy = {
  provider: "xai",
  shapeRequest: (request, steps) =>
    steps.stripClientIdentity(steps.withholdWebSearchTools(steps.pruneSkillPayloads(request))),
};
