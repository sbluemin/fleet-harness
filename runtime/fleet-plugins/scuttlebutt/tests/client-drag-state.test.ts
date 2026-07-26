import { describe, expect, it } from "vitest";

import { initialDragState, updateDrag } from "../client/drag-state.js";

describe("Scuttlebutt drag state", () => {
  it("stays pending below the five-pixel Manhattan threshold", () => {
    const down = updateDrag(initialDragState, {
      type: "down",
      pointer: { left: 10, top: 10 },
      origin: { left: 100, top: 120 },
    }).state;
    const moved = updateDrag(down, { type: "move", pointer: { left: 12, top: 12 } });
    expect(moved.state.phase).toBe("pending");
    expect(moved.position).toBeUndefined();
  });

  it("drags at threshold and suppresses exactly the following click", () => {
    let state = updateDrag(initialDragState, {
      type: "down",
      pointer: { left: 10, top: 10 },
      origin: { left: 100, top: 120 },
    }).state;
    const moved = updateDrag(state, { type: "move", pointer: { left: 13, top: 12 } });
    expect(moved.position).toEqual({ left: 103, top: 122 });
    state = updateDrag(moved.state, { type: "up" }).state;
    expect(state).toEqual({ phase: "idle", suppressClick: true });
    state = updateDrag(state, { type: "click" }).state;
    expect(state).toEqual(initialDragState);
  });

  it("does not suppress a click after a pointer press without drag", () => {
    const down = updateDrag(initialDragState, {
      type: "down",
      pointer: { left: 10, top: 10 },
      origin: { left: 100, top: 120 },
    }).state;
    expect(updateDrag(down, { type: "up" }).state).toEqual(initialDragState);
  });
});
