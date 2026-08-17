// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hasVisibleCanvasContent, OperationsCanvasEmptyState } from "../core/client/src/canvas/operations-canvas-empty-state.js";
import type { OperationNode } from "../core/client/src/types.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("Operations Canvas empty state", () => {
  it("treats a Theater with only minimized Operations as empty canvas content", () => {
    const operations = [operation("first", "First", 1), operation("second", "Second", 2)];

    expect(hasVisibleCanvasContent(operations, new Set(["first", "second"]))).toBe(false);
    expect(hasVisibleCanvasContent(operations, new Set(["first"]))).toBe(true);
  });

  it("keeps the no-Theater guidance as the only message", () => {
    renderEmptyState({ activeTheaterId: null, operations: [] });

    expect(container?.textContent).toBe("Add a Theater from the sidebar to start operations.");
    expect(container?.querySelector("[data-canvas-blocker]")).not.toBeNull();
    expect(container?.querySelector("button")).toBeNull();
  });

  it("offers the launch action and shortcuts when the Theater has no Operations", () => {
    const onNewOperation = vi.fn();
    renderEmptyState({ activeTheaterId: "theater-a", operations: [], onNewOperation });

    expect(container?.querySelector(".operations-canvas-empty-headline")?.textContent).toBe("Launch your first operation");
    expect(container?.querySelector(".operations-canvas-empty-ghost")).toBeNull();
    expect(container?.querySelector(".operations-canvas-empty-hints")?.textContent).toBe("⌘K Search · Alt+F Tactical · Alt+S Status board · Alt+T War Room");
    expect(container?.querySelector(".operations-canvas-empty-guide")?.textContent).toBe("Shift-drag to create a Shell. Right-click for actions. Drag to pan; scroll to zoom.");

    const launch = container?.querySelector<HTMLButtonElement>('[aria-label="New Operation in Alpha"]');
    expect(launch?.textContent).toBe("+ New Operation");
    act(() => launch?.click());
    expect(onNewOperation).toHaveBeenCalledTimes(1);
  });

  it("shows every standby Operation in recency order and opens the selected one", () => {
    const onOpenOperation = vi.fn();
    renderEmptyState({
      activeTheaterId: "theater-a",
      operations: [
        operation("old", "Old watch", 10),
        operation("newest", "Newest watch", 30),
        operation("middle", "Middle watch", 20),
      ],
      onOpenOperation,
    });

    expect(container?.querySelector(".operations-canvas-empty-ghost")?.textContent).toBe("3 operations standing by");
    const chips = Array.from(container?.querySelectorAll<HTMLButtonElement>(".operations-canvas-empty-standby-chip") ?? []);
    expect(chips).toHaveLength(3);
    expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual([
      "Open operation Newest watch",
      "Open operation Middle watch",
      "Open operation Old watch",
    ]);
    expect(chips.map((chip) => chip.querySelector(".operations-canvas-empty-standby-open")?.textContent)).toEqual(["OPEN", "OPEN", "OPEN"]);

    act(() => chips[1]?.click());
    expect(onOpenOperation).toHaveBeenCalledWith("middle");
  });

  it("renders a relative last-activity time on each standby chip", () => {
    renderEmptyState({
      activeTheaterId: "theater-a",
      operations: [operation("recent", "Recent watch", Date.now() - 12 * 60_000)],
    });

    const time = container?.querySelector(".operations-canvas-empty-standby-time");
    expect(time?.textContent).toBe("12 minutes ago");
  });

  it("caps the standby list with the scroll modifier beyond four Operations", () => {
    const five = [1, 2, 3, 4, 5].map((index) => operation(`op-${index}`, `Watch ${index}`, index));
    const four = five.slice(0, 4);

    renderEmptyState({ activeTheaterId: "theater-a", operations: five });
    expect(container?.querySelector(".operations-canvas-empty-standby--scroll")).not.toBeNull();

    renderEmptyState({ activeTheaterId: "theater-a", operations: four });
    expect(container?.querySelector(".operations-canvas-empty-standby--scroll")).toBeNull();
  });

  it("opens all standby Operations at once without arming at or under the confirm threshold", () => {
    const onOpenAll = vi.fn();
    renderEmptyState({
      activeTheaterId: "theater-a",
      operations: [
        operation("old", "Old watch", 10),
        operation("newest", "Newest watch", 30),
        operation("middle", "Middle watch", 20),
      ],
      onOpenAll,
    });

    const openAll = container?.querySelector<HTMLButtonElement>(".operations-canvas-empty-open-all");
    expect(openAll?.textContent).toBe("Open all in Tactical");
    act(() => openAll?.click());
    expect(onOpenAll).toHaveBeenCalledWith(["newest", "middle", "old"]);
  });

  it("hides the bulk action for a single standby Operation", () => {
    renderEmptyState({
      activeTheaterId: "theater-a",
      operations: [operation("solo", "Solo", 1)],
    });

    expect(container?.querySelector(".operations-canvas-empty-open-all")).toBeNull();
  });

  it("arms the bulk action beyond the confirm threshold and fires on the second click", () => {
    vi.useFakeTimers();
    try {
      const onOpenAll = vi.fn();
      const nine = Array.from({ length: 9 }, (_, index) => operation(`op-${index}`, `Watch ${index}`, index));
      renderEmptyState({ activeTheaterId: "theater-a", operations: nine, onOpenAll });

      const openAll = container?.querySelector<HTMLButtonElement>(".operations-canvas-empty-open-all");
      act(() => openAll?.click());
      expect(onOpenAll).not.toHaveBeenCalled();
      expect(container?.querySelector(".operations-canvas-empty-open-all.is-armed")?.textContent).toBe("Open 9?");

      act(() => { vi.advanceTimersByTime(1600); });
      expect(container?.querySelector(".operations-canvas-empty-open-all.is-armed")).toBeNull();

      act(() => openAll?.click());
      act(() => openAll?.click());
      expect(onOpenAll).toHaveBeenCalledTimes(1);
      expect(onOpenAll.mock.calls[0]?.[0]).toHaveLength(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the armed state when the standby set changes underneath it", () => {
    vi.useFakeTimers();
    try {
      const onOpenAll = vi.fn();
      const nine = Array.from({ length: 9 }, (_, index) => operation(`op-${index}`, `Watch ${index}`, index));
      renderEmptyState({ activeTheaterId: "theater-a", operations: nine, onOpenAll });

      act(() => container?.querySelector<HTMLButtonElement>(".operations-canvas-empty-open-all")?.click());
      expect(container?.querySelector(".operations-canvas-empty-open-all.is-armed")).not.toBeNull();

      const otherNine = Array.from({ length: 9 }, (_, index) => operation(`other-${index}`, `Other ${index}`, index));
      renderEmptyState({ activeTheaterId: "theater-b", operations: otherNine, onOpenAll });
      expect(container?.querySelector(".operations-canvas-empty-open-all.is-armed")).toBeNull();

      act(() => container?.querySelector<HTMLButtonElement>(".operations-canvas-empty-open-all")?.click());
      expect(onOpenAll).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the singular standby copy for one Operation", () => {
    renderEmptyState({
      activeTheaterId: "theater-a",
      operations: [operation("solo", "Solo", 1)],
    });

    expect(container?.querySelector(".operations-canvas-empty-ghost")?.textContent).toBe("1 operation standing by");
  });
});

function renderEmptyState({
  activeTheaterId,
  operations,
  onOpenOperation = vi.fn(),
  onOpenAll = vi.fn(),
  onNewOperation = vi.fn(),
}: {
  readonly activeTheaterId: string | null;
  readonly operations: readonly OperationNode[];
  readonly onOpenOperation?: (operationId: string) => void;
  readonly onOpenAll?: (operationIds: readonly string[]) => void;
  readonly onNewOperation?: () => void;
}): void {
  act(() => root?.render(createElement(OperationsCanvasEmptyState, {
    activeTheaterId,
    theaterLabel: "Alpha",
    operations,
    canLaunch: true,
    onOpenOperation,
    onOpenAll,
    onNewOperation,
  })));
}

function operation(id: string, title: string, updatedAt: number): OperationNode {
  return {
    id,
    theaterId: "theater-a",
    type: "shell",
    pluginId: "terminal",
    title,
    payload: {},
    geometry: null,
    ts: { createdAt: updatedAt, updatedAt },
  };
}
