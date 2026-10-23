import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMemoryPaths } from "../../host/wiki/paths.js";
import { computeContentHash, readRawSourceEntry, readWikiEntry, writeWikiEntry } from "../../host/wiki/store.js";
import { buildIngestToolConfig } from "../../host/wiki/tools/ingest.js";
import type { WikiEntry } from "../../host/wiki/types.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("wiki ingest provenance", () => {
  it("persists explicit template_id and enforces required template sections", async () => {
    const root = await makeTempRoot();
    const paths = createMemoryPaths(path.join(root, ".fleet", "knowledge"));
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
    }, undefined, undefined, { paths } as any);
    const payload = JSON.parse(result.content[0]!.text) as { entry_id: string };
    const entry = (await readWikiEntry(payload.entry_id, paths))!;

    expect(entry.templateId).toBe("prd");
  });

  it("adds latest rawSourceRef and appends a deduped rawSourceRefs entry", async () => {
    const root = await makeTempRoot();
    const paths = createMemoryPaths(path.join(root, ".fleet", "knowledge"));
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
    }, undefined, undefined, { paths } as any);
    const payload = JSON.parse(result.content[0]!.text) as { entry_id: string; raw_source_ref: string; version: number; history_ref: string };
    const entry = (await readWikiEntry(payload.entry_id, paths))!;
    const raw = await readRawSourceEntry(payload.raw_source_ref, paths);

    expect(entry.rawSourceRef).toBe(payload.raw_source_ref);
    expect(entry.rawSourceRefs?.map((item) => item.ref)).toEqual(["raw/old.md", payload.raw_source_ref]);
    expect(entry.rawSourceRefs?.at(-1)).toMatchObject({
      title: "New Source",
      hash: computeContentHash(raw.content),
    });
    expect(payload.version).toBe(2);
    expect(payload.history_ref).toBeDefined();
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-ingest-"));
  cleanupPaths.push(root);
  return root;
}
