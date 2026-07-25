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
    expect(container?.querySelector(".operations-canvas-empty-hints")?.textContent).toBe("⌘K Search · Alt+F Formation · Alt+S Status board");
    expect(container?.querySelector(".operations-canvas-empty-guide")?.textContent).toBe("Shift-drag to create a Shell. Right-click for actions. Drag to pan; scroll to zoom.");

    const launch = container?.querySelector<HTMLButtonElement>('[aria-label="New Operation in Alpha"]');
    expect(launch?.textContent).toBe("+ New Operation");
    act(() => launch?.click());
    expect(onNewOperation).toHaveBeenCalledTimes(1);
  });

  it("shows the two most recently updated standby Operations and opens the selected one", () => {
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
    expect(chips).toHaveLength(2);
    expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual([
      "Open operation Newest watch",
      "Open operation Middle watch",
    ]);
    expect(chips.map((chip) => chip.querySelector(".operations-canvas-empty-standby-open")?.textContent)).toEqual(["OPEN", "OPEN"]);

    act(() => chips[1]?.click());
    expect(onOpenOperation).toHaveBeenCalledWith("middle");
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
  onNewOperation = vi.fn(),
}: {
  readonly activeTheaterId: string | null;
  readonly operations: readonly OperationNode[];
  readonly onOpenOperation?: (operationId: string) => void;
  readonly onNewOperation?: () => void;
}): void {
  act(() => root?.render(createElement(OperationsCanvasEmptyState, {
    activeTheaterId,
    theaterLabel: "Alpha",
    operations,
    canLaunch: true,
    onOpenOperation,
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
