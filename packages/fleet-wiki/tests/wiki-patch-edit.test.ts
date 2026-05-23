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
  it("edits a pending patch body in place without adding a queue item", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildPatchEditToolConfig();
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/alpha.md"\nsummary: "Alpha"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"alpha","title":"Alpha","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"first line\\nwrong line\\nlast line"}`);
    const patchId = await enqueuePatch(patch, paths);

    const result = await tool.execute("tool-call", {
      patch_id: patchId,
      body_replace: { find: "wrong line", replace: "right line" },
      touch_updated: false,
    }, undefined, undefined, { cwd: root } as any);
    const payload = JSON.parse(result.content[0]!.text) as { patch_id: string; changed_fields: string[] };
    const queued = await showQueue(patchId, paths);
    const entry = JSON.parse(queued.patch.body) as { body: string; updated: string };

    expect(payload.patch_id).toBe(patchId);
    expect((await listQueue(paths)).map((item) => item.id)).toEqual([patchId]);
    expect(entry.body).toContain("right line");
    expect(entry.updated).toBe("2026-04-26T00:00:00.000Z");
    expect(queued.meta.editCount).toBe(1);
    await expect(parseLog(paths)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "patch edited" }),
    ]));
    expect(await pathExists(path.join(paths.queueDir, patchId))).toBe(true);
  });

  it("rejects empty patch_id instead of auto-selecting a pending patch", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildPatchEditToolConfig();
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/solo.md"\nsummary: "Solo"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"solo","title":"Solo","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"body text"}`);
    const patchId = await enqueuePatch(patch, paths);

    await expect(tool.execute("tool-call", {
      patch_id: "",
      body_replace: { find: "body", replace: "changed" },
    }, undefined, undefined, { cwd: root } as any)).rejects.toThrow(/canonical queue ID/);

    expect((await listQueue(paths)).map((item) => item.id)).toEqual([patchId]);
    expect(await pathExists(path.join(paths.queueDir, "patch.md"))).toBe(false);
  });

  it("rejects summary frontmatter injection without changing op or target", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildPatchEditToolConfig();
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/inject.md"\nsummary: "Inject"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"inject","title":"Inject","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"body text"}`);
    const patchId = await enqueuePatch(patch, paths);
    const before = await readPatchFile(path.join(paths.queueDir, patchId, "patch.md"));

    await expect(tool.execute("tool-call", {
      patch_id: patchId,
      summary: "safe\nop: \"update_wiki\"\ntarget: \"wiki/alpha.md\"",
    }, undefined, undefined, { cwd: root } as any)).rejects.toThrow(/single-line frontmatter text/);
    await expect(tool.execute("tool-call", {
      patch_id: patchId,
      summary: "safe --- unsafe",
    }, undefined, undefined, { cwd: root } as any)).rejects.toThrow(/single-line frontmatter text/);

    expect(await readPatchFile(path.join(paths.queueDir, patchId, "patch.md"))).toBe(before);
    const queued = await showQueue(patchId, paths);
    expect(queued.patch.frontmatter.op).toBe("create_wiki");
    expect(queued.patch.frontmatter.target).toBe("wiki/inject.md");
  });

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

  it("reports summary-only edits in changed_fields and rejects stale frontmatter hashes", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildPatchEditToolConfig();
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/summary.md"\nsummary: "Before"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"summary","title":"Summary","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"body text"}`);
    const patchId = await enqueuePatch(patch, paths);
    const beforeHash = await readQueuedPatchHash(paths, patchId);

    const result = await tool.execute("tool-call", {
      patch_id: patchId,
      base_patch_hash: beforeHash,
      summary: "After",
    }, undefined, undefined, { cwd: root } as any);
    const payload = JSON.parse(result.content[0]!.text) as {
      previous_patch_hash: string;
      patch_hash: string;
      changed_fields: string[];
    };
    const queued = await showQueue(patchId, paths);
    const entry = JSON.parse(queued.patch.body) as { updated: string };

    expect(payload.previous_patch_hash).toBe(beforeHash);
    expect(payload.patch_hash).toBe(await readQueuedPatchHash(paths, patchId));
    expect(payload.patch_hash).not.toBe(beforeHash);
    expect(payload.changed_fields).toEqual(["summary"]);
    expect(queued.patch.frontmatter.summary).toBe("After");
    expect(entry.updated).toBe("2026-04-26T00:00:00.000Z");

    await expect(tool.execute("tool-call", {
      patch_id: patchId,
      base_patch_hash: beforeHash,
      title: "Stale",
    }, undefined, undefined, { cwd: root } as any)).rejects.toThrow(/stale base_patch_hash/);
  });

  it("rejects stale interleaved rewrites when another edit changes the same patch", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildPatchEditToolConfig();
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/race.md"\nsummary: "Race"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"race","title":"Race","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"body text"}`);
    const patchId = await enqueuePatch(patch, paths);
    const stale = await showQueue(patchId, paths);
    const staleHash = await readQueuedPatchHash(paths, patchId);

    await tool.execute("tool-call", {
      patch_id: patchId,
      base_patch_hash: staleHash,
      summary: "Edit B",
    }, undefined, undefined, { cwd: root } as any);

    await expect(rewriteQueuedPatch(patchId, paths, {
      frontmatter: {
        ...stale.patch.frontmatter,
        summary: "Edit A",
      },
      body: stale.patch.body,
    }, {
      ...stale.meta,
      editedAt: "2026-04-26T00:00:01.000Z",
      editCount: (stale.meta.editCount ?? 0) + 1,
      lastEditedBy: "test",
      previousPatchHash: staleHash,
    }, staleHash)).rejects.toThrow(/stale base_patch_hash/);

    expect((await showQueue(patchId, paths)).patch.frontmatter.summary).toBe("Edit B");
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

  it("keeps applied wiki and archived patch consistent during concurrent edit and approve", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildPatchEditToolConfig();
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/approve-race.md"\nsummary: "Approve Race"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"approve-race","title":"Old","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"old body"}`);
    const patchId = await enqueuePatch(patch, paths);
    const baseHash = await readQueuedPatchHash(paths, patchId);

    const results = await Promise.allSettled([
      tool.execute("tool-call-edit", {
        patch_id: patchId,
        base_patch_hash: baseHash,
        title: "Edited",
        touch_updated: false,
      }, undefined, undefined, { cwd: root } as any),
      approvePatch(patchId, paths),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    const wikiEntry = await readWikiEntry("approve-race", paths);
    const archivedPatch = await parsePatch(await readPatchFile(path.join(paths.archiveDir, patchId, "patch.md")));
    const archivedEntry = JSON.parse(archivedPatch.body) as { title: string; body: string };

    expect(results[1]!.status).toBe("fulfilled");
    expect(fulfilled.length + rejected.length).toBe(2);
    if (rejected.length > 0) {
      expect(String(rejected[0]!.reason)).toMatch(/stale base_patch_hash|ENOENT|no such file/i);
    }
    expect(wikiEntry?.title).toBe(archivedEntry.title);
    expect(wikiEntry?.body).toBe(archivedEntry.body);
  });

  it("rejects malformed patch bodies and long summaries without writing", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildPatchEditToolConfig();
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/bad.md"\nsummary: "Bad"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\nnot-json`);
    const patchId = await enqueuePatch(patch, paths);
    const before = await readPatchFile(path.join(paths.queueDir, patchId, "patch.md"));

    await expect(tool.execute("tool-call", { patch_id: patchId, title: "New" }, undefined, undefined, { cwd: root } as any))
      .rejects.toThrow(/JSON WikiEntry/);
    await expect(tool.execute("tool-call", {
      patch_id: patchId,
      summary: "x".repeat(121),
    }, undefined, undefined, { cwd: root } as any)).rejects.toThrow(/summary exceeds 120/);
    expect(await readPatchFile(path.join(paths.queueDir, patchId, "patch.md"))).toBe(before);
  });

  it("updates entry updated by default and tracks hashes in meta", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildPatchEditToolConfig();
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/touch.md"\nsummary: "Touch"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"touch","title":"Touch","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"body text"}`);
    const patchId = await enqueuePatch(patch, paths);
    const beforeHash = await readQueuedPatchHash(paths, patchId);

    const result = await tool.execute("tool-call", {
      patch_id: patchId,
      title: "Touched",
    }, undefined, undefined, { cwd: root } as any);
    const payload = JSON.parse(result.content[0]!.text) as { patch_hash: string };
    const queued = await showQueue(patchId, paths);
    const meta = await readJsonFile<PatchMeta>(path.join(paths.queueDir, patchId, "meta.json"));
    const entry = JSON.parse(queued.patch.body) as { title: string; updated: string };

    expect(entry.title).toBe("Touched");
    expect(entry.updated).not.toBe("2026-04-26T00:00:00.000Z");
    expect(meta.previousPatchHash).toBe(beforeHash);
    expect(meta.lastEditHash).toBe(payload.patch_hash);
    expect(meta.lastEditHash).toBe(await readQueuedPatchHash(paths, patchId));
  });

  it("registers wiki_patch_edit as a fleet wiki agent tool id", () => {
    expect(FLEET_WIKI_AGENT_TOOL_IDS).toContain("wiki_patch_edit");
    expect(getWikiToolSpecs().map((spec) => spec.id)).toEqual([
      ...FLEET_WIKI_AGENT_TOOL_IDS,
    ]);
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
