// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { OperationsSideBarChip } from "../core/client/src/sidebar/operations-side-bar-chip.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("OperationsSideBarChip activity status", () => {
  it.each([
    ["running", "tenant-beacon is-turn-running", "Running"],
    ["awaiting", "tenant-beacon is-awaiting", "Awaiting input"],
    ["dormant", "tenant-beacon is-dormant", "Dormant"],
    ["idle", "is-idle", "Idle"],
    [undefined, "is-idle", "Idle"],
  ] as const)("renders %s as the matching status class and accessible label", (status, expectedClass, expectedLabel) => {
    const statusDot = renderChip(status);

    expect(statusDot.className).toContain(expectedClass);
    expect(statusDot.getAttribute("aria-label")).toBe(expectedLabel);
  });
});

function renderChip(status: OperationActivity | undefined): HTMLSpanElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(OperationsSideBarChip, {
    entry: {
      operation: {
        id: "operation-1",
        theaterId: "theater-1",
        type: "shell",
        pluginId: "terminal",
        title: "Bridge",
        payload: {},
        geometry: null,
        ts: { createdAt: 1, updatedAt: 1 },
      },
      active: false,
      minimized: false,
      notificationCount: 0,
      status,
      icon: null,
    },
    index: 0,
    isCloseArmed: false,
    accentValue: null,
    dragging: false,
    dragOffsetY: 0,
    dropTarget: false,
    onArmClose: () => {},
    onDisarmClose: () => {},
    onClose: () => {},
    onMinimize: () => {},
    onFocus: () => {},
    onKeyboardMove: () => {},
    onPointerDragStart: () => {},
    onOpenAccent: () => {},
    onRename: () => {},
  })));
  const statusDot = container.querySelector<HTMLSpanElement>('[role="img"]');
  if (statusDot === null) throw new Error("Missing sidebar chip status dot");
  return statusDot;
}
