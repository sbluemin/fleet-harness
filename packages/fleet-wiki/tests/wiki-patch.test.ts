import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { approvePatch, enqueuePatch, parsePatch, rejectPatch, resolveQueueSelection, showQueue, validatePatch } from "../src/patch.js";
import { resolveMemoryPaths } from "../src/paths.js";
import { pathExists, readJsonFile, readPatchFile, writeWikiEntry } from "../src/store.js";
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
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-patch-"));
  cleanupPaths.push(root);
  return root;
}
