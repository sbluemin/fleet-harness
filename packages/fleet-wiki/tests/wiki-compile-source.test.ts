import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readPatchSet } from "../src/patch-set.js";
import { resolveMemoryPaths } from "../src/paths.js";
import { pathExists, readJsonFile, writeWikiEntry } from "../src/store.js";
import { buildCompileSourceToolConfig } from "../src/tools/compile-source.js";
import type { PatchMeta } from "../src/types.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("wiki compile source", () => {
  it("returns preview proposals without creating knowledge files", async () => {
    const root = await makeTempRoot();
    const tool = buildCompileSourceToolConfig();

    const result = await tool.execute("tool-call", {
      source: "Alpha source context with [[wiki:alpha]] and stable product notes.",
      source_title: "Alpha Source",
      mode: "preview",
    }, undefined, undefined, { cwd: root } as any);
    const payload = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      patch_set_id: string;
      patches: Array<{ patch_id: string; target: string }>;
      related_entry_candidates: Array<{ reason: string }>;
      warnings: string[];
    };

    expect(payload.ok).toBe(true);
    expect(payload.patch_set_id.length).toBeGreaterThan(0);
    expect(payload.patches[0]?.patch_id).toMatch(/^preview:/);
    expect(payload.patches[0]?.target).toBe("wiki/sources/alpha-source.md");
    expect(Array.isArray(payload.related_entry_candidates)).toBe(true);
    expect(payload.warnings).toContain("preview mode does not persist raw source, queue items, logs, or patch set metadata");
    expect(await pathExists(path.join(root, ".fleet/knowledge"))).toBe(false);
  });

  it("stages a patch set with a source page and deterministic related update patches", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildCompileSourceToolConfig();

    await writeWikiEntry({
      id: "alpha",
      title: "Alpha",
      tags: ["fleet"],
      created: "2026-05-01T00:00:00.000Z",
      updated: "2026-05-01T00:00:00.000Z",
      version: 1,
      body: "Alpha body",
      aliases: ["Alpha Source"],
    }, paths);

    const result = await tool.execute("tool-call", {
      source: "Alpha source context with [[wiki:alpha]] and stable product notes.",
      source_title: "Alpha Source",
      mode: "stage",
      max_pages_touched: 3,
    }, undefined, undefined, { cwd: root } as any);
    const payload = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      patch_set_id: string;
      patches: Array<{ patch_id: string; target: string }>;
      related_entry_candidates: Array<{ id: string }>;
    };
    const patchSet = await readPatchSet(paths, payload.patch_set_id);
    const sourceMeta = await readJsonFile<PatchMeta>(path.join(paths.queueDir, payload.patches[0]!.patch_id, "meta.json"));
    const targetMeta = await readJsonFile<PatchMeta>(path.join(paths.queueDir, payload.patches[1]!.patch_id, "meta.json"));
    const logContent = await readFile(path.join(paths.root, "log.md"), "utf8");

    expect(payload.ok).toBe(true);
    expect(payload.patches).toHaveLength(2);
    expect(payload.patches.map((item) => item.target)).toEqual(expect.arrayContaining([
      "wiki/sources/alpha-source.md",
      "wiki/alpha.md",
    ]));
    expect(patchSet.patchIds).toEqual(payload.patches.map((item) => item.patch_id));
    expect(sourceMeta.patch_set_id).toBe(payload.patch_set_id);
    expect(targetMeta.patch_set_id).toBe(payload.patch_set_id);
    expect(payload.related_entry_candidates[0]?.id).toBe("alpha");
    expect(logContent).toContain("— patch set staged");
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-compile-source-"));
  cleanupPaths.push(root);
  return root;
}
