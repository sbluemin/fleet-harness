import type { GatewayRequestPolicy } from "../gateway-router/router-policy.js";

/**
 * Cursor receives Claude Code's own search tools.
 *
 * Its models carry a native grep of their own, and the adapter still translates one
 * into the caller's `Grep` when it arrives — but that translation is lossy by
 * construction: it fail-closes on the output modes, limits, and multiline flags the
 * native shape cannot express. Advertising `Grep`/`Glob` gives the model the full
 * schema directly and leaves the redirect as the fallback for a native call it makes
 * anyway, so the two paths cover each other instead of competing.
 *
 * Web Search stays withheld — that one is Claude- and Kimi-owned, and no Cursor model
 * can service a call to it.
 */
export const cursorRequestPolicy: GatewayRequestPolicy = {
  provider: "cursor",
  shapeRequest: (request, steps) => steps.withholdWebSearchTools(steps.pruneSkillPayloads(request)),
};
