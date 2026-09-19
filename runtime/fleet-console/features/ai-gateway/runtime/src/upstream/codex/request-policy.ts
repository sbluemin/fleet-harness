import type { GatewayRequestPolicy } from "../../router/request-policy.js";

/**
 * Codex receives Claude Code's own search tools.
 *
 * Web Search stays withheld — that one is Claude- and Kimi-owned, and no Codex model
 * can service a call to it.
 *
 * Anthropic's client identity and billing blocks go as well: a GPT model is not Claude
 * Code, and the billing line is Anthropic telemetry OpenAI has no claim on.
 */
export const codexRequestPolicy: GatewayRequestPolicy = {
  provider: "codex",
  shapeRequest: (request, steps) =>
    steps.stripClientIdentity(steps.withholdWebSearchTools(steps.pruneSkillPayloads(request))),
};
