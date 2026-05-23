import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { showQueue } from "../src/patch.js";
import { resolveMemoryPaths } from "../src/paths.js";
import { computeContentHash, readRawSourceEntry, writeWikiEntry } from "../src/store.js";
import { buildIngestToolConfig } from "../src/tools/ingest.js";
import type { WikiEntry } from "../src/types.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("wiki ingest provenance", () => {
  it("persists explicit template_id and enforces required template sections", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildIngestToolConfig();

    const result = await tool.execute("tool-call", {
      id: "guide-alpha",
      title: "Guide Alpha",
      body: [
        "## Overview",
        "",
        "candidate knowledge ".repeat(6),
        "",
        "## Related",
        "",
        "- [[wiki:guide-beta]]",
      ].join("\n"),
      tags: ["fleet"],
      source: "guide source text",
      template_id: "guide",
      mode: "create",
    }, undefined, undefined, { cwd: root } as any);
    const payload = JSON.parse(result.content[0]!.text) as { patch_id: string };
    const queued = await showQueue(payload.patch_id, paths);
    const entry = JSON.parse(queued.patch.body) as WikiEntry;

    expect(entry.templateId).toBe("guide");
  });

  it("rejects template_id bodies that omit required sections", async () => {
    const root = await makeTempRoot();
    const tool = buildIngestToolConfig();

    await expect(tool.execute("tool-call", {
      id: "guide-missing",
      title: "Guide Missing",
      body: ["## Overview", "", "candidate knowledge ".repeat(8)].join("\n"),
      tags: ["fleet"],
      source: "guide source text",
      template_id: "guide",
      mode: "create",
    }, undefined, undefined, { cwd: root } as any)).rejects.toThrow("missing sections: Related");
  });

  it("adds latest rawSourceRef and appends a deduped rawSourceRefs entry", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildIngestToolConfig();
    await writeWikiEntry({
      id: "alpha",
      title: "Alpha",
      tags: ["fleet"],
      created: "2026-05-01T00:00:00.000Z",
      updated: "2026-05-01T00:00:00.000Z",
      version: 1,
      body: "Alpha body",
      rawSourceRef: "raw/old.md",
      rawSourceRefs: [{ ref: "raw/old.md", title: "Old" }],
    }, paths);

    const result = await tool.execute("tool-call", {
      id: "alpha",
      title: "Alpha",
      body: "candidate knowledge ".repeat(8),
      tags: ["fleet"],
      source: "new source text",
      source_title: "New Source",
      mode: "update",
      base_version: 1,
    }, undefined, undefined, { cwd: root } as any);
    const payload = JSON.parse(result.content[0]!.text) as { patch_id: string; raw_source_ref: string };
    const queued = await showQueue(payload.patch_id, paths);
    const entry = JSON.parse(queued.patch.body) as WikiEntry;
    const raw = await readRawSourceEntry(payload.raw_source_ref, paths);

    expect(entry.rawSourceRef).toBe(payload.raw_source_ref);
    expect(entry.rawSourceRefs?.map((item) => item.ref)).toEqual(["raw/old.md", payload.raw_source_ref]);
    expect(entry.rawSourceRefs?.at(-1)).toMatchObject({
      title: "New Source",
      hash: computeContentHash(raw.content),
    });
    expect(queued.meta.baseVersion).toBe(1);
    expect(queued.meta.baseHash).toBeDefined();
  });

  it("seeds rawSourceRefs history from legacy rawSourceRef-only entries", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildIngestToolConfig();
    await writeWikiEntry({
      id: "legacy",
      title: "Legacy",
      tags: ["fleet"],
      created: "2026-05-01T00:00:00.000Z",
      updated: "2026-05-01T00:00:00.000Z",
      version: 1,
      body: "Legacy body",
      rawSourceRef: "raw/legacy-old.md",
    }, paths);

    const result = await tool.execute("tool-call", {
      id: "legacy",
      title: "Legacy",
      body: "candidate knowledge ".repeat(8),
      tags: ["fleet"],
      source: "legacy new source text",
      source_title: "Legacy New Source",
      mode: "update",
      base_version: 1,
    }, undefined, undefined, { cwd: root } as any);
    const payload = JSON.parse(result.content[0]!.text) as { patch_id: string; raw_source_ref: string };
    const queued = await showQueue(payload.patch_id, paths);
    const entry = JSON.parse(queued.patch.body) as WikiEntry;

    expect(entry.rawSourceRef).toBe(payload.raw_source_ref);
    expect(entry.rawSourceRefs?.map((item) => item.ref)).toEqual(["raw/legacy-old.md", payload.raw_source_ref]);
  });

  it("does not duplicate an identical rawSourceRefs ref", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const tool = buildIngestToolConfig();
    const expectedRef = `raw/${new Date().toISOString().slice(0, 10)}-beta-source-${computeContentHash("same source text")}.md`;
    await writeWikiEntry({
      id: "beta",
      title: "Beta",
      tags: ["fleet"],
      created: "2026-05-01T00:00:00.000Z",
      updated: "2026-05-01T00:00:00.000Z",
      version: 1,
      body: "Beta body",
      rawSourceRef: expectedRef,
      rawSourceRefs: [{ ref: expectedRef, title: "Same Source" }],
    }, paths);

    const result = await tool.execute("tool-call", {
      id: "beta",
      title: "Beta",
      body: "candidate knowledge ".repeat(8),
      tags: ["fleet"],
      source: "same source text",
      source_title: "Same Source",
      mode: "update",
      base_version: 1,
    }, undefined, undefined, { cwd: root } as any);
    const payload = JSON.parse(result.content[0]!.text) as { patch_id: string };
    const queued = await showQueue(payload.patch_id, paths);
    const entry = JSON.parse(queued.patch.body) as WikiEntry;

    expect(entry.rawSourceRefs).toEqual([{ ref: expectedRef, title: "Same Source" }]);
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-ingest-"));
  cleanupPaths.push(root);
  return root;
}
