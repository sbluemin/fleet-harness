import { describe, expect, it } from "vitest";

import { nextOperationId } from "../core/client/src/store.js";

describe("nextOperationId — Alt+←/→ focus cycle", () => {
  const order = ["a", "b", "c"];

  it("moves to the next operation, wrapping past the end", () => {
    expect(nextOperationId(order, "a", 1)).toBe("b");
    expect(nextOperationId(order, "b", 1)).toBe("c");
    expect(nextOperationId(order, "c", 1)).toBe("a");
  });

  it("moves to the previous operation, wrapping past the start", () => {
    expect(nextOperationId(order, "c", -1)).toBe("b");
    expect(nextOperationId(order, "b", -1)).toBe("a");
    expect(nextOperationId(order, "a", -1)).toBe("c");
  });

  it("starts from an edge when nothing (or an unknown id) is active", () => {
    expect(nextOperationId(order, null, 1)).toBe("a");
    expect(nextOperationId(order, null, -1)).toBe("c");
    expect(nextOperationId(order, "missing", 1)).toBe("a");
  });

  it("stays on the only operation and returns null when there are none", () => {
    expect(nextOperationId(["solo"], "solo", 1)).toBe("solo");
    expect(nextOperationId(["solo"], "solo", -1)).toBe("solo");
    expect(nextOperationId([], "a", 1)).toBeNull();
  });
});
