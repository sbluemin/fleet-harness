// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { dropIndexFromPoint } from "../core/client/src/canvas/canvas-dock-hit-test.js";

describe("canvas dock reorder hit testing", () => {
  it("ignores the dragged source chip when resolving the drop index", () => {
    const chips = document.createElement("div");
    const source = createChip("op-a", 120, 220);
    const target = createChip("op-b", 240, 340);
    chips.append(source, target);

    expect(dropIndexFromPoint(150, ["op-a", "op-b"], chips, "op-a")).toBe(1);
  });
});

function createChip(id: string, left: number, right: number): HTMLElement {
  const chip = document.createElement("div");
  chip.dataset.dockChipId = id;
  chip.getBoundingClientRect = () => ({
    x: left,
    y: 0,
    top: 0,
    left,
    right,
    bottom: 24,
    width: right - left,
    height: 24,
    toJSON: () => ({}),
  });
  return chip;
}
