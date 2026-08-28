// @vitest-environment jsdom

import { pluginRuntimeState, type OperationActivityVisual } from "../core/client/src/operation-activity.js";
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
    ["ended", "tenant-beacon is-ended", "Ended"],
    ["idle", "tenant-beacon is-idle", "Idle"],
    [undefined, "tenant-beacon is-idle", "Idle"],
  ] as const)("renders %s as the matching status class and accessible label", (status, expectedClass, expectedLabel) => {
    const statusDot = renderChip(status);

    expect(statusDot.className).toContain(expectedClass);
    expect(statusDot.getAttribute("aria-label")).toBe(expectedLabel);
  });

});

// degraded 는 "모른다"는 뜻이다 — 마지막으로 알던 값을 지금의 사실처럼 패널에 넘기면,
// 본문은 끊긴 축 위에서 계속 작업 중이라고 말한다.
describe("plugin runtime state under degraded hydration", () => {
  const runtime = { "op-1": { lifecycle: "live", activity: "running" } } as const;

  it("hands the last known state to the panel while the axis is trusted", () => {
    expect(pluginRuntimeState(runtime, "ready", "op-1")).toEqual({ lifecycle: "live", activity: "running" });
    expect(pluginRuntimeState(runtime, "pending", "op-1")).toEqual({ lifecycle: "live", activity: "running" });
  });

  it("withholds a stale state once the axis is degraded", () => {
    expect(pluginRuntimeState(runtime, "degraded", "op-1")).toBeNull();
  });

  it("reports an unobserved Operation as unknown rather than idle", () => {
    expect(pluginRuntimeState(runtime, "ready", "missing")).toBeNull();
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
    const invalid: OperationRuntimeState = { lifecycle: "live", activity: "ended" };
    expect(invalid).toBeTruthy();
    expect(running.activity).toBe("running");
  });
});

function renderChip(status: OperationActivityVisual | undefined, type = "agent"): HTMLSpanElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(OperationsSideBarChip, {
    entry: {
      operation: {
        id: "operation-1",
        theaterId: "theater-1",
        type,
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
