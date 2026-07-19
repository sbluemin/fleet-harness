// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { dropIndexFromPoint, groupDropIndexFromPoint, reorderGroupIds, reorderTheaterIds, theaterDropIndexFromPoint } from "../core/client/src/sidebar/operations-side-bar-hit-test.js";

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

describe("groupDropIndexFromPoint", () => {
  it("uses section wrapper midpoints and skips the dragged source group", () => {
    const sections = document.createElement("ol");
    sections.append(
      createGroupSection("g-a", 0, 40),
      createGroupSection("g-b", 40, 100),
      createGroupSection("g-c", 100, 150),
    );

    expect(groupDropIndexFromPoint(70, ["g-a", "g-b", "g-c"], sections, "g-b")).toBe(2);
  });

  it("ignores the ungrouped wrapper as a group drop target", () => {
    const sections = document.createElement("ol");
    sections.append(
      createGroupSection("g-a", 0, 40),
      createGroupSection("__ungrouped__", 40, 100),
    );

    expect(groupDropIndexFromPoint(50, ["g-a"], sections)).toBe(1);
  });
});

describe("reorderGroupIds", () => {
  it("moves a group upward", () => {
    expect(reorderGroupIds(["g-a", "g-b", "g-c"], "g-c", 0)).toEqual(["g-c", "g-a", "g-b"]);
  });

  it("moves a group downward with source-inclusive drop index adjustment", () => {
    expect(reorderGroupIds(["g-a", "g-b", "g-c"], "g-a", 3)).toEqual(["g-b", "g-c", "g-a"]);
  });

  it("returns stable order when dropped on itself", () => {
    expect(reorderGroupIds(["g-a", "g-b", "g-c"], "g-b", 1)).toEqual(["g-a", "g-b", "g-c"]);
  });

  it("clamps to first and last positions", () => {
    expect(reorderGroupIds(["g-a", "g-b", "g-c"], "g-b", -10)).toEqual(["g-b", "g-a", "g-c"]);
    expect(reorderGroupIds(["g-a", "g-b", "g-c"], "g-b", 99)).toEqual(["g-a", "g-c", "g-b"]);
  });

  it("keeps a single group unchanged", () => {
    expect(reorderGroupIds(["g-a"], "g-a", 1)).toEqual(["g-a"]);
  });
});

describe("theaterDropIndexFromPoint", () => {
  it("uses Theater section midpoints and skips the dragged source Theater", () => {
    const sections = document.createElement("ol");
    sections.append(
      createTheaterSection("t-a", 0, 40),
      createTheaterSection("t-b", 40, 100),
      createTheaterSection("t-c", 100, 150),
    );

    expect(theaterDropIndexFromPoint(70, ["t-a", "t-b", "t-c"], sections, "t-b")).toBe(2);
  });

  it("returns the final slot below all Theater sections", () => {
    const sections = document.createElement("ol");
    sections.append(createTheaterSection("t-a", 0, 40));

    expect(theaterDropIndexFromPoint(100, ["t-a"], sections)).toBe(1);
  });
});

describe("reorderTheaterIds", () => {
  it("moves a Theater upward", () => {
    expect(reorderTheaterIds(["t-a", "t-b", "t-c"], "t-c", 0)).toEqual(["t-c", "t-a", "t-b"]);
  });

  it("moves a Theater downward with source-inclusive drop index adjustment", () => {
    expect(reorderTheaterIds(["t-a", "t-b", "t-c"], "t-a", 3)).toEqual(["t-b", "t-c", "t-a"]);
  });

  it("keeps a self-drop stable and clamps out-of-range slots", () => {
    expect(reorderTheaterIds(["t-a", "t-b", "t-c"], "t-b", 1)).toEqual(["t-a", "t-b", "t-c"]);
    expect(reorderTheaterIds(["t-a", "t-b", "t-c"], "t-b", -10)).toEqual(["t-b", "t-a", "t-c"]);
    expect(reorderTheaterIds(["t-a", "t-b", "t-c"], "t-b", 99)).toEqual(["t-a", "t-c", "t-b"]);
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

function createGroupSection(id: string, top: number, bottom: number): HTMLElement {
  const section = document.createElement("li");
  section.dataset.dropZoneGroupId = id;
  section.getBoundingClientRect = () => ({
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
  return section;
}

function createTheaterSection(id: string, top: number, bottom: number): HTMLElement {
  const section = document.createElement("li");
  section.dataset.theaterId = id;
  section.getBoundingClientRect = () => ({
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
  return section;
}
