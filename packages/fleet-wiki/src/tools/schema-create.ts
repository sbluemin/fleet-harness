import { resolveToolMemoryPaths } from "../paths.js";
import { WIKI_SCHEMA_CREATE_DESCRIPTION, buildWikiSchemaCreateSchema } from "../prompts.js";
import { createSchemaTemplate } from "../schema.js";

export function buildSchemaCreateToolConfig() {
  return {
    name: "wiki_schema_create",
    label: "Wiki Schema Create",
    description: WIKI_SCHEMA_CREATE_DESCRIPTION,
    promptSnippet: "Create one new custom workspace Wiki template. Existing templates cannot be updated or overwritten.",
    promptGuidelines: ["Create only; update, delete, and overwrite are unsupported."],
    parameters: buildWikiSchemaCreateSchema(),
    async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string; paths?: import("../types.js").MemoryPaths }) {
      const templateId = typeof params.template_id === "string" ? params.template_id.trim() : "";
      const markdown = typeof params.markdown === "string" ? params.markdown : "";
      const document = await createSchemaTemplate(resolveToolMemoryPaths(ctx), templateId, markdown);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, tool: "wiki_schema_create", ref: document.ref }, null, 2) }],
        details: { ref: document.ref },
      };
    },
  };
}
