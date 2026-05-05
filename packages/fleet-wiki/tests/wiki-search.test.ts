import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-search-"));
  cleanupPaths.push(root);
  return root;
}
