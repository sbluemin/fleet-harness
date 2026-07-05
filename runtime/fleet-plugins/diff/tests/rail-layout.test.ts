import { describe, expect, it } from "vitest";

import {
  DIFF_DIVIDER_WIDTH,
  HUNK_PANE_MIN_WIDTH,
  buildDiffGridTemplate,
  clampListPaneWidth,
} from "../client/rail-layout.js";

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

describe("buildDiffGridTemplate", () => {
  it("저장된 우측 폭을 좌측 최소폭 보존 CSS clamp로 감싼다", () => {
    const preservedLeftWidth = HUNK_PANE_MIN_WIDTH + DIFF_DIVIDER_WIDTH;
    expect(buildDiffGridTemplate(568)).toBe(
      `minmax(0, 1fr) ${DIFF_DIVIDER_WIDTH}px minmax(0, min(568px, calc(100% - ${preservedLeftWidth}px)))`,
    );
  });
});
