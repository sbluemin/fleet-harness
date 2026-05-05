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
  it("creates, lists, reads, and resolves conflict records with expected files", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    const created = await createConflict({
      reason: "duplicate_title",
      target: "wiki/alpha.md",
      wikiId: "alpha",
      title: "Alpha",
      proposer: "test",
      current: "---\nid: \"alpha\"\n---\ncurrent",
      proposed: "---\nid: \"alpha\"\n---\nproposed",
      rawSource: "raw source body",
      now: new Date("2026-05-05T00:00:00.000Z"),
    }, paths);

    const listed = await listConflicts(paths);
    const record = await readConflict(created.meta.id, paths);
    const resolved = await resolveConflict(created.meta.id, {
      resolution: "manual",
      note: "checked by human",
      now: new Date("2026-05-05T00:01:00.000Z"),
    }, paths);

    expect(listed[0]?.id).toBe(created.meta.id);
    expect(record.current).toContain("current");
    expect(record.proposed).toContain("proposed");
    expect(record.rawSource).toBe("raw source body");
    expect(resolved.status).toBe("resolved");
    expect(await pathExists(path.join(paths.conflictsDir, created.meta.id, "meta.json"))).toBe(true);
    expect(await pathExists(path.join(paths.conflictsDir, created.meta.id, "current.md"))).toBe(true);
    expect(await pathExists(path.join(paths.conflictsDir, created.meta.id, "proposed.md"))).toBe(true);
    expect(await pathExists(path.join(paths.conflictsDir, created.meta.id, "raw-source.md"))).toBe(true);
  });

  it("keeps backward-compatible minimal ingest args for a missing target", async () => {
    const root = await makeTempRoot();
    const result = await runIngest(root, {
      id: "alpha",
      title: "Alpha",
      body: longBody("alpha"),
      tags: ["one"],
      source: "source material",
    });
    const paths = resolveMemoryPaths(root);
    const queued = await showQueue(result.patch_id!, paths);

    expect(result).toMatchObject({ ok: true, mode: "auto", op: "create_wiki" });
    expect(queued.patch.frontmatter.op).toBe("create_wiki");
  });

  it("rejects create mode on existing target without writing raw or queue files by default", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry(baseEntry("alpha"), paths);

    await expect(runIngest(root, {
      id: "alpha",
      title: "Alpha",
      body: longBody("updated"),
      tags: [],
      source: "new source",
      mode: "create",
    })).rejects.toThrow(/create target already exists/);
    expect(await listDirectoryNamesSafe(paths.rawDir)).toHaveLength(0);
    expect(await listDirectoryNamesSafe(paths.queueDir)).toHaveLength(0);
  });

  it("records a create-target conflict when queue_conflict is requested", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry(baseEntry("alpha"), paths);

    const result = await runIngest(root, {
      id: "alpha",
      title: "Alpha",
      body: longBody("updated"),
      tags: [],
      source: "new source",
      mode: "create",
      duplicate_policy: "queue_conflict",
    });
    const conflict = await readConflict(result.conflict_id!, paths);

    expect(result).toMatchObject({ ok: false, mode: "create" });
    expect(conflict.meta.reason).toBe("create_target_exists");
    expect(conflict.meta.rawSourceRef).toBe(result.raw_source_ref);
    expect(conflict.current).toContain('id: "alpha"');
    expect(conflict.proposed).toContain('title: "Alpha"');
  });

  it("stages update_wiki with version increment and refreshed updated timestamp", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry(baseEntry("alpha"), paths);

    const result = await runIngest(root, {
      id: "alpha",
      title: "Alpha updated",
      body: longBody("updated"),
      tags: ["two"],
      source: "new source",
      mode: "update",
    });
    const queued = await showQueue(result.patch_id!, paths);
    const entry = JSON.parse(queued.patch.body) as { version: number; updated: string; created: string; rawSourceRef: string; title: string };

    expect(result).toMatchObject({ ok: true, mode: "update", op: "update_wiki" });
    expect(entry.version).toBe(2);
    expect(entry.created).toBe("2026-05-05T00:00:00.000Z");
    expect(entry.updated).not.toBe("2026-05-05T00:00:00.000Z");
    expect(entry.rawSourceRef).toBe(result.raw_source_ref);
    expect(entry.title).toBe("Alpha updated");
  });

  it("handles missing update targets with reject and queue_conflict modes", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await expect(runIngest(root, {
      id: "missing",
      title: "Missing",
      body: longBody("missing"),
      tags: [],
      source: "missing source",
      mode: "update",
    })).rejects.toThrow(/update target does not exist/);

    const conflictResult = await runIngest(root, {
      id: "missing",
      title: "Missing",
      body: longBody("missing"),
      tags: [],
      source: "missing source",
      mode: "update",
      duplicate_policy: "queue_conflict",
    });
    const conflict = await readConflict(conflictResult.conflict_id!, paths);

    expect(conflict.meta.reason).toBe("update_target_missing");
  });

  it("auto mode updates existing targets and creates missing ones", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry(baseEntry("existing"), paths);

    const updateResult = await runIngest(root, {
      id: "existing",
      title: "Existing",
      body: longBody("existing update"),
      tags: [],
      source: "existing source",
    });
    const createResult = await runIngest(root, {
      id: "missing",
      title: "Missing",
      body: longBody("missing create"),
      tags: [],
      source: "missing source",
    });

    expect(updateResult.op).toBe("update_wiki");
    expect(createResult.op).toBe("create_wiki");
  });

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

  it("exposes unresolved conflicts through wiki_patch_queue list and show", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await writeWikiEntry(baseEntry("alpha"), paths);
    const ingestResult = await runIngest(root, {
      id: "alpha",
      title: "Alpha",
      body: longBody("pending update"),
      tags: [],
      source: "alpha source",
      mode: "update",
    });
    const patchTool = buildPatchQueueToolConfig();
    const conflictResult = await runIngest(root, {
      id: "alpha",
      title: "Alpha",
      body: longBody("conflicted"),
      tags: [],
      source: "conflicted source",
      mode: "create",
      duplicate_policy: "queue_conflict",
    });

    const listPayload = await runPatchQueue(patchTool, root, { action: "list" });
    const showPayload = await runPatchQueue(patchTool, root, { action: "show", patch_id: ingestResult.patch_id });

    expect(listPayload.unresolved_conflicts).toHaveLength(1);
    expect(listPayload.unresolved_conflicts[0]?.id).toBe(conflictResult.conflict_id);
    expect(showPayload.related_conflicts).toHaveLength(1);
    expect(showPayload.related_conflicts[0]?.id).toBe(conflictResult.conflict_id);
  });

  it("keeps append_evidence updates queueable while recording the latest raw source", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const first = await runIngest(root, {
      id: "alpha",
      title: "Alpha",
      body: longBody("first"),
      tags: [],
      source: "shared evidence v1",
      source_title: "source.txt",
    });
    await approvePatch(first.patch_id!, paths);

    const second = await runIngest(root, {
      id: "alpha",
      title: "Alpha",
      body: longBody("second"),
      tags: [],
      source: "shared evidence v2",
      source_title: "source.txt",
      mode: "update",
      duplicate_policy: "append_evidence",
    });
    const queued = await showQueue(second.patch_id!, paths);
    const payload = JSON.parse(queued.patch.body) as { rawSourceRef: string };

    expect(second.ok).toBe(true);
    expect(second.op).toBe("update_wiki");
    expect(second.warnings.some((warning: string) => warning.includes("raw source contradiction"))).toBe(true);
    expect(payload.rawSourceRef).toBe(second.raw_source_ref);
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
