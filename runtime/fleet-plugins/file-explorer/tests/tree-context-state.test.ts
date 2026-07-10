import { describe, expect, it } from "vitest";

import { isCurrentContextRequest } from "../client/tree.js";

describe("FileTree context request guard", () => {
  it("applies a list response only to the context that started it", () => {
    expect(isCurrentContextRequest("theater-a:src", "theater-a:src")).toBe(true);
    expect(isCurrentContextRequest("theater-a:src", "theater-b:src")).toBe(false);
    expect(isCurrentContextRequest("theater-a:src", "theater-a:docs")).toBe(false);
  });
});
