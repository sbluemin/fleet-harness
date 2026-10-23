import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMemoryPaths } from "../../host/wiki/paths.js";
import { pathExists, readWikiEntry, writeWikiEntry } from "../../host/wiki/store.js";
import { buildCompileSourceToolConfig } from "../../host/wiki/tools/compile-source.js";
import type { WikiEntry } from "../../host/wiki/types.js";

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
    }, undefined, undefined, { paths: createMemoryPaths(path.join(root, ".fleet", "knowledge")) } as any);
    const payload = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      entries: Array<{ entry_id: string; target: string; version?: number }>;
      related_entry_candidates: Array<{ reason: string }>;
      warnings: string[];
    };

    expect(payload.ok).toBe(true);
    expect(payload.entries[0]?.version).toBeUndefined();
    expect(payload.entries[0]?.target).toBe("wiki/sources/alpha-source.md");
    expect(Array.isArray(payload.related_entry_candidates)).toBe(true);
    expect(payload.warnings).toContain("preview mode does not persist sources, entries, or logs");
    expect(await pathExists(path.join(root, ".fleet/knowledge"))).toBe(false);
  });

  it("writes a source page and deterministic related entry updates", async () => {
    const root = await makeTempRoot();
    const paths = createMemoryPaths(path.join(root, ".fleet", "knowledge"));
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
      rawSourceRef: "raw/old-alpha.md",
    }, paths);

    const result = await tool.execute("tool-call", {
      source: "Alpha source context with [[wiki:alpha]] and stable product notes.",
      source_title: "Alpha Source",
      mode: "write",
      max_pages_touched: 3,
    }, undefined, undefined, { paths } as any);
    const payload = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      entries: Array<{ entry_id: string; target: string; version?: number }>;
      related_entry_candidates: Array<{ id: string }>;
    };
    const sourceEntry = (await readWikiEntry(payload.entries[0]!.entry_id, paths))!;
    const targetEntry = (await readWikiEntry(payload.entries[1]!.entry_id, paths))!;
    const logContent = await readFile(path.join(paths.root, "log.md"), "utf8");

    expect(payload.ok).toBe(true);
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries.map((item) => item.target)).toEqual(expect.arrayContaining([
      "wiki/sources/alpha-source.md",
      "wiki/alpha.md",
    ]));
    expect(sourceEntry.templateId).toBeUndefined();
    expect(sourceEntry.body).toContain("## Overview");
    expect(sourceEntry.body).toContain("## Related");
    expect(targetEntry.rawSourceRef).not.toBe("raw/old-alpha.md");
    expect(targetEntry.rawSourceRefs?.map((item) => item.ref)).toEqual(["raw/old-alpha.md", targetEntry.rawSourceRef]);
    expect(payload.related_entry_candidates[0]?.id).toBe("alpha");
    expect(logContent).toContain("— source compiled");
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-compile-source-"));
  cleanupPaths.push(root);
  return root;
}
