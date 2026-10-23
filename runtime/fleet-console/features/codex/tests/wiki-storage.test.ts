import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createWikiWorkspaceResolver } from "../host/wiki/index.js";
import { FLEET_WIKI_AGENT_TOOL_IDS, getWikiToolSpecs } from "../host/wiki-mcp.js";
import { describe, expect, it } from "vitest";

const COMMODORE = "6f1d0c2e-2b4a-4c1e-9a7d-0e5b3c2a1f00";

function createCodexWikiToolSpecs(dataDir: string) {
  return getWikiToolSpecs(createWikiWorkspaceResolver({
    knowledge: {
      root: (id) => (id === COMMODORE ? path.join(dataDir, "commodore", id, "knowledge") : null),
      ids: () => [COMMODORE],
      legacyKnowledgeSources: () => [],
    },
  }));
}

const BODY = "A durable Terminal Wiki entry. ".repeat(12);

describe("Codex Wiki storage composition", () => {
  it("registers the direct-write catalog and writes only to the knowledge root of the host-bound commodore", async () => {
    await withFixture(async ({ dataDir }) => {
      await mkdir(path.join(dataDir, "commodore", COMMODORE), { recursive: true });
      const specs = createCodexWikiToolSpecs(dataDir);
      const bareSpecs = getWikiToolSpecs();
      expect(specs.map((spec) => spec.id)).toEqual(FLEET_WIKI_AGENT_TOOL_IDS);
      expect(specs.map((spec) => spec.parameters)).toEqual(bareSpecs.map((spec) => spec.parameters));

      expect(await invoke(specs, "wiki_ingest", {
        id: "terminal-entry", title: "Terminal entry", body: BODY, tags: [], source: BODY,
      }, COMMODORE)).toMatchObject({ isError: false });
      const knowledge = path.join(dataDir, "commodore", COMMODORE, "knowledge");
      expect(await readFile(path.join(knowledge, "wiki", "terminal-entry.md"), "utf8")).toContain(BODY.trim());

      // 사령관이 실리지 않았거나 호스트가 모르는 사령관이면 어느 위키에도 닿지 않는다.
      for (const commodoreId of [undefined, "00000000-0000-4000-8000-000000000000"]) {
        expect(await invoke(specs, "wiki_orient", {}, commodoreId)).toEqual({ content: [{ type: "text", text: JSON.stringify({ error: "knowledge_unavailable" }) }], isError: true });
      }
    });
  });

  it("keeps an empty store available until a tool actually resolves it", async () => {
    await withFixture(async ({ dataDir }) => {
      expect(createCodexWikiToolSpecs(dataDir).map((spec) => spec.id)).toEqual(FLEET_WIKI_AGENT_TOOL_IDS);
      await expect(stat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

async function invoke(specs: ReturnType<typeof createCodexWikiToolSpecs>, id: string, args: Record<string, unknown>, commodoreId: string | undefined): Promise<unknown> {
  const spec = specs.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`Missing ${id}`);
  return spec.execute(args, { cwd: "/ignored", ...(commodoreId ? { commodoreId } : {}) });
}

async function withFixture(run: (fixture: { dataDir: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "terminal-agent-wiki-storage-"));
  try {
    await run({ dataDir: path.join(root, "console") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
