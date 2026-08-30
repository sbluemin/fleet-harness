// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 실물 레지스트리는 번들러 가상 모듈(virtual:fleet-plugins)을 끌어와 해석 단계에서 막힌다.
const registryMocks = vi.hoisted(() => ({
  plugins: [] as unknown[],
}));

vi.mock("../core/client/src/plugin-registry.js", () => ({
  usePluginRegistry: () => ({ plugins: registryMocks.plugins }),
}));

import { hydrateGlobalSettings } from "../core/client/src/global-settings-store.js";
import {
  closeRailPanel,
  getRailStoreSnapshot,
  RAIL_OVERLAY_ALPHA_DEFAULT,
  openRailPanel,
  setRailOverlayAlpha,
} from "../core/client/src/rail/rail-store.js";
import { settingsPanes, syncSettingsSearchPlugins } from "../core/client/src/settings/settings-pane.js";
import type { GlobalSettingsState } from "../core/client/src/types.js";

const SETTINGS: GlobalSettingsState = {
  consolePortMode: "dynamic",
  consoleStaticPort: null,
  remoteAccess: { enabled: false, publicEndpointEnabled: false, listenAddress: "", advertisedHost: "", listenPort: { mode: "auto", value: 49152 }, advertisedPort: { mode: "auto", value: 49153 }, acknowledgment: null } as never,
  seenFeatureTours: [],
  theme: "instrument",
  liquidGlass: true,
  unfocusedPanelFade: 50,
  uiFont: { source: "builtin", id: "manrope", size: 14 },
  language: "auto",
};

const primaryPane = settingsPanes.find((pane) => pane.id === "settings")!;
const sectionPane = settingsPanes.find((pane) => pane.id === "settings.section")!;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let panesCapability: { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; replaceParams: ReturnType<typeof vi.fn>; isOpen: () => boolean };

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function paneContext(params: Readonly<Record<string, string>>, pane = primaryPane) {
  return {
    paneId: pane.id,
    instanceId: `pane-test-${pane.id}`,
    params,
    role: pane.role,
    mount: "rail",
    width: 360,
    visible: true,
    focused: true,
    theaterId: null,
    api: {},
    lifecycle: {},
    preferences: {},
    panes: panesCapability,
    signal: new AbortController().signal,
    language: "en",
  } as never;
}

function renderPane(params: Readonly<Record<string, string>>, pane = primaryPane): void {
  if (root === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root!.render(pane.render(paneContext(params, pane)) as never);
  });
}

function chip(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>(".settings-chip")]
    .find((button) => button.textContent === label);
  expect(found, `chip "${label}"`).toBeDefined();
  return found!;
}

function searchInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(".settings-pane .settings-search input")!;
}

function typeQuery(value: string): void {
  const input = searchInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressEscape(target: HTMLElement, defaultPrevented = false): void {
  act(() => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    if (defaultPrevented) event.preventDefault();
    target.dispatchEvent(event);
  });
}

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  registryMocks.plugins = [];
  syncSettingsSearchPlugins([]);
  hydrateGlobalSettings(SETTINGS);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(SETTINGS)));
  openRailPanel("settings");
  setRailOverlayAlpha(RAIL_OVERLAY_ALPHA_DEFAULT);
  panesCapability = { open: vi.fn(), close: vi.fn(), replaceParams: vi.fn(), isOpen: () => false };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  syncSettingsSearchPlugins([]);
  for (const id of [...getRailStoreSnapshot().pinnedPanelIds]) closeRailPanel(id);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("settings pane body", () => {
  it("stands every section as a chip and switches sections through replaceParams", () => {
    renderPane({});

    // 환경 → 작업 → 기계의 그룹 순서 — 접힘(+N) 없이 전부 선다.
    const labels = [...document.querySelectorAll(".settings-chip")].map((c) => c.textContent);
    expect(labels).toEqual(["Appearance", "Language", "Connectivity", "Advanced"]);
    expect(chip("Appearance").getAttribute("aria-pressed")).toBe("true");

    act(() => chip("Language").click());
    // 주소는 params가 진다 — 페인 안 상태가 아니라 replaceParams로 갈아탄다.
    expect(panesCapability.replaceParams).toHaveBeenCalledWith({ section: "language" });

    renderPane({ section: "language" });
    expect(chip("Language").getAttribute("aria-pressed")).toBe("true");
  });

  it("filters sections in the pane and lands a result through replaceParams", () => {
    renderPane({});
    typeQuery("glass");

    const results = [...document.querySelectorAll<HTMLButtonElement>(".settings-pane-result")];
    expect(results.map((r) => r.querySelector(".settings-pane-result-label")?.textContent)).toEqual(["Appearance"]);

    act(() => results[0]!.click());
    expect(panesCapability.replaceParams).toHaveBeenCalledWith({ section: "appearance" });
  });

  it("reaches the migrated rail rows by their visible names", () => {
    renderPane({});
    typeQuery("Panel opacity");

    const labels = [...document.querySelectorAll(".settings-pane-result-label")].map((e) => e.textContent);
    expect(labels).toEqual(["Appearance"]);
  });

  it("clears a standing search on the first Escape and closes the pane only on the second", () => {
    const gear = document.createElement("button");
    gear.className = "right-rail-settings-btn";
    document.body.append(gear);

    renderPane({});
    typeQuery("glass");
    expect(document.querySelector(".settings-pane-results")).not.toBeNull();

    // 첫 Esc는 검색을 거둔다 — 질의를 지우려던 손이 페인째 닫으면 안 된다.
    pressEscape(searchInput());
    expect(document.querySelector(".settings-pane-results")).toBeNull();
    expect(getRailStoreSnapshot().pinnedPanelIds).toContain("settings");

    pressEscape(searchInput());
    expect(getRailStoreSnapshot().pinnedPanelIds).not.toContain("settings");
    expect(document.activeElement).toBe(gear);

    gear.remove();
  });

  it("yields Escape to an inner control that already consumed it", () => {
    renderPane({});
    pressEscape(searchInput(), true);

    expect(getRailStoreSnapshot().pinnedPanelIds).toContain("settings");
  });

  it("keeps the remote management out of the pane and opens it on the expanded surface", () => {
    renderPane({ section: "connectivity" });

    // 장치·링크 테이블은 페인에 서지 않는다 — 요약과 관리 문만 선다.
    expect(document.querySelector(".settings-pane .remote-table")).toBeNull();
    const manage = document.querySelector<HTMLButtonElement>(".settings-pane-manage")!;
    act(() => manage.click());

    expect(panesCapability.open).toHaveBeenCalledWith({
      paneId: "settings.section",
      mount: "expanded",
      params: { section: "connectivity" },
    });
  });

  it("hosts the rail preferences in Appearance and resets opacity on slider double-click", () => {
    renderPane({});

    // 전면 해도 개편으로 push/overlay 스위치는 퇴역했다 — 겉모습에 남는 레일 취향은 불투명도뿐이다.
    expect(document.querySelector('.settings-pane [role="switch"][aria-label="Float over Map"]')).toBeNull();

    act(() => setRailOverlayAlpha(65));
    renderPane({});
    const slider = document.querySelector<HTMLInputElement>('.settings-pane input[aria-label="Panel opacity"]')!;
    act(() => slider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(getRailStoreSnapshot().overlayAlpha).toBe(RAIL_OVERLAY_ALPHA_DEFAULT);
  });

  it("carries the rail preferences into the expanded Appearance section too", () => {
    renderPane({ section: "appearance" }, sectionPane);

    expect(document.querySelector('.settings-expanded input[aria-label="Panel opacity"]')).not.toBeNull();
    // 확대 사본은 준비된 스냅숏을 재사용한다 — 여기서 GET을 또 쏘면 그 응답이 사용자의
    // 낙관 저장 뒤에 도착해 옛 값으로 화면을 되덮는다(리뷰 적발).
    const settingsGets = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => String(call[0]).includes("/api/v1/settings/global"));
    expect(settingsGets).toHaveLength(0);
  });
});

describe("settings pane plugin error isolation", () => {
  it("does not let one faulty plugin section infect the next section", () => {
    registryMocks.plugins = [
      { id: "boom", settingsSections: [{ id: "bad", title: () => "Bad", render: () => { throw new Error("boom"); } }] },
      { id: "calm", settingsSections: [{ id: "good", title: () => "Good", render: () => "calm-section-body" }] },
    ];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      renderPane({ section: "boom:bad" });
      expect(document.querySelector(".fc-plugin-error")).not.toBeNull();

      // 섹션 전환은 재마운트다 — 경계의 hasError가 다음 섹션까지 전염되면 안 된다.
      renderPane({ section: "calm:good" });
      expect(document.querySelector(".fc-plugin-error")).toBeNull();
      expect(document.querySelector(".settings-pane-sections")?.textContent).toContain("calm-section-body");
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("settings pane search provider", () => {
  const request = (query: string) => ({
    query,
    theaterId: "theater-a",
    limit: 8,
    signal: new AbortController().signal,
    language: "en" as const,
  });

  it("returns nothing for an empty query and a PaneTarget for a core match", async () => {
    expect(await primaryPane.search!(request(""))).toEqual([]);

    const [hit] = await primaryPane.search!(request("liquid glass"));
    expect(hit?.title).toBe("Appearance");
    expect(hit?.activate()).toEqual({ paneId: "settings", params: { section: "appearance" } });
  });

  it("sees plugin sections only after the app syncs the snapshot", async () => {
    expect(await primaryPane.search!(request("dormant"))).toEqual([]);

    syncSettingsSearchPlugins([{
      id: "terminal",
      settingsSections: [{ id: "harness", title: () => "Harness", keywords: ["dormant idle"] }],
    }]);

    const [hit] = await primaryPane.search!(request("dormant"));
    expect(hit?.title).toBe("Harness");
    expect(hit?.activate()).toEqual({ paneId: "settings", params: { section: "terminal:harness" } });

    syncSettingsSearchPlugins([]);
    expect(await primaryPane.search!(request("dormant"))).toEqual([]);
  });
});
