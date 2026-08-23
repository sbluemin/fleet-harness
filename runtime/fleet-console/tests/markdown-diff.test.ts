// @fleet-console/markdown/diff — 브라우저(Cowork·Codex 리더)와 호스트(드라이독
// diffstat)가 공유하는 순수 블록/라인 diff의 계약.
import { describe, expect, it } from "vitest";

import { diffDraftBlocks, diffDraftLines } from "@fleet-console/markdown/diff";

describe("diffDraftBlocks", () => {
  it("marks replaced blocks as removed-then-added and keeps shared blocks", () => {
    const base = "Alpha paragraph.\n\nShared paragraph.";
    const draft = "Beta paragraph.\n\nShared paragraph.\n\nNew paragraph.";
    const blocks = diffDraftBlocks(base, draft);
    expect(blocks.map((block) => block.kind)).toEqual(["removed", "added", "same", "added"]);
    expect(blocks[0]?.markdown).toBe("Alpha paragraph.");
    expect(blocks[1]?.markdown).toBe("Beta paragraph.");
    expect(blocks[3]?.markdown).toBe("New paragraph.");
  });

  it("does not split blocks on blank lines inside code fences", () => {
    const fenced = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    const blocks = diffDraftBlocks(fenced, fenced);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("same");
  });

  it("merges adjacent runs of the same kind", () => {
    const blocks = diffDraftBlocks("", "First.\n\nSecond.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("added");
    expect(blocks[0]?.markdown).toBe("First.\n\nSecond.");
  });
});

describe("diffDraftLines", () => {
  it("flags only changed draft lines", () => {
    const lines = diffDraftLines("one\ntwo\nthree", "one\nedited\nthree");
    expect(lines).toHaveLength(3);
    expect(lines.filter((line) => line.changed).map((line) => line.text)).toEqual(["edited"]);
  });
});
