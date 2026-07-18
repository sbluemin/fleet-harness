// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { diffDraftLines } from "../core/client/src/codex/cowork-diff.js";
import { renderMarkdown } from "@fleet-console/markdown/core";

describe("Cowork studio primitives", () => {
  it("marks inserted and replaced draft lines", () => {
    expect(diffDraftLines("one\ntwo", "one\nthree\nfour")).toEqual([
      { text: "one", changed: false }, { text: "three", changed: true }, { text: "four", changed: true },
    ]);
  });

  it("renders untrusted draft markdown through the sanitizer", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n\n# Safe").html;
    expect(html).not.toContain("<script");
    expect(html).toContain("Safe");
  });
});
