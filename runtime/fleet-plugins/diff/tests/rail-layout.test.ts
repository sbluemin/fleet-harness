import { describe, expect, it } from "vitest";

import { clampListPaneWidth } from "../client/rail-layout.js";

describe("clampListPaneWidth", () => {
  it("keeps the right list pane at its px width when the divider does not move", () => {
    expect(clampListPaneWidth({
      startWidth: 248,
      dx: 0,
      containerWidth: 712,
      listPaneMinWidth: 220,
      hunkPaneMinWidth: 140,
      dividerWidth: 4,
    })).toBe(248);
  });

  it("clamps the right list pane to its minimum when dragging right", () => {
    expect(clampListPaneWidth({
      startWidth: 248,
      dx: 400,
      containerWidth: 712,
      listPaneMinWidth: 220,
      hunkPaneMinWidth: 140,
      dividerWidth: 4,
    })).toBe(220);
  });

  it("grows the right list pane by negative drag delta up to the hunk minimum", () => {
    expect(clampListPaneWidth({
      startWidth: 248,
      dx: -500,
      containerWidth: 712,
      listPaneMinWidth: 220,
      hunkPaneMinWidth: 140,
      dividerWidth: 4,
    })).toBe(568);
  });

  it("returns null when minimum panes cannot fit", () => {
    expect(clampListPaneWidth({
      startWidth: 248,
      dx: 12,
      containerWidth: 320,
      listPaneMinWidth: 220,
      hunkPaneMinWidth: 140,
      dividerWidth: 4,
    })).toBeNull();
  });
});
