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

  it("omits the Glance key row when the model has no executable hints", () => {
    act(() => root!.render(createElement(OperationFrame, {
      operation: {
        id: "operation-companion-glance",
        theaterId: "theater-body-activation",
        type: "shell",
        pluginId: "terminal",
        title: "Companion Operation",
        payload: {},
        geometry: null,
        ts: { createdAt: 1, updatedAt: 1 },
      },
      active: true,
      unseen: false,
      glanceHud: { index: "01", hints: [] },
      interactionDisabled: true,
      geometry: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 },
      zoom: 1,
      onActivate: () => {},
      onClose: () => {},
      onMinimize: () => {},
      onRename: () => {},
      onGeometryChange: () => {},
      onGeometryCommit: () => {},
      children: null,
    })));

    expect(document.querySelector(".canvas-operation-glance-hud-name")?.textContent).toContain("01");
    expect(document.querySelector(".canvas-operation-glance-hud-keys")).toBeNull();
  });

  // War Room 덱의 칸에서 본문은 읽는 자리다. 승격 면이 포인터를 가로채는 것만으로는 절반이라,
  // 키보드는 그 면을 지나쳐 살아 있는 body(터미널 textarea·컴포저)로 들어가 실제 입력을 보낸다.
  it("takes the deck tile's body out of the tab order while the caption keeps its controls", () => {
    const frameProps = (deckTile: boolean) => ({
      operation: {
        id: "operation-deck-tile",
        theaterId: "theater-body-activation",
        type: "shell",
        pluginId: "terminal",
        title: "Deck Tile Operation",
        payload: {},
        geometry: null,
        ts: { createdAt: 1, updatedAt: 1 },
      },
      active: false,
      unseen: false,
      glanceHud: { index: "01", hints: [] },
      interactionDisabled: true,
      deckTile,
      geometry: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 },
      zoom: 1,
      onActivate: () => {},
      onClose: () => {},
      onMinimize: () => {},
      onRename: () => {},
      onGeometryChange: () => {},
      onGeometryCommit: () => {},
      children: createElement("textarea", { "data-test-body-input": true }),
    });

    act(() => root!.render(createElement(OperationFrame, frameProps(true))));
    const deckBody = document.querySelector<HTMLElement>(".canvas-operation-terminal")!;
    expect(deckBody.hasAttribute("inert")).toBe(true);
    // 캡션은 살아 있다 — 최소화·닫기는 키보드로도 닿아야 한다.
    expect(document.querySelector(".canvas-operation-titlebar")?.hasAttribute("inert")).toBe(false);
    expect(document.querySelectorAll(".canvas-operation-window-controls button").length).toBeGreaterThan(0);

    // 캔버스에 선 같은 패널은 그대로 조작 대상이다.
    act(() => root!.render(createElement(OperationFrame, frameProps(false))));
    expect(document.querySelector<HTMLElement>(".canvas-operation-terminal")!.hasAttribute("inert")).toBe(false);
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
