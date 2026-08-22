import type { GatewayRequestPolicy } from "../gateway-router/router-policy.js";

/**
 * OpenCode Go receives Claude Code's own search tools.
 *
 * The policy is one per subscription, not one per wire: the Anthropic, Responses, and
 * Chat Completions models behind this provider all reach the same models with the same
 * client catalog, and the wire split below this point changes how a tool is encoded,
 * never whether the model should have been offered it.
 *
 * Anthropic's client identity and billing blocks go as well, on every one of those wires
 * — the leak is in what the client wrote, so which wire carries it changes nothing.
 */
export const opencodeGoRequestPolicy: GatewayRequestPolicy = {
  provider: "opencode",
  shapeRequest: (request, steps) =>
    steps.stripClientIdentity(steps.withholdWebSearchTools(steps.pruneSkillPayloads(request))),
};
