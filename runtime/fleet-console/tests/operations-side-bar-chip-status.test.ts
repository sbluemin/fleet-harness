// @vitest-environment jsdom

import type { OperationActivityVisual } from "../core/client/src/operation-activity.js";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";

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
    ["idle", "tenant-beacon is-idle", "Idle"],
    [undefined, "tenant-beacon is-idle", "Idle"],
  ] as const)("renders %s as the matching status class and accessible label", (status, expectedClass, expectedLabel) => {
    const statusDot = renderChip(status);

    expect(statusDot.className).toContain(expectedClass);
    expect(statusDot.getAttribute("aria-label")).toBe(expectedLabel);
  });

  // 실행 표면 표식은 모드를 말하고 상태는 말하지 않는다 — 신호 채널을 빌리지 않으므로
  // 상태 점의 클래스는 표식이 붙어도 그대로다.
  it("paints the plugin-supplied surface mark beside the status dot without changing it", () => {
    renderChip("running", "CHAT");
    const surface = container?.querySelector<HTMLSpanElement>(".side-bar-chip-surface");
    const statusDot = container?.querySelector<HTMLSpanElement>('[role="img"]');

    expect(surface?.textContent).toBe("CHAT");
    expect(statusDot?.className).toContain("is-turn-running");
    expect(statusDot?.getAttribute("aria-label")).toBe("Running");
  });

  it("omits the surface mark when the plugin supplies none", () => {
    renderChip("running");
    expect(container?.querySelector(".side-bar-chip-surface")).toBeNull();
  });
});

// 두 축은 타입에서 갈라져 있다 — 휴면은 활동값을 가질 수 없고 활동은 휴면을 말할 수 없다.
describe("Operation runtime contract", () => {
  it("cannot express a dormant Operation that is also running", () => {
    const dormant: OperationRuntimeState = { lifecycle: "dormant" };
    const running: OperationRuntimeState = { lifecycle: "live", activity: "running" };

    // @ts-expect-error dormant 에는 activity 가 없다
    expect(dormant.activity).toBeUndefined();
    // @ts-expect-error 활동 어휘에서 dormant 는 빠졌다
    const invalid: OperationRuntimeState = { lifecycle: "live", activity: "dormant" };
    expect(invalid).toBeTruthy();
    expect(running.activity).toBe("running");
  });
});

function renderChip(status: OperationActivityVisual | undefined, surface?: string): HTMLSpanElement {
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
      ...(surface ? { surface } : {}),
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
