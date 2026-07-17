import { FLEET_WIKI_BOUNDARY_GUIDELINES } from "../boundaries.js";
import { briefingQuery } from "../briefing.js";
import { resolveToolMemoryPaths } from "../paths.js";
import {
  WIKI_BRIEFING_DESCRIPTION,
  WIKI_BRIEFING_GUIDELINES,
  WIKI_BRIEFING_PROMPT_SNIPPET,
  buildWikiBriefingSchema,
} from "../prompts.js";

export function buildBriefingToolConfig() {
  return {
    name: "wiki_briefing",
    label: "Wiki Briefing",
    description: WIKI_BRIEFING_DESCRIPTION,
    promptSnippet: WIKI_BRIEFING_PROMPT_SNIPPET,
    promptGuidelines: [...WIKI_BRIEFING_GUIDELINES],
    parameters: buildWikiBriefingSchema(),
    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string; paths?: import("../types.js").MemoryPaths },
    ) {
      const hits = await briefingQuery(resolveToolMemoryPaths(ctx), {
        topic: typeof params.topic === "string" ? params.topic : undefined,
        tags: Array.isArray(params.tags) ? params.tags.map(String) : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        enhanced: typeof params.enhanced === "boolean" ? params.enhanced : undefined,
      });
      const text = JSON.stringify({
        ok: true,
        trust_boundary: FLEET_WIKI_BOUNDARY_GUIDELINES,
        hits,
      }, null, 2).slice(0, 50_000);
      return {
        content: [{ type: "text" as const, text }],
        details: {},
      };
    },
  };
}
