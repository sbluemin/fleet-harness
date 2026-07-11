// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CanvasMinimap } from "../core/client/src/canvas/canvas-minimap.js";
import { clearFormationView, loadForTheater, toggleFormationView } from "../core/client/src/canvas/canvas-store.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  loadForTheater("formation-minimap-test");
  clearFormationView();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  clearFormationView();
  container?.remove();
  root = null;
  container = null;
});

describe("CanvasMinimap Formation behavior", () => {
  it("collapses on Formation entry and restores the pre-entry state on exit", () => {
    act(() => root!.render(createElement(CanvasMinimap, {
      operations: { operation: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 } },
      pluginOperations: {},
      viewport: { x: 0, y: 0, zoom: 1 },
      canvasSize: { width: 900, height: 600 },
      onJump: () => {},
    })));
    expect(document.querySelector('[aria-label="Collapse Map"]')).not.toBeNull();

    act(() => toggleFormationView());
    expect(document.querySelector('[aria-label="Open Map"]')).not.toBeNull();

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open Map"]')!.click());
    expect(document.querySelector('[aria-label="Collapse Map"]')).not.toBeNull();

    act(() => clearFormationView());
    expect(document.querySelector('[aria-label="Collapse Map"]')).not.toBeNull();
  });
});
