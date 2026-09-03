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
import {
  getSideBarGlass,
  resetSideBarGlassForTests,
  setSideBarGlassAlpha,
  setSideBarGlassBlur,
  SIDE_BAR_GLASS_BLUR_DEFAULT,
} from "../core/client/src/sidebar/operations-side-bar-store.js";
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

function blurHandle(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('.settings-pane input[aria-label="Left sidebar glass blur"]')!;
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
  {
    const active = getRailStoreSnapshot().activePanelId;
    if (active !== null) closeRailPanel(active);
  }
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
    typeQuery("Right sidebar opacity");

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
    expect(getRailStoreSnapshot().activePanelId).toBe("settings");

    pressEscape(searchInput());
    expect(getRailStoreSnapshot().activePanelId).not.toBe("settings");
    expect(document.activeElement).toBe(gear);

    gear.remove();
  });

  it("yields Escape to an inner control that already consumed it", () => {
    renderPane({});
    pressEscape(searchInput(), true);

    expect(getRailStoreSnapshot().activePanelId).toBe("settings");
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

  it("hosts the rail opacity row in the Theme card below the panel fade and resets on double-click", () => {
    renderPane({});

    // 전면 해도 개편으로 push/overlay 스위치는 퇴역했다 — 겉모습에 남는 레일 취향은 불투명도뿐이다.
    expect(document.querySelector('.settings-pane [role="switch"][aria-label="Float over Map"]')).toBeNull();
    // 전용 "레일 패널" 카드도 퇴역했다 — 행은 테마 카드 안, 비포커스 패널 흐리기 바로 아래에 선다(재가된 배치).
    const themeSliders = [...document.querySelectorAll<HTMLInputElement>(".settings-pane .appearance-card .settings-slider")]
      .map((input) => input.getAttribute("aria-label"));
    expect(themeSliders).toEqual(["Unfocused panel fade", "Right sidebar opacity", "Left sidebar opacity", "Left sidebar glass blur"]);

    act(() => setRailOverlayAlpha(65));
    renderPane({});
    const slider = document.querySelector<HTMLInputElement>('.settings-pane .appearance-card input[aria-label="Right sidebar opacity"]')!;
    act(() => slider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(getRailStoreSnapshot().overlayAlpha).toBe(RAIL_OVERLAY_ALPHA_DEFAULT);
  });

  it("drives the left sidebar glass from the root variables and resets blur on double-click", () => {
    resetSideBarGlassForTests();
    act(() => setSideBarGlassAlpha(70));
    act(() => setSideBarGlassBlur(6));
    renderPane({});

    // 손잡이는 반드시 문서 루트에 실린다 — 사이드바 요소에 실으면 theme.css가 :root에서
    // 이미 폴백을 치환해 버려 blur 값이 화면에 닿지 않는다.
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--side-bar-glass-alpha")).toBe("0.7");
    expect(root.getPropertyValue("--side-bar-glass-blur")).toBe("6px");

    const blur = document.querySelector<HTMLInputElement>('.settings-pane .appearance-card input[aria-label="Left sidebar glass blur"]')!;
    expect(blur.disabled).toBe(false);
    act(() => blur.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(getSideBarGlass().blur).toBe(SIDE_BAR_GLASS_BLUR_DEFAULT);
    expect(root.getPropertyValue("--side-bar-glass-blur")).toBe("24px");
  });

  /* 게이트 판정은 테마 이름이 아니라 채널의 계산값으로 한다. theme.css의 게이트 넷 중 둘
     (@supports 미달 · prefers-reduced-transparency)은 CSS에만 있어 TS 상태로는 보이지 않으므로,
     조건을 복제하면 반드시 원본보다 좁아진다(적대 리뷰 적발). 그래서 이 테스트도 테마를 흔드는
     대신 채널을 직접 닫는다 — 게이트가 몇 개든 닫힘의 유일한 표현이 이 값이기 때문이다. */
  it("disables the blur handle whenever the glass channel resolves to none, without touching the stored value", async () => {
    resetSideBarGlassForTests();
    act(() => setSideBarGlassBlur(12));
    // jsdom에는 시트가 없어 채널이 스스로 계산되지 않는다 — 라이트 전환을 그 결과(채널 none)와
    // 계기(루트 data-theme)로 함께 재현한다. 훅이 보는 것은 그 둘뿐이므로 이것이 실기와 같은 신호다.
    const style = document.documentElement.style;
    style.setProperty("--glass-backdrop-side-bar", "none");
    act(() => { document.documentElement.setAttribute("data-theme", "whites"); });
    renderPane({});
    expect(blurHandle().disabled).toBe(true);
    // 불투명도는 유리와 무관한 레이어 알파라 게이트가 닫혀도 살아 있다.
    expect(document.querySelector<HTMLInputElement>('.settings-pane input[aria-label="Left sidebar opacity"]')!.disabled).toBe(false);

    // 화면을 닫는 일과 저장값을 지우는 일은 다르다 — 유리가 돌아오면 고른 값이 그대로 선다.
    expect(getSideBarGlass().blur).toBe(12);
    style.setProperty("--glass-backdrop-side-bar", "blur(24px) saturate(1.7)");
    await act(async () => {
      document.documentElement.setAttribute("data-theme", "instrument");
      // MutationObserver 콜백은 마이크로태스크로 온다 — 같은 tick에서 단언하면 옛 값을 읽는다.
      await Promise.resolve();
    });
    expect(blurHandle().disabled).toBe(false);
    style.removeProperty("--glass-backdrop-side-bar");
    document.documentElement.removeAttribute("data-theme");
  });

  it("carries the rail preferences into the expanded Appearance section too", () => {
    renderPane({ section: "appearance" }, sectionPane);

    expect(document.querySelector('.settings-expanded .appearance-card input[aria-label="Right sidebar opacity"]')).not.toBeNull();
    expect(document.querySelector('.settings-expanded .appearance-card input[aria-label="Left sidebar opacity"]')).not.toBeNull();
    expect(document.querySelector('.settings-expanded .appearance-card input[aria-label="Left sidebar glass blur"]')).not.toBeNull();
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
