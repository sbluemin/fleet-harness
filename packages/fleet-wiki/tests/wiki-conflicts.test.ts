import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createConflict, listConflicts, readConflict, resolveConflict } from "../src/conflicts.js";
import { approvePatch, showQueue } from "../src/patch.js";
import { resolveMemoryPaths } from "../src/paths.js";
import { buildIngestToolConfig } from "../src/tools/ingest.js";
import { buildPatchQueueToolConfig } from "../src/tools/patch-queue.js";
import { computeContentHash, pathExists, readPatchFile, writeWikiEntry } from "../src/store.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("wiki conflicts", () => {

  it("records base_version and base_hash mismatches as conflicts under queue_conflict", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry(baseEntry("alpha"), paths);
    const currentMarkdown = await readPatchFile(path.join(paths.wikiDir, "alpha.md"));

    const versionConflict = await runIngest(root, {
      id: "alpha",
      title: "Alpha",
      body: longBody("version mismatch"),
      tags: [],
      source: "version source",
      mode: "update",
      base_version: 99,
      duplicate_policy: "queue_conflict",
    });
    const hashConflict = await runIngest(root, {
      id: "alpha",
      title: "Alpha",
      body: longBody("hash mismatch"),
      tags: [],
      source: "hash source",
      mode: "update",
      base_hash: "deadbeef",
      duplicate_policy: "queue_conflict",
    });

    expect((await readConflict(versionConflict.conflict_id!, paths)).meta.reason).toBe("base_version_mismatch");
    expect((await readConflict(hashConflict.conflict_id!, paths)).meta.reason).toBe("base_hash_mismatch");
    expect((await readConflict(hashConflict.conflict_id!, paths)).meta.currentHash).toBe(computeContentHash(currentMarkdown));
  });

  it("detects duplicate titles with reject and queue_conflict flows", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry(baseEntry("alpha"), paths);
    await writeWikiEntry(baseEntry("beta", { title: "Beta" }), paths);

    await expect(runIngest(root, {
      id: "gamma",
      title: "Beta",
      body: longBody("gamma"),
      tags: [],
      source: "gamma source",
      mode: "create",
    })).rejects.toThrow(/duplicate title/);

    const conflictResult = await runIngest(root, {
      id: "gamma",
      title: "Beta",
      body: longBody("gamma"),
      tags: [],
      source: "gamma source",
      mode: "create",
      duplicate_policy: "queue_conflict",
    });

    expect((await readConflict(conflictResult.conflict_id!, paths)).meta.reason).toBe("duplicate_title");
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-conflicts-"));
  cleanupPaths.push(root);
  return root;
}

async function runIngest(root: string, params: Record<string, unknown>) {
  const tool = buildIngestToolConfig();
  const result = await tool.execute("test", params, undefined, undefined, { cwd: root });
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

async function runPatchQueue(tool: ReturnType<typeof buildPatchQueueToolConfig>, root: string, params: Record<string, unknown>) {
  const result = await tool.execute("test", params, undefined, undefined, { cwd: root });
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

function baseEntry(id: string, overrides?: Partial<{ title: string }>) {
  return {
    id,
    title: overrides?.title ?? "Alpha",
    tags: [],
    created: "2026-05-05T00:00:00.000Z",
    updated: "2026-05-05T00:00:00.000Z",
    version: 1,
    body: longBody(`${id} body`),
  };
}

function longBody(seed: string): string {
  return `This is a sufficiently long wiki body for ${seed}. `.repeat(6).trim();
}

async function listDirectoryNamesSafe(targetDir: string): Promise<string[]> {
  try {
    return await readdir(targetDir);
  } catch {
    return [];
  }
}
