// @vitest-environment jsdom

import { act, createElement, Fragment, useLayoutEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OperationFrame } from "../core/client/src/canvas/operation-frame.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("OperationFrame body activation", () => {
  it("activates from pointerdown in a portaled body moved into the terminal slot", () => {
    const onActivate = vi.fn();

    act(() => root!.render(createElement(Fragment, null,
      createElement(OperationFrame, {
        operation: {
          id: "operation-body-activation",
          theaterId: "theater-body-activation",
          type: "shell",
          pluginId: "terminal",
          title: "Portaled Operation",
          payload: {},
          geometry: null,
          ts: { createdAt: 1, updatedAt: 1 },
        },
        active: false,
        unseen: false,
        glanceHud: {
          index: "01",
          hints: [
            { key: "↑", messageKey: "canvas.glance.maximize" },
            { key: "↓", messageKey: "canvas.glance.minimize" },
          ],
        },
        interactionDisabled: true,
        geometry: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 },
        zoom: 1,
        onActivate,
        onClose: () => {},
        onMinimize: () => {},
        onRename: () => {},
        onGeometryChange: () => {},
        onGeometryCommit: () => {},
        children: null,
      }),
      createElement(PortaledOperationBody),
    )));

    const body = document.querySelector<HTMLElement>("[data-test-operation-body]");
    expect(body?.closest(".canvas-operation-terminal")).not.toBeNull();

    act(() => body!.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true })));

    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

function PortaledOperationBody() {
  const mountNode = useMemo(() => document.createElement("div"), []);

  useLayoutEffect(() => {
    const slot = document.querySelector(".canvas-operation-terminal");
    if (!slot) throw new Error("Missing Operation terminal slot");
    slot.appendChild(mountNode);
    return () => mountNode.remove();
  }, [mountNode]);

  return createPortal(createElement("div", { "data-test-operation-body": true }), mountNode);
}
