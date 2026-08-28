// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/client/src/plugin-registry.js", () => ({ useExpandedSurfaceDescriptors: () => new Map(),
  usePluginRegistry: () => ({ plugins: [], failures: [], operationKinds: [], settingsSections: [], notificationKinds: [], railPanels: [] , expandedSurfaces: []}),
}));

import { useGlanceHold } from "../core/client/src/canvas/canvas.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(GlanceProbe)));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("useGlanceHold", () => {
  it("shows while AltLeft is held and hides on keyup", () => {
    dispatchAlt("keydown", "AltLeft");
    expect(glanceHeld()).toBe(true);

    dispatchAlt("keyup", "AltLeft");
    expect(glanceHeld()).toBe(false);
  });

  it("keeps Glance visible until both Alt keys are released", () => {
    dispatchAlt("keydown", "AltLeft");
    dispatchAlt("keydown", "AltRight");
    dispatchAlt("keyup", "AltLeft");
    expect(glanceHeld()).toBe(true);

    dispatchAlt("keyup", "AltRight");
    expect(glanceHeld()).toBe(false);
  });

  it.each(["ctrlKey", "metaKey"])("ignores AltGr-style %s keydown", (modifier) => {
    dispatchAlt("keydown", "AltRight", { [modifier]: true });
    expect(glanceHeld()).toBe(false);

    dispatchAlt("keyup", "AltRight", { [modifier]: true });
    expect(glanceHeld()).toBe(false);
  });

  it("ignores repeated Alt keydown", () => {
    dispatchAlt("keydown", "AltLeft", { repeat: true });
    expect(glanceHeld()).toBe(false);
  });

  it("does not enter glance while a blocking dialog is open", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);

    dispatchAlt("keydown", "AltLeft");
    expect(glanceHeld()).toBe(false);

    dialog.remove();
    dispatchAlt("keydown", "AltLeft");
    expect(glanceHeld()).toBe(true);
  });

  it("clears immediately on window blur", () => {
    dispatchAlt("keydown", "AltLeft");
    act(() => window.dispatchEvent(new Event("blur")));
    expect(glanceHeld()).toBe(false);
  });

  it("clears immediately when the document becomes hidden", () => {
    const visibilityState = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    dispatchAlt("keydown", "AltLeft");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(glanceHeld()).toBe(false);
    visibilityState.mockRestore();
  });

  it("removes every listener it registered on unmount", () => {
    act(() => root!.unmount());
    root = null;

    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const documentAdd = vi.spyOn(document, "addEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");

    const probeRoot = createRoot(container!);
    act(() => probeRoot.render(createElement(GlanceProbe)));
    const added = [
      ...windowAdd.mock.calls.map(([type, handler]) => [windowRemove, type, handler] as const),
      ...documentAdd.mock.calls.map(([type, handler]) => [documentRemove, type, handler] as const),
    ];
    act(() => probeRoot.unmount());

    expect(added.map(([, type]) => type).sort()).toEqual(["blur", "keydown", "keyup", "visibilitychange"]);
    for (const [removeSpy, type, handler] of added) {
      expect(removeSpy.mock.calls.some(([removedType, removedHandler]) => removedType === type && removedHandler === handler)).toBe(true);
    }
  });
});

function GlanceProbe() {
  const glanceVisible = useGlanceHold();
  return createElement("output", { "data-glance": "true" }, String(glanceVisible));
}

function dispatchAlt(type: "keydown" | "keyup", code: "AltLeft" | "AltRight", options: KeyboardEventInit = {}): void {
  act(() => window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, code, ...options })));
}

function glanceHeld(): boolean {
  return document.querySelector("[data-glance]")?.textContent === "true";
}
