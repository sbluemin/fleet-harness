import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureWorkspaceDirectory, withDirectoryLock } from "@dotobokuri/core-infra";
import { createWikiWorkspaceResolver } from "@dotobokuri/fleet-wiki";
import { FLEET_WIKI_AGENT_TOOL_IDS, getWikiToolSpecs } from "../server/wiki-mcp.js";
import { describe, expect, it } from "vitest";

function createCodexWikiToolSpecs(fleetDataDir: string) {
  return getWikiToolSpecs(createWikiWorkspaceResolver({
    ensureWorkspace: (cwd) => ensureWorkspaceDirectory(fleetDataDir, cwd),
    withMigrationLock: (workspace, operation) => withDirectoryLock({ lockDir: path.join(workspace.path, "knowledge.migration.lock") }, operation),
  }));
}

const BODY = "A durable Terminal Wiki entry. ".repeat(12);

describe("Codex Wiki storage composition", () => {
  it("registers the unchanged catalog while a representative write resolves the Theater-root durable store", async () => {
    await withFixture(async ({ fleetDataDir, theaterRoot }) => {
      const sourceFile = path.join(theaterRoot, ".fleet", "knowledge", "legacy.md");
      const legacy = "legacy source remains immutable\n";
      await mkdir(path.dirname(sourceFile), { recursive: true });
      await writeFile(sourceFile, legacy);

      const specs = createCodexWikiToolSpecs(fleetDataDir);
      const bareSpecs = getWikiToolSpecs();
      expect(specs.map((spec) => spec.id)).toEqual(FLEET_WIKI_AGENT_TOOL_IDS);
      expect(specs.map((spec) => spec.parameters)).toEqual(bareSpecs.map((spec) => spec.parameters));

      await invoke(specs, "wiki_ingest", {
        id: "terminal-entry", title: "Terminal entry", body: BODY, tags: [], source: BODY,
      }, theaterRoot);

      const workspace = ensureWorkspaceDirectory(fleetDataDir, theaterRoot);
      const knowledge = path.join(workspace.path, "knowledge");
      expect(await readFile(sourceFile, "utf8")).toBe(legacy);
      expect(await readFile(path.join(knowledge, "legacy.md"), "utf8")).toBe(legacy);
      expect(await readdir(path.join(knowledge, "queue"))).toHaveLength(1);
    });
  });

  it("keeps an empty store available until a tool actually resolves it", async () => {
    await withFixture(async ({ fleetDataDir }) => {
      expect(createCodexWikiToolSpecs(fleetDataDir).map((spec) => spec.id)).toEqual(FLEET_WIKI_AGENT_TOOL_IDS);
      await expect(stat(fleetDataDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("treats an existing destination regular file as a migration no-op", async () => {
    await withFixture(async ({ fleetDataDir, theaterRoot }) => {
      const sourceFile = path.join(theaterRoot, ".fleet", "knowledge", "legacy.md");
      await mkdir(path.dirname(sourceFile), { recursive: true });
      await writeFile(sourceFile, "legacy must not merge\n");
      const workspace = ensureWorkspaceDirectory(fleetDataDir, theaterRoot);
      const blockingFile = path.join(workspace.path, "knowledge", "schema", "wiki-schema.md");
      await mkdir(path.dirname(blockingFile), { recursive: true });
      await writeFile(blockingFile, "destination wins\n");

      await invoke(createCodexWikiToolSpecs(fleetDataDir), "wiki_orient", {}, theaterRoot);

      expect(await readFile(blockingFile, "utf8")).toBe("destination wins\n");
      await expect(readFile(path.join(workspace.path, "knowledge", "legacy.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

async function invoke(specs: ReturnType<typeof createCodexWikiToolSpecs>, id: string, args: Record<string, unknown>, cwd: string): Promise<void> {
  const spec = specs.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`Missing ${id}`);
  const result = await spec.execute(args, { cwd });
  expect(result).toMatchObject({ isError: false });
}

async function withFixture(run: (fixture: { fleetDataDir: string; theaterRoot: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "terminal-agent-wiki-storage-"));
  try {
    const theaterRoot = path.join(root, "theater");
    await mkdir(theaterRoot);
    await run({ fleetDataDir: path.join(root, "fleet-data"), theaterRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
