import type { GatewayRequestPolicy } from "../gateway-router/router-policy.js";

/**
 * Codex works through the shell.
 *
 * `Grep`/`Glob` are withheld, so its models search with `Bash` as they did before the
 * caller began advertising the two tools. This is a routing choice rather than a
 * measured provider limitation — nothing observed says Codex handles them badly — and
 * what it buys is the roughly 4KB of tool schema those two definitions add to every
 * request on a subscription whose weekly window runs hot.
 */
export const codexRequestPolicy: GatewayRequestPolicy = {
  provider: "codex",
  shapeRequest: (request, steps) => steps.withholdSearchTools(
    steps.withholdWebSearchTools(steps.pruneSkillPayloads(request)),
  ),
};
