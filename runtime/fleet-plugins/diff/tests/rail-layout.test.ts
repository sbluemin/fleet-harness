import { describe, expect, it } from "vitest";

import {
  DIFF_DIVIDER_WIDTH,
  HISTORY_DETAIL_PANE_MIN_WIDTH,
  HUNK_PANE_MIN_WIDTH,
  buildDiffGridTemplate,
  buildHistoryGridTemplate,
  buildInspectorChangesGridTemplate,
  buildInspectorDetailsGridTemplate,
  clampSplitPaneSize,
  clampListPaneWidth,
  installPointerDragLifecycle,
} from "../client/rail-layout.js";

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type } as Event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

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

  it("shrinks the Diff panel's right list pane when dragging right", () => {
    expect(clampListPaneWidth({
      startWidth: 360,
      dx: 40,
      containerWidth: 712,
      listPaneMinWidth: 220,
      hunkPaneMinWidth: 140,
      dividerWidth: 4,
    })).toBe(320);
  });

  it("grows the Diff panel's right list pane when dragging left", () => {
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

describe("History detail/list layout", () => {
  it("grows the History panel's left master pane when dragging right", () => {
    expect(clampSplitPaneSize(
      360,
      40,
      712,
      220,
      HISTORY_DETAIL_PANE_MIN_WIDTH,
      DIFF_DIVIDER_WIDTH,
    )).toBe(400);
    expect(clampSplitPaneSize(360, 600, 712, 220, HISTORY_DETAIL_PANE_MIN_WIDTH, DIFF_DIVIDER_WIDTH)).toBe(568);
  });

  it("builds a history grid that preserves the detail pane while honoring the stored list width", () => {
    const preservedDetailWidth = HISTORY_DETAIL_PANE_MIN_WIDTH + DIFF_DIVIDER_WIDTH;
    expect(buildHistoryGridTemplate(360)).toBe(
      `minmax(0, min(360px, calc(100% - ${preservedDetailWidth}px))) ${DIFF_DIVIDER_WIDTH}px minmax(0, 1fr)`,
    );
  });
});

describe("inspector inner dividers", () => {
  it("clamps both header and file-list dividers while preserving their siblings", () => {
    expect(clampSplitPaneSize(176, 400, 500, 120, 120)).toBe(376);
    expect(clampSplitPaneSize(176, -400, 500, 120, 120)).toBe(120);
  });

  it("builds the vertical and horizontal inspector templates", () => {
    expect(buildInspectorDetailsGridTemplate(176)).toContain("176px");
    expect(buildInspectorChangesGridTemplate(150)).toContain("150px");
  });
});

describe("installPointerDragLifecycle", () => {
  it.each(["pointerup", "pointercancel"])("cleans every listener and finishes once on %s", (terminalEvent) => {
    const documentTarget = new FakeEventTarget();
    const windowTarget = new FakeEventTarget();
    let moves = 0;
    let finishes = 0;

    installPointerDragLifecycle({ documentTarget, windowTarget, onMove: () => { moves += 1; }, onFinish: () => { finishes += 1; } });
    documentTarget.dispatch("pointermove");
    documentTarget.dispatch(terminalEvent);
    documentTarget.dispatch("pointermove");
    documentTarget.dispatch("pointerup");
    windowTarget.dispatch("blur");

    expect(moves).toBe(1);
    expect(finishes).toBe(1);
    expect(documentTarget.listenerCount("pointermove")).toBe(0);
    expect(documentTarget.listenerCount("pointerup")).toBe(0);
    expect(documentTarget.listenerCount("pointercancel")).toBe(0);
    expect(windowTarget.listenerCount("blur")).toBe(0);
  });

  it("finishes and removes listeners when the window blurs", () => {
    const documentTarget = new FakeEventTarget();
    const windowTarget = new FakeEventTarget();
    let finishes = 0;

    installPointerDragLifecycle({ documentTarget, windowTarget, onMove: () => {}, onFinish: () => { finishes += 1; } });
    windowTarget.dispatch("blur");

    expect(finishes).toBe(1);
    expect(documentTarget.listenerCount("pointermove")).toBe(0);
    expect(windowTarget.listenerCount("blur")).toBe(0);
  });

  it("removes listeners without finishing when disposed during unmount", () => {
    const documentTarget = new FakeEventTarget();
    const windowTarget = new FakeEventTarget();
    let moves = 0;
    let finishes = 0;

    const dispose = installPointerDragLifecycle({ documentTarget, windowTarget, onMove: () => { moves += 1; }, onFinish: () => { finishes += 1; } });
    dispose();
    documentTarget.dispatch("pointermove");
    documentTarget.dispatch("pointercancel");
    windowTarget.dispatch("blur");

    expect(moves).toBe(0);
    expect(finishes).toBe(0);
    expect(documentTarget.listenerCount("pointermove")).toBe(0);
    expect(windowTarget.listenerCount("blur")).toBe(0);
  });
});
