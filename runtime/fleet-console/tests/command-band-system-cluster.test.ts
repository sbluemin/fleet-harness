// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandBandSystemCluster, resolveUpdateApplyCopy } from "../core/client/src/components/command-band-system-cluster.js";
import { getT } from "../core/client/src/i18n/index.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let originalRequestAnimationFrame: typeof window.requestAnimationFrame;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  window.localStorage.setItem("fleet-console.github-stars", JSON.stringify({ count: 1, at: Date.now() }));
  originalRequestAnimationFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.requestAnimationFrame = originalRequestAnimationFrame;
});

function mountCluster() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(MemoryRouter, null, createElement(CommandBandSystemCluster))));
}

function LocationProbe() {
  const location = useLocation();
  return createElement("output", { "data-testid": "location" }, `${location.pathname}${location.search}`);
}

function HistoryLengthProbe() {
  return createElement("output", { "data-testid": "history-length" }, String(window.history.length));
}

function mountClusterAt(initialPath: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(
    MemoryRouter,
    { initialEntries: [initialPath] },
    createElement(CommandBandSystemCluster),
    createElement(LocationProbe),
    createElement(HistoryLengthProbe),
  )));
}

function currentPath(): string {
  return document.querySelector<HTMLOutputElement>('[data-testid="location"]')!.value;
}

function currentHistoryLength(): number {
  return Number(document.querySelector<HTMLOutputElement>('[data-testid="history-length"]')!.value);
}

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

describe("CommandBandSystemCluster", () => {
  it("gives managed installation updates an actionable Desktop relaunch instruction instead of retry", () => {
    expect(resolveUpdateApplyCopy("blocked", "managed_runtime_update_requires_relaunch", "1.2.3", getT("en"))).toEqual({
      label: "Update and Restart",
      title: "This managed Console installation updates through Fleet Console Desktop. Use Desktop Update and Restart.",
      tone: "blocked",
      disabled: true,
    });
  });

  it("keeps Settings a direct one-click action without a menu", () => {
    mountCluster();
    const settings = document.querySelector<HTMLButtonElement>(".command-band-settings")!;
    expect(settings.getAttribute("aria-label")).toBe("Settings");
    expect(settings.getAttribute("aria-haspopup")).toBeNull();
    expect(document.querySelector(".command-band-system-menu")).toBeNull();
  });

  it("returns to the previous route when Settings is pressed again from the settings page", () => {
    mountClusterAt("/operations");
    const settings = document.querySelector<HTMLButtonElement>(".command-band-settings")!;

    act(() => settings.click());
    expect(currentPath()).toBe("/settings");
    const lengthAtSettings = currentHistoryLength();

    act(() => settings.click());
    expect(currentPath()).toBe("/operations");
    // Closing consumes the Settings entry instead of pushing another one.
    expect(currentHistoryLength()).toBe(lengthAtSettings);
  });

  it("treats a trailing-slash Settings pathname as the settings page and closes to /operations", () => {
    mountClusterAt("/settings/");
    const settings = document.querySelector<HTMLButtonElement>(".command-band-settings")!;

    act(() => settings.click());
    expect(currentPath()).toBe("/operations");
  });

  it("falls back to /operations when Settings is pressed on a deep-linked settings page", () => {
    mountClusterAt("/settings?section=terminal%3Acarriers");
    const settings = document.querySelector<HTMLButtonElement>(".command-band-settings")!;

    act(() => settings.click());
    expect(currentPath()).toBe("/operations");
  });

  it("opens the Help menu with focus on the first enabled item and cycles with arrow keys", () => {
    mountCluster();
    const trigger = document.querySelector<HTMLButtonElement>(".command-band-help")!;
    act(() => trigger.click());

    const items = menuItems();
    expect(items).toHaveLength(4);
    // What's New stays disabled while release notes are empty, so focus starts on Keyboard Shortcuts.
    expect(document.activeElement).toBe(items[1]);
    expect(items[2]?.getAttribute("aria-label")).toBe("Open GitHub repository");
    expect(document.querySelector(".command-band-github-version")?.textContent).toMatch(/^v/);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "End" })); });
    expect(document.activeElement).toBe(items[3]);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    expect(document.activeElement).toBe(items[1]);
  });

  it("closes the Help menu on Escape and returns focus to the trigger", () => {
    mountCluster();
    const trigger = document.querySelector<HTMLButtonElement>(".command-band-help")!;
    act(() => trigger.click());
    expect(menuItems()).toHaveLength(4);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });
});
