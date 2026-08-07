// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandBandSystemCluster, propagateSettingsEntryIndex, resolveUpdateApplyCopy } from "../core/client/src/components/command-band-system-cluster.js";
import { getT } from "../core/client/src/i18n/index.js";
import { applyDeveloperNotes } from "../core/client/src/store.js";

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
    expect(items).toHaveLength(6);
    // What's New와 개발자 노트가 모두 비어 비활성이므로 포커스는 키보드 단축키에서 시작한다.
    expect(document.activeElement).toBe(items[2]);
    // 화면 안내는 짚을 앵커가 없는 화면에서 비활성이므로 포커스 순환에서도 빠진다.
    expect((items[3] as HTMLButtonElement).disabled).toBe(true);
    expect(items[4]?.getAttribute("aria-label")).toBe("Open GitHub repository");
    expect(document.querySelector(".command-band-github-version")?.textContent).toMatch(/^v/);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "End" })); });
    expect(document.activeElement).toBe(items[5]);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    expect(document.activeElement).toBe(items[2]);
  });

  it("enables the screen guide entry only where a seen guide is anchored", () => {
    document.body.innerHTML = '<div class="command-band-mode-switch"></div>';
    mountCluster();
    const trigger = document.querySelector<HTMLButtonElement>(".command-band-help")!;
    act(() => trigger.click());

    // 시청 기록이 없으면 되살릴 것도 없다 — 아직 못 본 안내는 "다시 보기"의 대상이 아니다.
    const entry = menuItems()[3] as HTMLButtonElement;
    expect(entry.textContent).toContain("Show the screen guide");
    expect(entry.disabled).toBe(true);
  });

  it("seats developer notes directly under What's New and disables it while there is nothing to read", () => {
    // 눌러도 아무 일이 없는 항목을 남기지 않는다 — 무응답 대신 비활성으로 그 사실을 먼저 알린다.
    mountCluster();
    act(() => document.querySelector<HTMLButtonElement>(".command-band-help")!.click());
    const items = menuItems();
    expect(items[0]?.textContent).toContain("What's New");
    expect(items[1]?.textContent).toContain("Developer notes");
    expect((items[1] as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".command-band-notes-dot")).toBeNull();
  });

  it("marks the help button and the menu entry when an unread note arrives", () => {
    act(() => applyDeveloperNotes({
      notes: [{ id: "gh-1", hash: "aaaa", title: "Gateway maintenance", body: "", url: "https://github.com/sbluemin/fleet-harness/issues/1", publishedAt: "2026-08-07T01:00:00Z" }],
      snapshotHash: "snapshot-with-one-note",
      stale: false,
    }));
    mountCluster();
    // 도착 신호는 도움말 버튼에 붙는다 — 업데이트 점은 설정 버튼에 있어 둘이 겹치지 않는다.
    expect(document.querySelector(".command-band-notes-dot")).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>(".command-band-help")!.click());
    const entry = menuItems()[1] as HTMLButtonElement;
    expect(entry.disabled).toBe(false);
    expect(entry.querySelector(".command-band-system-menu-count")?.textContent).toBe("1");
    act(() => applyDeveloperNotes({ notes: [], snapshotHash: "snapshot-empty", stale: false }));
  });

  it("closes the Help menu on Escape and returns focus to the trigger", () => {
    mountCluster();
    const trigger = document.querySelector<HTMLButtonElement>(".command-band-help")!;
    act(() => trigger.click());
    expect(menuItems()).toHaveLength(6);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });
});
