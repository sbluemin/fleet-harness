// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { describe, expect, it, vi } from "vitest";

vi.mock("../core/client/src/mobile/operation-body-pool.js", () => ({ OperationBodySlot: () => null }));

import { MobileSessionView } from "../core/client/src/mobile/mobile-session-view.js";
import type { OperationNode } from "../core/client/src/types.js";

/**
 * Mobile session chrome used to name the Operation and stop there, so Close existed only on
 * desktop frames and in a keyboard palette the phone does not surface. These pin leave vs close
 * as two jobs, and the two-tap coral arm that matches OperationFrame.
 */
describe("mobile session close", () => {

  it("requires a second close activation and expires or resets an unfinished confirmation", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onClose = vi.fn();
    const render = (id: string) => act(() => root.render(createElement(MobileSessionView, {
      operation: { id, title: id, theaterId: "theater", pluginId: "terminal", type: "agent", payload: {}, geometry: null, ts: { createdAt: 1, updatedAt: 1 } } as OperationNode,
      theme: "instrument", language: "en", active: true, runtimeState: null,
      operationKinds: [], capabilities: {} as never, onActivate: vi.fn(), onClose,
    })));
    const button = () => container.querySelector<HTMLButtonElement>("button.mobile-session-close")!;
    try {
      render("first");
      const initialLabel = button().getAttribute("aria-label");
      act(() => button().click());
      expect(onClose).not.toHaveBeenCalled();
      expect(button().getAttribute("aria-label")).not.toBe(initialLabel);
      act(() => vi.advanceTimersByTime(1500));
      expect(button().getAttribute("aria-label")).toBe(initialLabel);
      act(() => button().click());
      render("second");
      act(() => button().click());
      expect(onClose).not.toHaveBeenCalled();
      act(() => button().click());
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });
});
