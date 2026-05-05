import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { listConflicts, readConflict } from "../src/conflicts.js";
import { buildPatchSetId, writePatchSet } from "../src/patch-set.js";
import { approvePatch, approvePatchSet, enqueuePatch, parsePatch, rejectPatch, resolveQueueSelection, showQueue, validatePatch } from "../src/patch.js";
import { resolveMemoryPaths } from "../src/paths.js";
import { pathExists, readJsonFile, readPatchFile, writeWikiEntry } from "../src/store.js";
import { buildPatchQueueToolConfig } from "../src/tools/patch-queue.js";
import type { PatchMeta } from "../src/types.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("wiki patch queue", () => {
  it("supports enqueue, show, approve, and archive", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/alpha.md"\nsummary: "Alpha"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"alpha","title":"Alpha","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"hello"}`);

    const patchId = await enqueuePatch(patch, paths);
    const queued = await showQueue(patchId, paths);
    const meta = await approvePatch(patchId, paths);

    expect(queued.patch.frontmatter.op).toBe("create_wiki");
    expect(meta.status).toBe("accepted");
    expect(await pathExists(path.join(paths.archiveDir, patchId))).toBe(true);
    expect(await pathExists(path.join(paths.wikiDir, "alpha.md"))).toBe(true);
  });

  it("rejects traversal targets", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const traversal = await parsePatch(`---\nop: "create_wiki"\ntarget: "../../../etc/passwd"\nsummary: "Bad"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{}`);

    await expect(validatePatch(traversal, paths)).rejects.toThrow(/escapes wiki root/);
  });

  it("rejects update_wiki when the target is missing", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/missing.md"\nsummary: "Missing"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{}`);

    await expect(validatePatch(patch, paths)).rejects.toThrow(/does not exist/);
  });

  it("rejects create_wiki when the target already exists but still allows update_wiki", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry({
      id: "alpha",
      title: "Alpha",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: "base",
    }, paths);

    const createPatch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/alpha.md"\nsummary: "Alpha overwrite"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"alpha","title":"Alpha","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"overwrite"}`);
    const updatePatch = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/alpha.md"\nsummary: "Alpha update"\nproposer: "test"\ncreated: "2026-04-26T00:01:00.000Z"\n---\n{"id":"alpha","title":"Alpha","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:01:00.000Z","version":2,"body":"updated body"}`);

    const createPatchId = await enqueuePatch(createPatch, paths);
    const updatePatchId = await enqueuePatch(updatePatch, paths);

    await expect(approvePatch(createPatchId, paths)).rejects.toThrow(/create_wiki target already exists/);
    await expect(approvePatch(updatePatchId, paths)).resolves.toMatchObject({ status: "accepted" });
    expect(await readPatchFile(path.join(paths.wikiDir, "alpha.md"))).toContain("updated body");
  });

  it("rejects a safe target whose body tries to escape through entry id", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/safe.md"\nsummary: "Safe"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"../escape","title":"Escape","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"bad"}`);
    const patchId = await enqueuePatch(patch, paths);

    await expect(approvePatch(patchId, paths)).rejects.toThrow(/unsafe wiki id/);
    expect(await pathExists(path.join(paths.wikiDir, "safe.md"))).toBe(false);
  });

  it("archives rejections without mutating wiki files", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/beta.md"\nsummary: "Beta"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"beta","title":"Beta","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"hello"}`);

    const patchId = await enqueuePatch(patch, paths);
    const meta = await rejectPatch(patchId, "nope", paths);
    const archivedMeta = await readJsonFile<PatchMeta>(path.join(paths.archiveDir, patchId, "meta.json"));

    expect(meta.status).toBe("rejected");
    expect(archivedMeta.reason).toBe("nope");
    expect(await pathExists(path.join(paths.wikiDir, "beta.md"))).toBe(false);
  });

  it("fails reject after approve because the queue entry is gone", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry({
      id: "gamma",
      title: "Gamma",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: "base",
    }, paths);

    const patch = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/gamma.md"\nsummary: "Gamma"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"gamma","title":"Gamma","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:01.000Z","version":2,"body":"updated"}`);
    const patchId = await enqueuePatch(patch, paths);
    await approvePatch(patchId, paths);

    await expect(rejectPatch(patchId, "late", paths)).rejects.toThrow();
    expect(await readPatchFile(path.join(paths.archiveDir, patchId, "patch.md"))).toContain("\"update_wiki\"");
  });

  it("uses the sole queued item for show without exposing ENOENT paths", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/solo.md"\nsummary: "Solo"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"solo","title":"Solo","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"hello"}`);
    const patchId = await enqueuePatch(patch, paths);

    const selection = await resolveQueueSelection("", paths);
    const queued = await showQueue("", paths);

    expect(selection).toEqual({ id: patchId, autoSelected: true, availableIds: [patchId] });
    expect(queued.meta.id).toBe(patchId);
  });

  it("returns friendly queue guidance for missing or unknown IDs", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/help.md"\nsummary: "Help"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"help","title":"Help","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"hello"}`);
    const patchId = await enqueuePatch(patch, paths);

    await expect(resolveQueueSelection("missing", paths)).rejects.toThrow(new RegExp(`Available patch IDs: ${patchId}`));
    await expect(resolveQueueSelection("", resolveMemoryPaths(await makeTempRoot()))).rejects.toThrow(/Queue is empty/);
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

  it("normalizes single-newline legacy raw_source_ref footers on approve", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/legacy-single.md"\nsummary: "Legacy single"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"legacy-single","title":"Legacy single","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"human readable body\\nraw_source_ref: raw/2026-04-26-legacy-single-source.md"}`);

    const patchId = await enqueuePatch(patch, paths);
    await approvePatch(patchId, paths);
    const stored = await readPatchFile(path.join(paths.wikiDir, "legacy-single.md"));

    expect(stored).toContain('rawSourceRef: "raw/2026-04-26-legacy-single-source.md"');
    expect(stored).not.toContain("raw_source_ref:");
  });

  it("rejects promoted rawSourceRef values that escape raw storage", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const directMetaPatch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/bad-ref.md"\nsummary: "Bad ref"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"bad-ref","title":"Bad ref","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"safe body","rawSourceRef":"../escape.md"}`);
    const inlinePatch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/bad-inline.md"\nsummary: "Bad inline"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"bad-inline","title":"Bad inline","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"safe body\\nraw_source_ref: ../escape.md"}`);

    const directPatchId = await enqueuePatch(directMetaPatch, paths);
    const inlinePatchId = await enqueuePatch(inlinePatch, paths);

    await expect(approvePatch(directPatchId, paths)).rejects.toThrow(/must point into raw/);
    await expect(approvePatch(inlinePatchId, paths)).rejects.toThrow(/must point into raw/);
  });

  it("creates a conflict record when approval hits a body target mismatch", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/safe.md"\nsummary: "Mismatch"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"other","title":"Other","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"body text that is long enough for storage"}`);
    const patchId = await enqueuePatch(patch, paths, { rawSourceRef: "raw/2026-04-26-other-source-aaaaaaaa.md" });

    await expect(approvePatch(patchId, paths)).rejects.toThrow(/body id must match target filename/);
    const conflicts = await listConflicts(paths);
    const record = await readConflict(conflicts[0]!.id, paths);
    const meta = await readJsonFile<PatchMeta>(path.join(paths.queueDir, patchId, "meta.json"));

    expect(conflicts).toHaveLength(1);
    expect(record.meta.reason).toBe("patch_body_target_mismatch");
    expect(record.meta.patchId).toBe(patchId);
    expect(meta.conflictId).toBe(record.meta.id);
    expect(await readPatchFile(path.join(paths.root, "log.md"))).toContain("— conflict detected");
  });

  it("creates a conflict record when approval hits a source provenance conflict", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/provenance.md"\nsummary: "Provenance"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"provenance","title":"Provenance","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"body\\nraw_source_ref: raw/2026-04-26-inline-source-aaaaaaaa.md","rawSourceRef":"raw/2026-04-26-direct-source-bbbbbbbb.md"}`);
    const patchId = await enqueuePatch(patch, paths, { rawSourceRef: "raw/2026-04-26-direct-source-bbbbbbbb.md" });

    await expect(approvePatch(patchId, paths)).rejects.toThrow(/conflicting raw source provenance/);
    const conflicts = await listConflicts(paths);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toBe("source_provenance_conflict");
    expect(conflicts[0]?.patchId).toBe(patchId);
  });

  it("approves a full patch set and records aggregate approval", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const createdAt = "2026-04-26T00:00:00.000Z";
    const patchSetId = buildPatchSetId(createdAt, "raw/2026-04-26-source-a1b2c3d4.md");
    const sourcePatch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/sources/source-alpha.md"\nsummary: "Source Alpha"\nproposer: "test"\ncreated: "${createdAt}"\n---\n{"id":"source-alpha","title":"Source Alpha","tags":["source"],"created":"${createdAt}","updated":"${createdAt}","version":1,"type":"source","status":"current","body":"source body"}`);
    const targetPatch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/alpha.md"\nsummary: "Alpha"\nproposer: "test"\ncreated: "${createdAt}"\n---\n{"id":"alpha","title":"Alpha","tags":[],"created":"${createdAt}","updated":"${createdAt}","version":1,"body":"alpha body"}`);

    const sourcePatchId = await enqueuePatch(sourcePatch, paths, { patch_set_id: patchSetId });
    const targetPatchId = await enqueuePatch(targetPatch, paths, { patch_set_id: patchSetId });
    await writePatchSet(paths, {
      id: patchSetId,
      sourceRef: "raw/2026-04-26-source-a1b2c3d4.md",
      createdAt,
      patchIds: [sourcePatchId, targetPatchId],
    });

    const result = await approvePatchSet(patchSetId, paths);

    expect(result.status).toBe("accepted");
    expect(result.accepted).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
    expect(await pathExists(path.join(paths.archiveDir, sourcePatchId))).toBe(true);
    expect(await readPatchFile(path.join(paths.root, "log.md"))).toContain("— patch set approved");
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

  it("buildPatchId disambiguates patches sharing timestamp+summary by hashing target+body", async () => {
    // Sentinel 회귀: compile_source 가 같은 timestamp + 같은 summary 의 patch 를 여러 개 enqueue 해도
    // patchId 가 충돌하지 않아야 한다. 이전에는 summary hex 만 사용해 silent overwrite 가 가능했다.
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const ts = "2026-05-05T00:00:00.000Z";
    const patchA = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/alpha-1.md"\nsummary: "Same Title"\nproposer: "test"\ncreated: "${ts}"\n---\n{"id":"alpha-1","title":"A1","tags":[],"created":"${ts}","updated":"${ts}","version":1,"body":"first"}`);
    const patchB = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/alpha-2.md"\nsummary: "Same Title"\nproposer: "test"\ncreated: "${ts}"\n---\n{"id":"alpha-2","title":"A2","tags":[],"created":"${ts}","updated":"${ts}","version":1,"body":"second"}`);
    const patchC = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/alpha-3.md"\nsummary: "Same Title"\nproposer: "test"\ncreated: "${ts}"\n---\n{"id":"alpha-3","title":"A3","tags":[],"created":"${ts}","updated":"${ts}","version":1,"body":"third"}`);

    const idA = await enqueuePatch(patchA, paths);
    const idB = await enqueuePatch(patchB, paths);
    const idC = await enqueuePatch(patchC, paths);

    expect(new Set([idA, idB, idC]).size).toBe(3);
    expect(await pathExists(path.join(paths.queueDir, idA))).toBe(true);
    expect(await pathExists(path.join(paths.queueDir, idB))).toBe(true);
    expect(await pathExists(path.join(paths.queueDir, idC))).toBe(true);
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-patch-"));
  cleanupPaths.push(root);
  return root;
}
