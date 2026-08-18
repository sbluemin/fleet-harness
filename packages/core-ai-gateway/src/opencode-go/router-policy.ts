import type { GatewayRequestPolicy } from "../gateway-router/router-policy.js";

/**
 * OpenCode Go receives Claude Code's own search tools.
 *
 * The policy is one per subscription, not one per wire: the Anthropic, Responses, and
 * Chat Completions models behind this provider all reach the same models with the same
 * client catalog, and the wire split below this point changes how a tool is encoded,
 * never whether the model should have been offered it.
 */
export const opencodeGoRequestPolicy: GatewayRequestPolicy = {
  provider: "opencode",
  shapeRequest: (request, steps) => {
    const pruned = steps.pruneSkillPayloads(request);
    const withheld = steps.withholdWebSearchTools(pruned);
    return steps.stripShellFirstDirective(withheld);
  },
};
