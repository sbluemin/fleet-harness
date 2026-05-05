import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { briefingQuery } from "../src/briefing.js";
import { enhancedSearch } from "../src/search.js";
import { resolveMemoryPaths } from "../src/paths.js";
import { writeWikiEntry } from "../src/store.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("wiki enhanced search", () => {
  it("adds enhanced score, graph boost, and alias-driven ranking deterministically", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry({
      id: "apollo-core",
      title: "Mission Planning",
      tags: ["ops"],
      created: "2026-05-01T00:00:00.000Z",
      updated: "2026-05-04T00:00:00.000Z",
      version: 1,
      aliases: ["apollo"],
      status: "current",
      confidence: "high",
      related: ["beta"],
      body: "Apollo planning body with [[wiki:beta]] and extra body terms.",
    }, paths);
    await writeWikiEntry({
      id: "beta",
      title: "Apollo Operations",
      tags: ["ops"],
      created: "2026-05-01T00:00:00.000Z",
      updated: "2026-05-03T00:00:00.000Z",
      version: 1,
      body: "[[wiki:apollo-core]] operational backlink",
    }, paths);
    await writeWikiEntry({
      id: "apollo-archive",
      title: "Archive",
      tags: ["ops"],
      created: "2026-05-01T00:00:00.000Z",
      updated: "2026-05-02T00:00:00.000Z",
      version: 1,
      aliases: ["apollo"],
      status: "deprecated",
      body: "Deprecated archive entry",
    }, paths);

    const hits = await enhancedSearch(paths, {
      topic: "apollo",
      limit: 5,
      now: new Date("2026-05-05T00:00:00.000Z"),
    });

    expect(hits[0]?.id).toBe("apollo-core");
    expect(hits[0]?.enhanced_score).toBeTypeOf("number");
    expect(hits[0]?.graph_boost).toBeGreaterThan(0);
    expect(hits[0]?.matchedFields).toEqual(expect.arrayContaining(["alias", "confidence", "graph", "status_rank"]));
    expect(hits[0]?.matchedSnippets?.some((item) => item.field === "alias")).toBe(true);
    expect(hits[1]?.id).toBe("apollo-archive");
    expect(hits[2]?.id).toBe("beta");
  });

  it("shares lexical admission with default briefing for multi-word and hyphenated queries", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry({
      id: "fleet-wiki-tools",
      title: "Fleet Wiki operator guide",
      tags: ["docs"],
      created: "2026-05-05T00:00:00.000Z",
      updated: "2026-05-05T00:00:03.000Z",
      version: 1,
      body: "This page explains fleet wiki workflows and tools usage across resolve, query, and briefing.",
    }, paths);
    await writeWikiEntry({
      id: "flow-citations",
      title: "Read flow and write flow",
      tags: ["docs"],
      created: "2026-05-05T00:00:00.000Z",
      updated: "2026-05-05T00:00:02.000Z",
      version: 1,
      body: "Citation flow is covered here for query, resolve, and provenance handling.",
    }, paths);
    await writeWikiEntry({
      id: "nine-tool-suite",
      title: "The 9 tool suite",
      tags: ["docs"],
      created: "2026-05-05T00:00:00.000Z",
      updated: "2026-05-05T00:00:01.000Z",
      version: 1,
      body: "Tool suite overview for the Fleet Wiki package.",
    }, paths);

    const defaultHits = await briefingQuery(paths, { topic: "fleet-wiki tools", limit: 5 });
    const enhancedHits = await enhancedSearch(paths, { topic: "fleet-wiki tools", limit: 5 });
    const hyphenHits = await enhancedSearch(paths, { topic: "9-tool-suite", limit: 5 });

    expect(defaultHits[0]?.id).toBe("fleet-wiki-tools");
    expect(enhancedHits[0]?.id).toBe(defaultHits[0]?.id);
    expect(enhancedHits[0]?.matchedFields).toEqual(expect.arrayContaining(["body", "bm25"]));
    expect(enhancedHits[0]?.matchedSnippets?.length).toBeGreaterThan(0);
    expect(hyphenHits[0]?.id).toBe("nine-tool-suite");
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-search-"));
  cleanupPaths.push(root);
  return root;
}
