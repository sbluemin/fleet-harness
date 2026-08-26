// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandBandSystemCluster, propagateSettingsEntryIndex, resolveUpdateApplyCopyFor } from "../core/client/src/components/command-band-system-cluster.js";
import { hydrateGlobalSettings } from "../core/client/src/global-settings-store.js";
import { applyObserverStatus } from "../core/client/src/store.js";
import { resolveStepIndex } from "../core/client/src/components/update-curtain.js";
import { getT } from "../core/client/src/i18n/index.js";
import type { GlobalSettingsState } from "../core/client/src/types.js";

const SETTINGS: GlobalSettingsState = {
  consolePortMode: "dynamic",
  consoleStaticPort: null,
  remoteAccess: { enabled: false, publicEndpointEnabled: false, listenAddress: "", advertisedHost: "", listenPort: { mode: "auto", value: 49152 }, advertisedPort: { mode: "auto", value: 49153 }, acknowledgment: null },
  seenFeatureTours: [],
  theme: "instrument",
  liquidGlass: true,
  unfocusedPanelFade: 50,
  uiFont: { source: "builtin", id: "manrope", size: 14 },
  language: "auto",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let originalRequestAnimationFrame: typeof window.requestAnimationFrame;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  window.localStorage.setItem("fleet-console.github-stars", JSON.stringify({ count: 1, at: Date.now() }));
  originalRequestAnimationFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
  hydrateGlobalSettings(SETTINGS);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
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
    expect(resolveUpdateApplyCopyFor("blocked", "managed_runtime_update_requires_relaunch", "1.2.3", getT("en"))).toEqual({
      label: "Update and Restart",
      title: "This managed Console installation updates through Fleet Console Desktop. Use Desktop Update and Restart.",
      tone: "blocked",
      disabled: true,
    });
  });

  it("puts the update mark on the control that performs the update", () => {
    // 설정에 붙어 있던 동안, 그 점을 따라간 사람은 업데이트가 없는 화면에 도착했다.
    applyObserverStatus({
      name: "console", workspaces: 0, version: "1.0.0", channel: "stable",
      updateAvailable: true, latestVersion: "1.2.3",
      port: 4000, portMode: "dynamic", requestedPort: null, effectivePort: 4000, portHonored: true,
      wikiServerStatus: "unknown",
    } as never);
    mountCluster();

    const help = document.querySelector<HTMLButtonElement>(".command-band-help")!;
    const settings = document.querySelector<HTMLButtonElement>(".command-band-settings")!;
    expect(help.querySelector(".command-band-update-dot")).not.toBeNull();
    // 같은 뜻의 표식이 커맨드 밴드에 둘이 되면 안 된다.
    expect(settings.querySelector(".command-band-update-dot")).toBeNull();
    expect(document.querySelectorAll(".command-band-update-dot")).toHaveLength(1);
    expect(help.getAttribute("aria-label")).toBe("Help — update ready");
  });

  it("carries no mark when there is nothing to update", () => {
    applyObserverStatus({
      name: "console", workspaces: 0, version: "1.0.0", channel: "stable",
      updateAvailable: false,
      port: 4000, portMode: "dynamic", requestedPort: null, effectivePort: 4000, portHonored: true,
      wikiServerStatus: "unknown",
    } as never);
    mountCluster();

    expect(document.querySelector(".command-band-update-dot")).toBeNull();
    expect(document.querySelector<HTMLButtonElement>(".command-band-help")!.getAttribute("aria-label")).toBe("Help");
  });

  it("asks a remote hand to confirm before it takes the host down, and says why", () => {
    const copy = resolveUpdateApplyCopyFor("armed", "host_restart_confirmation_required", "1.2.3", getT("en"));

    expect(copy.disabled).toBe(false);
    expect(copy.tone).toBe("warn");
    expect(copy.label).toBe("Restart this host?");
    // 무엇을 잃는지가 화면에 있어야 동의가 성립한다.
    expect(copy.title).toContain("the screen of anyone sitting in front of it goes down too");
  });

  it("never claims the update is done while it is still installing", () => {
    // 202는 시작됐다는 뜻일 뿐이다. 결과를 아는 것은 재기동을 겪고 돌아온 콘솔이다.
    const applying = resolveUpdateApplyCopyFor("applying", null, "1.2.3", getT("en"));
    expect(applying.disabled).toBe(true);
    expect(applying.label).not.toBe("Done");
  });

  it("keeps the idle row on neutral ink and lets it name the version delta", () => {
    // 대기 중 업데이트 안내는 정보다 — 신호 채널은 확인 대기·진행·실패만 쓴다.
    expect(resolveUpdateApplyCopyFor("idle", null, "1.2.3", getT("en")).tone).toBe("info");
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
    mountClusterAt("/settings?section=terminal%3Aagent");
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
    // 화면 안내는 시청 기록이 없으면 되살릴 것도 없으므로 비활성 — 포커스 순환에서도 빠진다.
    expect((items[2] as HTMLButtonElement).disabled).toBe(true);
    expect(items[3]?.getAttribute("aria-label")).toBe("Open GitHub repository");
    expect(document.querySelector(".command-band-github-version")?.textContent).toMatch(/^v/);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "End" })); });
    expect(document.activeElement).toBe(items[4]);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    expect(document.activeElement).toBe(items[1]);
  });

  it("enables the screen guide entry once any onboarding has been seen", () => {
    document.body.innerHTML = '<div class="command-band-mode-switch"></div>';
    hydrateGlobalSettings({ ...SETTINGS, seenFeatureTours: ["canvas-modes.walkthrough"] });
    mountCluster();
    const trigger = document.querySelector<HTMLButtonElement>(".command-band-help")!;
    act(() => trigger.click());

    const entry = menuItems()[2] as HTMLButtonElement;
    expect(entry.textContent).toContain("Show the screen guide");
    expect(entry.disabled).toBe(false);
  });

  it("resets every onboarding guide from the beginning on replay", async () => {
    document.body.innerHTML = '<div class="command-band-mode-switch"></div>';
    hydrateGlobalSettings({
      ...SETTINGS,
      seenFeatureTours: [
        "canvas-modes.walkthrough",
        "war-room.walkthrough",
        "claude-operations.walkthrough",
        "remote-access.spotlight",
        "commissioning",
        "effort-confirm-tip",
      ],
    });
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      state: {
        ...SETTINGS,
        seenFeatureTours: [],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    mountCluster();
    const trigger = document.querySelector<HTMLButtonElement>(".command-band-help")!;
    act(() => trigger.click());

    const entry = menuItems()[2] as HTMLButtonElement;
    expect(entry.disabled).toBe(false);
    act(() => entry.click());

    // 온보딩 전체(피처 투어 + 최초 설정 가이드 + 강도 확인 팁)가 초기화되어 서버에 저장된다.
    expect(fetch).toHaveBeenCalledWith("/api/v1/settings/global", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ seenFeatureTours: [] }),
    }));
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

describe("update curtain steps", () => {
  it("marks the step the console is actually in", () => {
    expect(resolveStepIndex("stopping-console")).toBe(0);
    expect(resolveStepIndex("installing")).toBe(1);
    expect(resolveStepIndex("starting-daemon")).toBe(2);
  });

  it("calls the unreachable stretch installing, because that is what it is", () => {
    // 워커는 콘솔을 내린 직후 설치를 시작한다 — 닿지 않는 시간은 설치 시간이다.
    expect(resolveStepIndex(null)).toBe(1);
  });
});
