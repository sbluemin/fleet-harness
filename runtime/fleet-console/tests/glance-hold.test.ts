// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/client/src/plugin-registry.js", () => ({
  usePluginRegistry: () => ({ plugins: [], operationKinds: [], settingsSections: [], notificationKinds: [], railPanels: [] }),
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

  it("removes listeners on unmount", () => {
    act(() => root!.unmount());
    root = null;

    expect(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "AltLeft", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "AltLeft", bubbles: true }));
    }).not.toThrow();
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
