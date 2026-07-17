import { runDryDock } from "../drydock.js";
import { resolveToolMemoryPaths } from "../paths.js";
import {
  WIKI_DRYDOCK_DESCRIPTION,
  WIKI_DRYDOCK_GUIDELINES,
  WIKI_DRYDOCK_PROMPT_SNIPPET,
  buildWikiDryDockSchema,
} from "../prompts.js";

export function buildDryDockToolConfig() {
  return {
    name: "wiki_drydock",
    label: "Wiki Drydock",
    description: WIKI_DRYDOCK_DESCRIPTION,
    promptSnippet: WIKI_DRYDOCK_PROMPT_SNIPPET,
    promptGuidelines: [...WIKI_DRYDOCK_GUIDELINES],
    parameters: buildWikiDryDockSchema(),
    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string; paths?: import("../types.js").MemoryPaths },
    ) {
      const report = await runDryDock(resolveToolMemoryPaths(ctx), { fix: params.fix === true });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
        details: {},
      };
    },
  };
}
