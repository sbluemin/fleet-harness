import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { listConflicts, readConflict } from "../src/conflicts.js";
import { buildPatchSetId, writePatchSet } from "../src/patch.js";
import { approvePatch, approvePatchSet, enqueuePatch, listQueue, parsePatch, rejectPatch, resolveQueueSelection, showQueue, validatePatch } from "../src/patch.js";
import { resolveMemoryPaths } from "../src/paths.js";
import { computeContentHash, pathExists, readJsonFile, readPatchFile, writeWikiEntry } from "../src/store.js";
import { buildPatchQueueToolConfig } from "../src/tools/patch-queue.js";
import type { PatchMeta } from "../src/types.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("wiki patch queue", () => {

  it("rejects traversal targets", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const traversal = await parsePatch(`---\nop: "create_wiki"\ntarget: "../../../etc/passwd"\nsummary: "Bad"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{}`);

    await expect(validatePatch(traversal, paths)).rejects.toThrow(/escapes wiki root/);
  });

  it("normalizes legacy inline raw_source_ref into provenance metadata on approve", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/legacy.md"\nsummary: "Legacy"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"legacy","title":"Legacy","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"human readable body\\n\\nraw_source_ref: raw/2026-04-26-legacy-source.md"}`);

    const patchId = await enqueuePatch(patch, paths);
    await approvePatch(patchId, paths);
    const stored = await readPatchFile(path.join(paths.wikiDir, "legacy.md"));

    expect(stored).toContain('rawSourceRef: "raw/2026-04-26-legacy-source.md"');
    expect(stored).not.toContain("raw_source_ref:");
    expect(stored).toContain("human readable body");
  });

  it("reports partial patch set approval when members are missing", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const queueTool = buildPatchQueueToolConfig();
    const createdAt = "2026-04-26T00:00:00.000Z";
    const patchSetId = buildPatchSetId(createdAt, "raw/2026-04-26-source-a1b2c3d4.md");
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/alpha.md"\nsummary: "Alpha"\nproposer: "test"\ncreated: "${createdAt}"\n---\n{"id":"alpha","title":"Alpha","tags":[],"created":"${createdAt}","updated":"${createdAt}","version":1,"body":"alpha body"}`);
    const patchId = await enqueuePatch(patch, paths, { patch_set_id: patchSetId });
    await writePatchSet(paths, {
      id: patchSetId,
      sourceRef: "raw/2026-04-26-source-a1b2c3d4.md",
      createdAt,
      patchIds: [patchId, "missing-patch-id"],
    });

    const result = await queueTool.execute("tool-call", {
      action: "approve_set",
      patch_set_id: patchSetId,
    }, undefined, undefined, { cwd: root } as any);
    const payload = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      status: string;
      missing: string[];
      accepted: Array<{ id: string }>;
    };

    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("partial");
    expect(payload.missing).toEqual(["missing-patch-id"]);
    expect(payload.accepted).toHaveLength(1);
    expect(await pathExists(path.join(paths.archiveDir, patchId))).toBe(true);
    expect(await readPatchFile(path.join(paths.root, "log.md"))).toContain("— patch set partially approved");
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-patch-"));
  cleanupPaths.push(root);
  return root;
}
