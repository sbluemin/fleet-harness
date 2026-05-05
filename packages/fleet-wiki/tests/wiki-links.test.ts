import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractLegacyMarkdownWikiLinks,
  extractMarkdownLinkTargets,
  extractWikiLinks,
  replaceWikiLinksWithMarkdown,
} from "../src/links.js";

describe("wiki links", () => {
  it("extracts canonical wiki links with occurrence order", () => {
    expect(extractWikiLinks("See [[wiki:alpha]] and [[wiki:beta.two]] and [[wiki:alpha]].")).toEqual([
      "alpha",
      "beta.two",
      "alpha",
    ]);
  });

  it("trims whitespace in canonical wiki links", () => {
    expect(extractWikiLinks("See [[wiki: alpha ]].")).toEqual(["alpha"]);
  });

  it("extracts raw markdown link targets", () => {
    expect(extractMarkdownLinkTargets("See [Alpha](alpha.md) and [Beta](nested/beta.md#part).")).toEqual([
      "alpha.md",
      "nested/beta.md#part",
    ]);
  });

  it("extracts safe relative markdown wiki links", () => {
    const wikiDir = "/tmp/wiki";
    const basePath = path.join(wikiDir, "nested", "beta.md");
    expect(extractLegacyMarkdownWikiLinks(
      "See [Alpha](../alpha.md) and [Gamma](gamma.md#part).",
      wikiDir,
      basePath,
    )).toEqual([
      { target: "../alpha.md", entryId: "alpha" },
      { target: "gamma.md#part", entryId: "gamma" },
    ]);
  });

  it("ignores external scheme, fragment-only, absolute path, and traversal markdown targets", () => {
    const wikiDir = "/tmp/wiki";
    const basePath = path.join(wikiDir, "beta.md");
    expect(extractLegacyMarkdownWikiLinks(
      [
        "[External](https://example.com/alpha.md)",
        "[Mail](mailto:test@example.com)",
        "[Fragment](#section)",
        "[Absolute](/tmp/wiki/alpha.md)",
        "[Traversal](../outside.md)",
      ].join(" "),
      wikiDir,
      basePath,
    )).toEqual([]);
  });

  it("replaces canonical wiki links with markdown fallback links", () => {
    expect(replaceWikiLinksWithMarkdown("See [[wiki:alpha]].")).toBe("See [alpha](#fleet-wiki:alpha).");
  });
});
