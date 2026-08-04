// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandBandSystemCluster, propagateSettingsEntryIndex, resolveUpdateApplyCopy } from "../core/client/src/components/command-band-system-cluster.js";
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

// GlobalSettings.selectSection과 같은 방식의 push 네비게이션을 재현하는 프로브.
function SectionPushProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  (window as typeof window & { __pushSettingsSection?: () => void }).__pushSettingsSection = () => {
    navigate({ pathname: "/settings", search: "?section=backend-api" }, { state: propagateSettingsEntryIndex(location.state) });
  };
  return null;
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
    createElement(SectionPushProbe),
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

  it("consumes section-navigation entries too when closing Settings", () => {
    mountClusterAt("/operations");
    const settings = document.querySelector<HTMLButtonElement>(".command-band-settings")!;

    act(() => settings.click());
    expect(currentPath()).toBe("/settings");

    // Settings 내 섹션 이동은 /settings?... 항목을 push한다 (global-settings selectSection).
    act(() => { (window as typeof window & { __pushSettingsSection: () => void }).__pushSettingsSection(); });
    expect(currentPath()).toBe("/settings?section=backend-api");

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
    expect(items).toHaveLength(5);
    // What's New stays disabled while release notes are empty, so focus starts on Keyboard Shortcuts.
    expect(document.activeElement).toBe(items[1]);
    // 화면 안내는 짚을 앵커가 없는 화면에서 비활성이므로 포커스 순환에서도 빠진다.
    expect((items[2] as HTMLButtonElement).disabled).toBe(true);
    expect(items[3]?.getAttribute("aria-label")).toBe("Open GitHub repository");
    expect(document.querySelector(".command-band-github-version")?.textContent).toMatch(/^v/);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "End" })); });
    expect(document.activeElement).toBe(items[4]);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    expect(document.activeElement).toBe(items[1]);
  });

  it("enables the screen guide entry only where a seen guide is anchored", () => {
    document.body.innerHTML = '<div class="command-band-mode-switch"></div>';
    mountCluster();
    const trigger = document.querySelector<HTMLButtonElement>(".command-band-help")!;
    act(() => trigger.click());

    // 시청 기록이 없으면 되살릴 것도 없다 — 아직 못 본 안내는 "다시 보기"의 대상이 아니다.
    const entry = menuItems()[2] as HTMLButtonElement;
    expect(entry.textContent).toContain("Show the screen guide");
    expect(entry.disabled).toBe(true);
  });

  it("closes the Help menu on Escape and returns focus to the trigger", () => {
    mountCluster();
    const trigger = document.querySelector<HTMLButtonElement>(".command-band-help")!;
    act(() => trigger.click());
    expect(menuItems()).toHaveLength(5);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });
});
