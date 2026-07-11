import { describe, expect, it } from "vitest";

import {
  DIFF_DIVIDER_WIDTH,
  HISTORY_DETAIL_PANE_MIN_WIDTH,
  HUNK_PANE_MIN_WIDTH,
  buildDiffGridTemplate,
  buildHistoryGridTemplate,
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

describe("History detail/list layout", () => {
  it("clamps the history list to preserve the detail pane minimum", () => {
    expect(clampListPaneWidth({
      startWidth: 360,
      dx: -600,
      containerWidth: 712,
      listPaneMinWidth: 220,
      hunkPaneMinWidth: HISTORY_DETAIL_PANE_MIN_WIDTH,
      dividerWidth: DIFF_DIVIDER_WIDTH,
    })).toBe(568);
  });

  it("builds a history grid that preserves the detail pane while honoring the stored list width", () => {
    const preservedDetailWidth = HISTORY_DETAIL_PANE_MIN_WIDTH + DIFF_DIVIDER_WIDTH;
    expect(buildHistoryGridTemplate(360)).toBe(
      `minmax(0, 1fr) ${DIFF_DIVIDER_WIDTH}px minmax(0, min(360px, calc(100% - ${preservedDetailWidth}px)))`,
    );
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
