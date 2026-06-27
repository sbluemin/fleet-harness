// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { dropIndexFromPoint } from "../core/client/src/sidebar/operations-side-bar-hit-test.js";

describe("operations side bar reorder hit testing", () => {
  it("ignores the dragged source chip when resolving the drop index", () => {
    const chips = document.createElement("ol");
    const source = createChip("op-a", 10, 50);
    const target = createChip("op-b", 60, 100);
    chips.append(source, target);

    expect(dropIndexFromPoint(25, ["op-a", "op-b"], chips, "op-a")).toBe(1);
  });

  it("returns 0 when dragging above the first non-source chip", () => {
    const chips = document.createElement("ol");
    const source = createChip("op-a", 100, 140);
    const target = createChip("op-b", 10, 50);
    chips.append(target, source);

    expect(dropIndexFromPoint(12, ["op-b", "op-a"], chips, "op-a")).toBe(0);
  });

  it("returns total length when dragging below all chips", () => {
    const chips = document.createElement("ol");
    const chipA = createChip("op-a", 10, 50);
    const chipB = createChip("op-b", 60, 100);
    chips.append(chipA, chipB);

    expect(dropIndexFromPoint(999, ["op-a", "op-b"], chips)).toBe(2);
  });
});

function createChip(id: string, top: number, bottom: number): HTMLElement {
  const chip = document.createElement("li");
  chip.dataset.sideBarChipId = id;
  chip.getBoundingClientRect = () => ({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 200,
    bottom,
    width: 200,
    height: bottom - top,
    toJSON: () => ({}),
  });
  return chip;
}
