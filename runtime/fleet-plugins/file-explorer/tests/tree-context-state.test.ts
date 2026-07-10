import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { isCurrentContextRequest } from "../client/tree.js";

describe("FileTree context request guard", () => {
  it("applies a list response only to the context that started it", () => {
    expect(isCurrentContextRequest("theater-a:src", "theater-a:src")).toBe(true);
    expect(isCurrentContextRequest("theater-a:src", "theater-b:src")).toBe(false);
    expect(isCurrentContextRequest("theater-a:src", "theater-a:docs")).toBe(false);
  });

  it("remounts before a new context can render the previous tree result", () => {
    const source = fs.readFileSync(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/<FileTree\s+key=\{contextScope\}/);
  });
});
