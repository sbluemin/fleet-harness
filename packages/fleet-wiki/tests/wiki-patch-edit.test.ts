import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FLEET_WIKI_AGENT_TOOL_IDS, getWikiToolSpecs } from "../src/agent-specs.js";
import { parseLog } from "../src/log.js";
import { approvePatch, enqueuePatch, listQueue, parsePatch, rewriteQueuedPatch, showQueue } from "../src/patch.js";
import { resolveMemoryPaths } from "../src/paths.js";
import { computeContentHash, pathExists, readJsonFile, readPatchFile, readWikiEntry } from "../src/store.js";
import { buildPatchEditToolConfig } from "../src/tools/patch-edit.js";
import type { PatchMeta } from "../src/types.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("wiki patch edit", () => {

  it("rejects base_patch_hash mismatch without writing", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildPatchEditToolConfig();
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/hash.md"\nsummary: "Hash"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"hash","title":"Hash","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"body text"}`);
    const patchId = await enqueuePatch(patch, paths);
    const before = await readPatchFile(path.join(paths.queueDir, patchId, "patch.md"));

    await expect(tool.execute("tool-call", {
      patch_id: patchId,
      base_patch_hash: "deadbeef",
      body_replace: { find: "body", replace: "changed" },
    }, undefined, undefined, { cwd: root } as any)).rejects.toThrow(/stale base_patch_hash/);

    expect(await readPatchFile(path.join(paths.queueDir, patchId, "patch.md"))).toBe(before);
  });

  it("allows only one concurrent edit with the same base_patch_hash", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildPatchEditToolConfig();
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/concurrent.md"\nsummary: "Concurrent"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"concurrent","title":"Concurrent","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"body text"}`);
    const patchId = await enqueuePatch(patch, paths);
    const baseHash = await readQueuedPatchHash(paths, patchId);

    const results = await Promise.allSettled([
      tool.execute("tool-call-a", {
        patch_id: patchId,
        base_patch_hash: baseHash,
        summary: "Edit A",
      }, undefined, undefined, { cwd: root } as any),
      tool.execute("tool-call-b", {
        patch_id: patchId,
        base_patch_hash: baseHash,
        summary: "Edit B",
      }, undefined, undefined, { cwd: root } as any),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    const finalSummary = (await showQueue(patchId, paths)).patch.frontmatter.summary;

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(Error);
    expect(String(rejected[0]!.reason.message)).toContain("stale base_patch_hash");
    expect(["Edit A", "Edit B"]).toContain(finalSummary);
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-patch-edit-"));
  cleanupPaths.push(root);
  return root;
}

async function readQueuedPatchHash(paths: ReturnType<typeof resolveMemoryPaths>, patchId: string): Promise<string> {
  return computeContentHash(await readPatchFile(path.join(paths.queueDir, patchId, "patch.md")));
}
