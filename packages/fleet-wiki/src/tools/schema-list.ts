import { resolveToolMemoryPaths } from "../paths.js";
import { WIKI_SCHEMA_LIST_DESCRIPTION, buildWikiSchemaListSchema } from "../prompts.js";
import { readSchemaCatalog } from "../schema.js";

export function buildSchemaListToolConfig() {
  return {
    name: "wiki_schema_list",
    label: "Wiki Schema List",
    description: WIKI_SCHEMA_LIST_DESCRIPTION,
    promptSnippet: "List the workspace schema and available custom templates before selecting one to read.",
    promptGuidelines: ["Only logical schema refs are returned."],
    parameters: buildWikiSchemaListSchema(),
    async execute(_id: string, _params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string; paths?: import("../types.js").MemoryPaths }) {
      const catalog = await readSchemaCatalog(resolveToolMemoryPaths(ctx));
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, tool: "wiki_schema_list", ...catalog }, null, 2) }], details: {} };
    },
  };
}
