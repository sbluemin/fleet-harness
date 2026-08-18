import type { GatewayRequestPolicy } from "../gateway-router/router-policy.js";

/**
 * Codex works through the shell.
 *
 * `Grep`/`Glob` are withheld and the client's shell-first directive is forwarded
 * intact — the two are one decision. Withholding the tools while dropping the
 * directive would leave the model with no search route it was told about, and keeping
 * the directive while advertising the tools hands it a catalog it is instructed to
 * ignore. Whichever half moves, the other moves with it.
 */
export const codexRequestPolicy: GatewayRequestPolicy = {
  provider: "codex",
  shapeRequest: (request, steps) => {
    const pruned = steps.pruneSkillPayloads(request);
    const withheldWebSearch = steps.withholdWebSearchTools(pruned);
    return steps.withholdSearchTools(withheldWebSearch);
  },
};
