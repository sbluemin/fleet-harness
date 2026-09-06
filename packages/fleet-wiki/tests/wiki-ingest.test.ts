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
      id: "prd-alpha",
      title: "PRD Alpha",
      body: [
        "## Overview",
        "",
        "candidate knowledge ".repeat(6),
        "",
        "## Problem",
        "",
        "problem",
        "",
        "## Goals",
        "",
        "goals",
        "",
        "## Non-Goals",
        "",
        "non-goals",
        "",
        "## User Stories",
        "",
        "stories",
        "",
        "## Functional Requirements",
        "",
        "requirements",
        "",
        "## Acceptance Criteria",
        "",
        "criteria",
        "",
        "## Open Questions",
        "",
        "questions",
        "",
        "## Related",
        "",
        "- [[wiki:prd-beta]]",
      ].join("\n"),
      tags: ["fleet", "prd"],
      source: "prd source text",
      template_id: "prd",
      mode: "create",
    }, undefined, undefined, { cwd: root } as any);
    const payload = JSON.parse(result.content[0]!.text) as { patch_id: string };
    const queued = await showQueue(payload.patch_id, paths);
    const entry = JSON.parse(queued.patch.body) as WikiEntry;

    expect(entry.templateId).toBe("prd");
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
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-ingest-"));
  cleanupPaths.push(root);
  return root;
}
