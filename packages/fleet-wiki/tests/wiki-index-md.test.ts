import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getIndexMarkdownFile, resolveMemoryPaths } from "../src/paths.js";
import { loadIndex, readWikiEntry, rebuildIndex, renderIndexMarkdown, writeWikiEntry } from "../src/store.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("wiki index markdown", () => {
  it("rebuilds index.json and wiki/index.md together", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry(makeEntry("alpha", "Alpha", ["one"], "Alpha summary line"), paths);
    await rebuildIndex(paths);

    const index = await loadIndex(paths);
    const indexMarkdown = await readFile(getIndexMarkdownFile(paths), "utf8");

    expect(index.alpha?.path).toBe("wiki/alpha.md");
    expect(indexMarkdown).toContain("# Fleet Wiki Index");
    expect(indexMarkdown).toContain("## Entries");
  });

  it("orders entry sections by id ascending", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry(makeEntry("beta", "Beta", [], "Beta line"), paths);
    await writeWikiEntry(makeEntry("alpha", "Alpha", [], "Alpha line"), paths);
    await rebuildIndex(paths);
    const indexMarkdown = await readFile(getIndexMarkdownFile(paths), "utf8");

    expect(indexMarkdown.indexOf("### alpha")).toBeLessThan(indexMarkdown.indexOf("### beta"));
  });

  it("orders tag groups and group members deterministically", async () => {
    const markdown = renderIndexMarkdown([
      makeEntry("beta", "Beta", ["two", "one"], "Beta line"),
      makeEntry("alpha", "Alpha", ["one"], "Alpha line"),
      makeEntry("gamma", "Gamma", [], "Gamma line"),
    ]);

    expect(markdown.indexOf("### one")).toBeLessThan(markdown.indexOf("### two"));
    expect(markdown.indexOf("### two")).toBeLessThan(markdown.indexOf("### (untagged)"));
    expect(markdown.indexOf("- [[wiki:alpha]] — Alpha")).toBeLessThan(markdown.indexOf("- [[wiki:beta]] — Beta"));
  });

  it("does not index wiki/index.md as a normal entry", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry(makeEntry("alpha", "Alpha", [], "Alpha line"), paths);
    await rebuildIndex(paths);
    const index = await loadIndex(paths);

    expect(index.index).toBeUndefined();
  });

  it("does not expose wiki/index.md through readWikiEntry", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry(makeEntry("alpha", "Alpha", [], "Alpha line"), paths);
    await rebuildIndex(paths);

    await expect(readWikiEntry("index", paths)).resolves.toBeNull();
  });

  it("renders byte-for-byte identical index markdown for the same entry set", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry(makeEntry("alpha", "Alpha", ["one"], "Alpha line"), paths);
    await writeWikiEntry(makeEntry("beta", "Beta", [], "Beta line"), paths);

    await rebuildIndex(paths);
    const first = await readFile(getIndexMarkdownFile(paths), "utf8");
    await rebuildIndex(paths);
    const second = await readFile(getIndexMarkdownFile(paths), "utf8");

    expect(second).toBe(first);
  });

  it("includes canonical [[wiki:id]] links in tag sections", async () => {
    const markdown = renderIndexMarkdown([makeEntry("alpha", "Alpha", ["one"], "Alpha line")]);

    expect(markdown).toContain("[[wiki:alpha]]");
  });
});

function makeEntry(id: string, title: string, tags: string[], bodyFirstLine: string) {
  return {
    id,
    title,
    tags,
    created: "2026-05-05T00:00:00.000Z",
    updated: "2026-05-05T00:00:00.000Z",
    version: 1,
    body: `${bodyFirstLine}\n\nAdditional content for deterministic index rendering.`,
    rawSourceRef: `raw/2026-05-05-${id}-source-abcdef12.md`,
  };
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-index-"));
  cleanupPaths.push(root);
  return root;
}
