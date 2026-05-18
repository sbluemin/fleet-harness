import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { listConflicts, readConflict } from "../src/conflicts.js";
import { buildPatchSetId, writePatchSet } from "../src/patch-set.js";
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
  it("parses patch frontmatter with CRLF line endings", async () => {
    const patch = await parsePatch([
      "---",
      `op: "create_wiki"`,
      `target: "wiki/crlf.md"`,
      `summary: "CRLF"`,
      `proposer: "test"`,
      `created: "2026-04-26T00:00:00.000Z"`,
      "---",
      `{"id":"crlf","title":"CRLF","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"hello"}`,
    ].join("\r\n"));

    expect(patch.frontmatter.target).toBe("wiki/crlf.md");
    expect(JSON.parse(patch.body)).toMatchObject({ id: "crlf" });
  });

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

  it("rejects dot-segment alias targets before approval", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const alias = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/sub/../race.md"\nsummary: "Alias"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{}`);

    await expect(validatePatch(alias, paths)).rejects.toThrow(/dot segments/);
  });

  it("rejects backslash, trailing slash, leading slash, and absolute targets", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const cases = [
      { target: String.raw`wiki\foo.md`, error: /forward slashes/ },
      { target: "wiki/foo.md/", error: /end with a slash/ },
      { target: "/wiki/foo.md", error: /relative/ },
      { target: path.join(paths.wikiDir, "foo.md"), error: /relative|forward slashes/ },
    ];

    for (const item of cases) {
      const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "${item.target}"\nsummary: "Bad target"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{}`);
      await expect(validatePatch(patch, paths)).rejects.toThrow(item.error);
    }
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

  it("records current metadata from CRLF wiki entries when creating patch conflicts", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await mkdir(paths.wikiDir, { recursive: true });
    await writeFile(path.join(paths.wikiDir, "safe.md"), [
      "---",
      `id: "safe"`,
      `title: "Safe"`,
      "tags: []",
      `created: "2026-04-26T00:00:00.000Z"`,
      `updated: "2026-04-26T00:00:01.000Z"`,
      "version: 3",
      "---",
      "current body",
    ].join("\r\n"), "utf8");
    const patch = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/safe.md"\nsummary: "Mismatch"\nproposer: "test"\ncreated: "2026-04-26T00:02:00.000Z"\n---\n{"id":"other","title":"Other","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:02:00.000Z","version":4,"body":"body text that is long enough for storage"}`);
    const patchId = await enqueuePatch(patch, paths);

    await expect(approvePatch(patchId, paths)).rejects.toThrow(/body id must match target filename/);
    const [conflict] = await listConflicts(paths);
    const record = await readConflict(conflict!.id, paths);

    expect(record.meta.currentVersion).toBe(3);
    expect(record.current).toContain("current body");
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

  it("maps missing wiki root during damaged queue approval to validation errors", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patchId = "2026-04-26T00-00-00-000Z-deadbeef";
    await mkdir(path.join(paths.queueDir, patchId), { recursive: true });
    await writeFile(path.join(paths.queueDir, patchId, "patch.md"), `---\nop: "update_wiki"\ntarget: "wiki/missing.md"\nsummary: "Missing"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"missing","title":"Missing","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:01:00.000Z","version":2,"body":"missing update"}`, "utf8");
    await writeFile(path.join(paths.queueDir, patchId, "meta.json"), JSON.stringify({
      id: patchId,
      status: "pending",
      createdAt: "2026-04-26T00:00:00.000Z",
      baseVersion: 1,
    } satisfies PatchMeta), "utf8");

    await expect(approvePatch(patchId, paths)).rejects.toThrow(/approve stale base_version|update_wiki target does not exist/);
    await expect(approvePatch(patchId, paths)).rejects.not.toThrow(/ENOENT/);
  });

  it("listQueue silently skips corrupted entries (missing meta.json) instead of throwing", async () => {
    // 회귀: 옛 buildPatchId 충돌 시기에 빈 queue 디렉터리가 남았던 워크스페이스에서
    // listQueue/web Drydock 메뉴가 ENOENT 로 500 internal_error 를 던지지 않아야 한다.
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const goodPatch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/good.md"\nsummary: "good"\nproposer: "test"\ncreated: "2026-05-05T00:00:00.000Z"\n---\n{"id":"good","title":"G","tags":[],"created":"2026-05-05T00:00:00.000Z","updated":"2026-05-05T00:00:00.000Z","version":1,"body":"good body"}`);
    const goodId = await enqueuePatch(goodPatch, paths);

    // 빈 디렉터리 인위 생성 — 옛 충돌 잔재 시뮬레이션
    const emptyId = "2026-05-05T05-10-13-611Z-deadbeef";
    await mkdir(path.join(paths.queueDir, emptyId), { recursive: true });

    const items = await listQueue(paths);

    expect(items.map((item) => item.id)).toEqual([goodId]);
    expect(items.some((item) => item.id === emptyId)).toBe(false);
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

  it("rejects stale update patches at approve time and leaves them pending with a conflict", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry({
      id: "stale",
      title: "Stale",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: "base",
    }, paths);
    const baseMarkdown = await readPatchFile(path.join(paths.wikiDir, "stale.md"));
    const baseHash = computeContentHash(baseMarkdown);
    const first = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/stale.md"\nsummary: "First"\nproposer: "test"\ncreated: "2026-04-26T00:01:00.000Z"\n---\n{"id":"stale","title":"Stale","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:01:00.000Z","version":2,"body":"first"}`);
    const second = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/stale.md"\nsummary: "Second"\nproposer: "test"\ncreated: "2026-04-26T00:02:00.000Z"\n---\n{"id":"stale","title":"Stale","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:02:00.000Z","version":2,"body":"second"}`);
    const firstId = await enqueuePatch(first, paths, { baseVersion: 1, baseHash });
    const secondId = await enqueuePatch(second, paths, { baseVersion: 1, baseHash });

    await approvePatch(firstId, paths);
    await expect(approvePatch(secondId, paths)).rejects.toThrow(/approve stale base_version/);
    const meta = await readJsonFile<PatchMeta>(path.join(paths.queueDir, secondId, "meta.json"));
    const conflicts = await listConflicts(paths);

    expect(meta.status).toBe("pending");
    expect(meta.conflictId).toBeDefined();
    expect(conflicts[0]?.reason).toBe("base_version_mismatch");
    expect(await pathExists(path.join(paths.queueDir, secondId))).toBe(true);
  });

  it("serializes concurrent approvals for the same target so one stale update is rejected", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry({
      id: "race",
      title: "Race",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: "base",
    }, paths);
    const baseMarkdown = await readPatchFile(path.join(paths.wikiDir, "race.md"));
    const baseHash = computeContentHash(baseMarkdown);
    const first = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/race.md"\nsummary: "Race first"\nproposer: "test"\ncreated: "2026-04-26T00:01:00.000Z"\n---\n{"id":"race","title":"Race","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:01:00.000Z","version":2,"body":"first concurrent"}`);
    const second = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/race.md"\nsummary: "Race second"\nproposer: "test"\ncreated: "2026-04-26T00:02:00.000Z"\n---\n{"id":"race","title":"Race","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:02:00.000Z","version":2,"body":"second concurrent"}`);
    const firstId = await enqueuePatch(first, paths, { baseVersion: 1, baseHash });
    const secondId = await enqueuePatch(second, paths, { baseVersion: 1, baseHash });

    const results = await Promise.allSettled([approvePatch(firstId, paths), approvePatch(secondId, paths)]);
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/approve stale base_version/);
    expect((await listConflicts(paths))[0]?.reason).toBe("base_version_mismatch");
    expect(await readPatchFile(path.join(paths.wikiDir, "race.md"))).toMatch(/first concurrent|second concurrent/);
  });

  it("does not double-approve canonical and dot-segment alias targets in a concurrent race", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry({
      id: "race",
      title: "Race",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: "base",
    }, paths);
    const baseMarkdown = await readPatchFile(path.join(paths.wikiDir, "race.md"));
    const baseHash = computeContentHash(baseMarkdown);
    const canonical = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/race.md"\nsummary: "Canonical race"\nproposer: "test"\ncreated: "2026-04-26T00:03:00.000Z"\n---\n{"id":"race","title":"Race","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:03:00.000Z","version":2,"body":"canonical concurrent"}`);
    const alias = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/sub/../race.md"\nsummary: "Alias race"\nproposer: "test"\ncreated: "2026-04-26T00:04:00.000Z"\n---\n{"id":"race","title":"Race","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:04:00.000Z","version":2,"body":"alias concurrent"}`);
    const canonicalId = await enqueuePatch(canonical, paths, { baseVersion: 1, baseHash });
    const aliasId = await enqueuePatch(alias, paths, { baseVersion: 1, baseHash });

    const results = await Promise.allSettled([approvePatch(canonicalId, paths), approvePatch(aliasId, paths)]);
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/approve stale base_version|dot segments/);
    expect(await readPatchFile(path.join(paths.wikiDir, "race.md"))).toContain("canonical concurrent");
  });

  it("rejects symlink path components before approval", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry({
      id: "race",
      title: "Race",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: "base",
    }, paths);
    await symlink(paths.wikiDir, path.join(paths.wikiDir, "link"), "dir");
    const alias = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/link/race.md"\nsummary: "Symlink race"\nproposer: "test"\ncreated: "2026-04-26T00:05:00.000Z"\n---\n{"id":"race","title":"Race","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:05:00.000Z","version":2,"body":"symlink concurrent"}`);

    await expect(validatePatch(alias, paths)).rejects.toThrow(/symlink path components/);
  });

  it("approves normal wiki targets when the wiki root itself is a symlink", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await mkdir(path.dirname(paths.wikiDir), { recursive: true });
    const actualWikiDir = path.join(root, "actual-wiki");
    await mkdir(actualWikiDir, { recursive: true });
    await symlink(actualWikiDir, paths.wikiDir, "dir");
    await writeWikiEntry({
      id: "root-link",
      title: "Root Link",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: "base",
    }, paths);
    const baseMarkdown = await readPatchFile(path.join(paths.wikiDir, "root-link.md"));
    const patch = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/root-link.md"\nsummary: "Root link update"\nproposer: "test"\ncreated: "2026-04-26T00:01:00.000Z"\n---\n{"id":"root-link","title":"Root Link","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:01:00.000Z","version":2,"body":"updated through symlink root"}`);
    const patchId = await enqueuePatch(patch, paths, {
      baseHash: computeContentHash(baseMarkdown),
      baseVersion: 1,
    });

    await expect(approvePatch(patchId, paths)).resolves.toMatchObject({ status: "accepted" });
    expect(await readPatchFile(path.join(paths.wikiDir, "root-link.md"))).toContain("updated through symlink root");
  });

  it("serializes case aliases on case-insensitive filesystems", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry({
      id: "case",
      title: "Case",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: "base",
    }, paths);
    if (!(await pathExists(path.join(paths.wikiDir, "CASE.md")))) return;
    const baseMarkdown = await readPatchFile(path.join(paths.wikiDir, "case.md"));
    const baseHash = computeContentHash(baseMarkdown);
    const lower = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/case.md"\nsummary: "Lower case race"\nproposer: "test"\ncreated: "2026-04-26T00:06:00.000Z"\n---\n{"id":"case","title":"Case","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:06:00.000Z","version":2,"body":"lower concurrent"}`);
    const upper = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/CASE.md"\nsummary: "Upper case race"\nproposer: "test"\ncreated: "2026-04-26T00:07:00.000Z"\n---\n{"id":"CASE","title":"Case","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:07:00.000Z","version":2,"body":"upper concurrent"}`);
    const lowerId = await enqueuePatch(lower, paths, { baseVersion: 1, baseHash });
    const upperId = await enqueuePatch(upper, paths, { baseVersion: 1, baseHash });

    const results = await Promise.allSettled([approvePatch(lowerId, paths), approvePatch(upperId, paths)]);
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/approve stale base_version|body id must match target filename/);
  });

  it("keeps legacy update patches without base metadata approvable", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry({
      id: "legacy-base",
      title: "Legacy Base",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: "base",
    }, paths);
    const patch = await parsePatch(`---\nop: "update_wiki"\ntarget: "wiki/legacy-base.md"\nsummary: "Legacy"\nproposer: "test"\ncreated: "2026-04-26T00:01:00.000Z"\n---\n{"id":"legacy-base","title":"Legacy Base","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:01:00.000Z","version":2,"body":"legacy update"}`);
    const patchId = await enqueuePatch(patch, paths);

    await expect(approvePatch(patchId, paths)).resolves.toMatchObject({ status: "accepted" });
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-patch-"));
  cleanupPaths.push(root);
  return root;
}
