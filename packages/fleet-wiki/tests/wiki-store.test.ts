import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getIndexMarkdownFile, resolveMemoryPaths } from "../src/paths.js";
import {
  computeContentHash,
  loadIndex,
  readPatchFile,
  readRawSourceEntry,
  readWikiEntry,
  rebuildIndex,
  stripLeadingFrontmatter,
  writeRawSourceEntry,
  writeWikiEntry,
} from "../src/store.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("wiki store", () => {
  it("round-trips wiki entries and rebuilds the index", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry({
      id: "alpha",
      title: "Alpha",
      tags: ["one"],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      templateId: "guide",
      rawSourceRef: "raw/2026-04-26-alpha-source.md",
      aliases: ["Project Apollo", "Launch Notes"],
      type: "decision",
      status: "current",
      confidence: "high",
      owner: "ops-team",
      language: "en",
      revalidateAfter: "2026-06-01T00:00:00.000Z",
      supersedes: ["apollo-v0"],
      related: ["launch-checklist"],
      rawSourceRefs: [
        { ref: "raw/2026-04-26-alpha-source-aaaaaaaa.md", title: "Alpha Source", hash: "aaaaaaaa" },
        { ref: "raw/2026-04-26-alpha-source-bbbbbbbb.md" },
      ],
      body: "hello world",
    }, paths);

    await rebuildIndex(paths);

    const wiki = await readWikiEntry("alpha", paths);
    const index = await loadIndex(paths);
    const indexMarkdown = await readFile(getIndexMarkdownFile(paths), "utf8");

    expect(wiki?.title).toBe("Alpha");
    expect(wiki?.templateId).toBe("guide");
    expect(wiki?.rawSourceRef).toBe("raw/2026-04-26-alpha-source.md");
    expect(wiki?.aliases).toEqual(["Project Apollo", "Launch Notes"]);
    expect(wiki?.type).toBe("decision");
    expect(wiki?.status).toBe("current");
    expect(wiki?.confidence).toBe("high");
    expect(wiki?.owner).toBe("ops-team");
    expect(wiki?.language).toBe("en");
    expect(wiki?.revalidateAfter).toBe("2026-06-01T00:00:00.000Z");
    expect(wiki?.supersedes).toEqual(["apollo-v0"]);
    expect(wiki?.related).toEqual(["launch-checklist"]);
    expect(wiki?.rawSourceRefs).toEqual([
      { ref: "raw/2026-04-26-alpha-source-aaaaaaaa.md", title: "Alpha Source", hash: "aaaaaaaa" },
      { ref: "raw/2026-04-26-alpha-source-bbbbbbbb.md", title: undefined, hash: undefined },
    ]);
    expect(index.alpha?.path).toBe("wiki/alpha.md");
    expect(index.alpha?.type).toBe("decision");
    expect(index.alpha?.status).toBe("current");
    expect(index.alpha?.confidence).toBe("high");
    expect(index.alpha?.aliases).toEqual(["Project Apollo", "Launch Notes"]);
    expect(indexMarkdown).toContain("- type: `decision`");
    expect(indexMarkdown).toContain("- status: `current`");
    expect(indexMarkdown).toContain("- confidence: `high`");
    expect(indexMarkdown).toContain("- aliases: `Project Apollo, Launch Notes`");
    expect(indexMarkdown).toContain("- raw_source_ref: `raw/2026-04-26-alpha-source.md`");
    expect(indexMarkdown).toContain("- raw_source_refs: `raw/2026-04-26-alpha-source-aaaaaaaa.md, raw/2026-04-26-alpha-source-bbbbbbbb.md`");
  });

  it("creates the expanded local layout and stores raw source material", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const content = "immutable source";
    const expectedHash = computeContentHash(content);

    const rawRef = await writeRawSourceEntry({
      id: "alpha-source",
      created: "2026-04-26T00:00:00.000Z",
      sourceType: "inline",
      title: "Alpha Source",
      tags: ["one"],
      content,
    }, paths);

    const rawContent = await readPatchFile(path.join(paths.root, rawRef));
    const rawEntry = await readRawSourceEntry(rawRef, paths);

    expect(paths.rawDir.endsWith(path.join(".fleet/knowledge", "raw"))).toBe(true);
    expect(paths.schemaDir.endsWith(path.join(".fleet/knowledge", "schema"))).toBe(true);
    expect(paths.conflictsDir.endsWith(path.join(".fleet/knowledge", "conflicts"))).toBe(true);
    expect(rawRef).toBe(`raw/2026-04-26-alpha-source-${expectedHash}.md`);
    expect(rawContent).toContain("immutable source");
    expect(rawContent).toContain(`contentHash: "${expectedHash}"`);
    expect(rawEntry.contentHash).toBe(expectedHash);
    expect(rawEntry.content).toBe(content);
  });

  it("rejects unsafe IDs before writing workspace-local files", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await expect(writeRawSourceEntry({
      id: "../escape",
      created: "2026-04-26T00:00:00.000Z",
      sourceType: "inline",
      tags: [],
      content: "bad",
    }, paths)).rejects.toThrow(/unsafe wiki id/);
  });

  it("leaves no partial temp files after repeated writes", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const entry = {
      id: "race",
      title: "Race",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: "v1",
    };

    await Promise.all([
      writeWikiEntry(entry, paths),
      writeWikiEntry({ ...entry, body: "v2", updated: "2026-04-26T00:00:01.000Z" }, paths),
    ]);

    const files = await readdir(paths.wikiDir);
    expect(files.some((name) => name.startsWith(".tmp-"))).toBe(false);
  });

  it("escapes frontmatter control characters without changing logical values", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const title = "Alpha \"Quoted\"\nLine";
    const tag = "tag\\slash\rreturn";
    const proposer = "tool:\"wiki\"\noperator";

    await writeWikiEntry({
      id: "escape-alpha",
      title,
      tags: [tag],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      rawSourceRef: "raw/escape.md",
      body: "safe body",
    }, paths);

    const wikiFile = await readFile(path.join(paths.wikiDir, "escape-alpha.md"), "utf8");
    const rawRef = await writeRawSourceEntry({
      id: "escape-source",
      created: "2026-04-26T00:00:00.000Z",
      sourceType: "inline",
      title,
      tags: [tag],
      content: proposer,
    }, paths);
    const rawFile = await readFile(path.join(paths.root, rawRef), "utf8");
    const wiki = await readWikiEntry("escape-alpha", paths);

    expect(wikiFile).toContain('title: "Alpha \\"Quoted\\"\\nLine"');
    expect(wikiFile).toContain('tags: ["tag\\\\slash\\rreturn"]');
    expect(rawFile).toContain('title: "Alpha \\"Quoted\\"\\nLine"');
    expect(rawFile).toContain('tags: ["tag\\\\slash\\rreturn"]');
    expect(rawFile).toContain('---\ntool:"wiki"\noperator');
    expect(wiki?.title).toBe(title);
    expect(wiki?.tags).toEqual([tag]);
  });

  it("preserves literal backslash escape sequences across wiki round-trip", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    // backslash + n/r/" 같은 literal escape 시퀀스가 디코드 단계에서 실제
    // 제어문자로 변형되지 않고 원본 그대로 보존되는지 검증한다.
    const title = "literal \\n stays \\r same";
    const tag = "double\\\\back";

    await writeWikiEntry({
      id: "literal-escape",
      title,
      tags: [tag],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      rawSourceRef: "raw/literal.md",
      body: "literal body",
    }, paths);

    const wiki = await readWikiEntry("literal-escape", paths);

    expect(wiki?.title).toBe(title);
    expect(wiki?.tags).toEqual([tag]);
  });

  it("strips duplicate leading frontmatter from wiki bodies at write time", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry({
      id: "frontmatter-body",
      title: "Frontmatter Body",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: "---\nid: \"frontmatter-body\"\ntitle: \"Duplicate\"\n---\nclean body",
    }, paths);

    const wikiFile = await readFile(path.join(paths.wikiDir, "frontmatter-body.md"), "utf8");
    const wiki = await readWikiEntry("frontmatter-body", paths);

    expect(wikiFile).not.toContain("\n---\nid: \"frontmatter-body\"");
    expect(wiki?.body).toBe("clean body");
  });

  it("strips block-style duplicate leading frontmatter from wiki bodies", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry({
      id: "block-frontmatter-body",
      title: "Block Frontmatter Body",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: [
        "---",
        "id: block-frontmatter-body",
        'title: "Block Duplicate"',
        "tags:",
        "  - fleet-core",
        "  - fleet-infra",
        "feature_area: architecture",
        "---",
        "clean body",
      ].join("\n"),
    }, paths);

    const wiki = await readWikiEntry("block-frontmatter-body", paths);

    expect(wiki?.body).toBe("clean body");
  });

  it("strips multiple duplicate leading frontmatter blocks from wiki bodies", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await writeWikiEntry({
      id: "triple-frontmatter-body",
      title: "Triple Frontmatter Body",
      tags: [],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: [
        "---",
        'id: "triple-frontmatter-body"',
        'title: "Duplicate One"',
        "---",
        "---",
        'id: "triple-frontmatter-body"',
        'title: "Duplicate Two"',
        "---",
        "clean body",
      ].join("\n"),
    }, paths);

    const wiki = await readWikiEntry("triple-frontmatter-body", paths);

    expect(wiki?.body).toBe("clean body");
  });

  it("does not strip a markdown horizontal rule from wiki bodies", async () => {
    const body = "---\n\nThis body intentionally starts after a thematic break.";

    expect(stripLeadingFrontmatter(body)).toBe(body);
  });

  it("does not strip leading YAML-like body content without an id", async () => {
    const body = "---\ntitle: Example\n---\nExample body";

    expect(stripLeadingFrontmatter(body)).toBe(body);
  });

  it("does not strip indented YAML-like body content without an id", async () => {
    const body = [
      "---",
      "title: Example",
      "tags:",
      "  - example",
      "---",
      "Example body",
    ].join("\n");

    expect(stripLeadingFrontmatter(body)).toBe(body);
  });

  it("does not strip leading fenced content when prose is mixed into the block", async () => {
    const body = [
      "---",
      "id: content-example",
      "title: Content Example",
      "This line is prose, not YAML frontmatter.",
      "---",
      "Example body",
    ].join("\n");

    expect(stripLeadingFrontmatter(body)).toBe(body);
  });

  it("rewrites normal wiki entries idempotently", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const entry = {
      id: "idempotent-entry",
      title: "Idempotent Entry",
      tags: ["stable"],
      created: "2026-04-26T00:00:00.000Z",
      updated: "2026-04-26T00:00:00.000Z",
      version: 1,
      body: "stable body",
    };

    await writeWikiEntry(entry, paths);
    const firstContent = await readFile(path.join(paths.wikiDir, "idempotent-entry.md"), "utf8");
    const roundTrippedEntry = await readWikiEntry("idempotent-entry", paths);
    expect(roundTrippedEntry).not.toBeNull();
    await writeWikiEntry(roundTrippedEntry!, paths);
    const secondContent = await readFile(path.join(paths.wikiDir, "idempotent-entry.md"), "utf8");

    expect(secondContent).toBe(firstContent);
  });

  it("preserves leading frontmatter-like text in raw source content", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const content = "---\nid: \"raw-source\"\ntitle: \"Raw Source\"\n---\nsource body";

    const rawRef = await writeRawSourceEntry({
      id: "frontmatter-raw-source",
      created: "2026-04-26T00:00:00.000Z",
      sourceType: "inline",
      tags: [],
      content,
    }, paths);
    const rawEntry = await readRawSourceEntry(rawRef, paths);

    expect(rawEntry.content).toBe(content);
  });

  it("dedupes raw source paths for identical content on the same day", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const entry = {
      id: "dedupe-source",
      created: "2026-04-26T00:00:00.000Z",
      sourceType: "inline" as const,
      title: "Dedupe",
      tags: ["one"],
      content: "same content",
    };

    const firstRef = await writeRawSourceEntry(entry, paths);
    const secondRef = await writeRawSourceEntry(entry, paths);

    expect(firstRef).toBe(secondRef);
  });

  it("writes distinct raw source files for different content on the same day", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    const firstRef = await writeRawSourceEntry({
      id: "collision-source",
      created: "2026-04-26T00:00:00.000Z",
      sourceType: "inline",
      title: "Collision",
      tags: [],
      content: "first content",
    }, paths);
    const secondRef = await writeRawSourceEntry({
      id: "collision-source",
      created: "2026-04-26T12:34:56.000Z",
      sourceType: "inline",
      title: "Collision",
      tags: [],
      content: "second content",
    }, paths);

    expect(firstRef).not.toBe(secondRef);
    expect(await readPatchFile(path.join(paths.root, firstRef))).toContain("first content");
    expect(await readPatchFile(path.join(paths.root, secondRef))).toContain("second content");
  });

  it("parses legacy raw source files without hash suffix or contentHash frontmatter", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const legacyRef = "raw/2026-04-26-legacy-source.md";

    await mkdir(paths.rawDir, { recursive: true });
    await writeFile(path.join(paths.root, legacyRef), `---\nid: "legacy-source"\ncreated: "2026-04-26T00:00:00.000Z"\nsourceType: "inline"\ntitle: "Legacy"\ntags: ["one"]\n---\nlegacy body`, "utf8");

    const legacyEntry = await readRawSourceEntry(legacyRef, paths);

    expect(legacyEntry.id).toBe("legacy-source");
    expect(legacyEntry.contentHash).toBeUndefined();
    expect(legacyEntry.content).toBe("legacy body");
  });

  it("parses legacy wiki entries without new optional frontmatter fields", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await mkdir(paths.wikiDir, { recursive: true });
    await writeFile(
      path.join(paths.wikiDir, "legacy.md"),
      `---\nid: "legacy"\ntitle: "Legacy"\ntags: ["one"]\ncreated: "2026-04-26T00:00:00.000Z"\nupdated: "2026-04-26T00:00:00.000Z"\nversion: 1\n---\nlegacy body`,
      "utf8",
    );

    const entry = await readWikiEntry("legacy", paths);

    expect(entry?.id).toBe("legacy");
    expect(entry?.aliases).toBeUndefined();
    expect(entry?.type).toBeUndefined();
    expect(entry?.rawSourceRefs).toBeUndefined();
  });
  it("rejects reserved wiki id 'index' to protect generated catalog", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await expect(
      writeWikiEntry({
        id: "index",
        title: "Index",
        tags: [],
        created: "2026-04-26T00:00:00.000Z",
        updated: "2026-04-26T00:00:00.000Z",
        version: 1,
        body: "should be rejected",
      }, paths),
    ).rejects.toThrow(/reserved wiki id: index/);
  });

  it("rejects raw source refs that escape raw/", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    await mkdir(paths.rawDir, { recursive: true });
    await writeFile(path.join(paths.root, "outside.md"), "---\nid: x\n---\noutside", "utf8");

    await expect(readRawSourceEntry("../outside.md", paths)).rejects.toThrow(/raw source ref escapes raw\//);
    await expect(readRawSourceEntry("/etc/passwd", paths)).rejects.toThrow(/raw source ref escapes raw\//);
  });

  it("falls back to recursive scan when index.json drifts and entry lives under nested namespace", async () => {
    // Sentinel 회귀: wiki/queries/*, wiki/sources/* 같은 nested entry 가 index.json 의 stale/missing
    // 상태에서도 readWikiEntry 로 복구 가능해야 한다.
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const queriesDir = path.join(paths.wikiDir, "queries");
    await mkdir(queriesDir, { recursive: true });
    const queryEntry = `---\nid: "alpha-answer"\ntitle: "Alpha answer"\ntags: []\ncreated: "2026-05-05T00:00:00.000Z"\nupdated: "2026-05-05T00:00:00.000Z"\nversion: 1\n---\nbody`;
    await writeFile(path.join(queriesDir, "alpha-answer.md"), queryEntry, "utf8");

    // index.json 은 stale (entry 없음).
    const got = await readWikiEntry("alpha-answer", paths);

    expect(got).not.toBeNull();
    expect(got?.id).toBe("alpha-answer");
    expect(got?.title).toBe("Alpha answer");
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-store-"));
  cleanupPaths.push(root);
  return root;
}
