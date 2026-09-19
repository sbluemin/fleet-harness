import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FLEET_WIKI_AGENT_TOOL_IDS, getWikiToolSpecs } from "../server/wiki-mcp.js";
import * as publicApi from "../server/wiki/index.js";
import { createMemoryPaths } from "../server/wiki/index.js";
import { buildBriefingToolConfig } from "../server/wiki/index.js";
import { buildCompileSourceToolConfig } from "../server/wiki/index.js";
import { buildDryDockToolConfig } from "../server/wiki/index.js";
import { buildIngestToolConfig } from "../server/wiki/index.js";
import { buildOrientToolConfig } from "../server/wiki/index.js";
import { buildPatchEditToolConfig } from "../server/wiki/index.js";
import { buildPatchQueueToolConfig } from "../server/wiki/index.js";
import { buildQueryToolConfig } from "../server/wiki/index.js";
import { buildReadToolConfig } from "../server/wiki/index.js";
import { buildResolveToolConfig } from "../server/wiki/index.js";
import { buildSchemaCreateToolConfig } from "../server/wiki/index.js";
import { buildSchemaListToolConfig } from "../server/wiki/index.js";
import { buildSchemaReadToolConfig } from "../server/wiki/index.js";
import { createWikiDraftToolSpecs } from "../server/codex/cowork/draft-tools.js";

const BODY = "A durable test entry. ".repeat(12);

describe("Wiki agent specs", () => {
  it("exports only the production resolver factory through the package root", () => {
    expect(publicApi.createWikiWorkspaceResolver).toBeTypeOf("function");
    expect("createWikiWorkspaceResolverForTest" in publicApi).toBe(false);
  });

  it("keeps session-scoped Cowork draft tools out of every global Wiki surface", () => {
    const draftIds = createWikiDraftToolSpecs({
      draft: {
        read: async () => ({ body: "draft", revision: 0 }),
        write: async ({ body }) => ({ body, revision: 1 }),
      },
    }).map((spec) => spec.id);

    expect(draftIds).toEqual(["wiki_draft_read", "wiki_draft_edit", "wiki_draft_write"]);
    expect(FLEET_WIKI_AGENT_TOOL_IDS).not.toEqual(expect.arrayContaining(draftIds));
    expect(getWikiToolSpecs().map((spec) => spec.id)).not.toEqual(expect.arrayContaining(draftIds));
  });

  it("preserves every schema and resolves once before each domain tool", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-agent-specs-"));
    const paths = createMemoryPaths(path.join(root, "knowledge"));
    const expectedParameters = [
      buildBriefingToolConfig(), buildDryDockToolConfig(), buildIngestToolConfig(), buildOrientToolConfig(),
      buildPatchEditToolConfig(), buildPatchQueueToolConfig(), buildCompileSourceToolConfig(), buildQueryToolConfig(),
      buildReadToolConfig(), buildResolveToolConfig(), buildSchemaListToolConfig(), buildSchemaReadToolConfig(), buildSchemaCreateToolConfig(),
    ].map((config) => config.parameters);
    let calls = 0;
    const specs = getWikiToolSpecs({ resolve: () => { calls += 1; return paths; } });
    expect(specs.map((spec) => spec.id)).toEqual(FLEET_WIKI_AGENT_TOOL_IDS);
    expect(specs.map((spec) => spec.parameters)).toEqual(expectedParameters);
    const context = { cwd: "/theater", signal: undefined } as never;
    const invoke = async (id: string, args: Record<string, unknown>) => {
      const before = calls;
      const result = await specs.find((spec) => spec.id === id)!.execute(args, context);
      expect(calls).toBe(before + 1);
      expect(isTextToolResult(result)).toBe(true);
      if (!isTextToolResult(result)) throw new Error(`${id} returned an invalid tool result`);
      expect(result.isError).toBe(false);
      return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    };
    try {
      await invoke("wiki_briefing", {});
      await invoke("wiki_drydock", {});
      const ingest = await invoke("wiki_ingest", { id: "entry", title: "Entry", body: BODY, tags: [], source: BODY });
      await invoke("wiki_orient", {});
      await invoke("wiki_patch_edit", { patch_id: ingest.patch_id, title: "Edited" });
      await invoke("wiki_patch_queue", { action: "list" });
      await invoke("wiki_compile_source", { source: BODY, mode: "preview" });
      await invoke("wiki_query", { question: "What is entry?" });
      await invoke("wiki_read", { ids: ["entry"] });
      await invoke("wiki_resolve", { query: "entry" });
      await invoke("wiki_schema_list", {});
      await invoke("wiki_schema_read", {});
      await invoke("wiki_schema_create", { template_id: "incident", markdown: "---\ntemplate_id: incident\n---\n## Summary\n" });
      expect(calls).toBe(FLEET_WIKI_AGENT_TOOL_IDS.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function isTextToolResult(value: unknown): value is {
  isError: boolean;
  content: Array<{ type: "text"; text: string }>;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.isError === "boolean"
    && Array.isArray(record.content)
    && record.content.length > 0
    && record.content.every((item) => typeof item === "object" && item !== null
      && (item as Record<string, unknown>).type === "text"
      && typeof (item as Record<string, unknown>).text === "string");
}
