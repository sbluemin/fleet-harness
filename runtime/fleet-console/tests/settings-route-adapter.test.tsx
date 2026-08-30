// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 실물 레지스트리는 번들러 가상 모듈(virtual:fleet-plugins)을 끌어와 해석 단계에서 막힌다.
vi.mock("../core/client/src/plugin-registry.js", () => ({
  usePluginRegistry: () => ({ plugins: [] }),
}));

import { __resetPaneStoreForTests, getPaneStoreSnapshot } from "../core/client/src/pane/pane-store.js";
import { closeRailPanel, getRailStoreSnapshot, setRailChromeExpanded } from "../core/client/src/rail/rail-store.js";
import { SettingsRouteAdapter } from "../core/client/src/settings/settings-route-adapter.js";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function LocationProbe() {
  const location = useLocation();
  return createElement("output", { "data-testid": "location" }, `${location.pathname}${location.search}`);
}

function mountAt(path: string): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // 프로덕션과 같은 구조로 세운다 — 어댑터는 /settings 라우트 뒤에 서므로 번역이 끝나
  // 캔버스로 갈아탄 순간 언마운트된다. 라우트 없이 세우면 effect가 계속 살아 루프를 돈다.
  act(() => {
    root!.render(createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/settings", element: createElement(SettingsRouteAdapter) }),
        createElement(Route, { path: "/operations", element: null }),
      ),
      createElement(LocationProbe),
    ));
  });
}

function currentPath(): string {
  return document.querySelector<HTMLOutputElement>('[data-testid="location"]')!.value;
}

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  __resetPaneStoreForTests();
  closeRailPanel();
  setRailChromeExpanded(false);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/**
 * 옛 `/settings` 주소의 데스크톱 번역 계약. 페이지는 은퇴했지만 북마크·이전 릴리스 링크·
 * 데스크톱 피커의 `?section=remote-access`는 계속 들어온다 — 어댑터가 레거시 id까지 해석해
 * 설정 표면을 그 자리로 열고, 주소는 캔버스로 갈아 끼운다.
 */
describe("SettingsRouteAdapter", () => {
  it("translates a legacy remote-access deep link onto the connectivity section", () => {
    mountAt("/settings?section=remote-access");

    expect(getRailStoreSnapshot().activeRailPanelId).toBe("settings");
    expect(getRailStoreSnapshot().railChromeExpanded).toBe(true);
    const [instance] = getPaneStoreSnapshot().rail;
    expect(instance?.paneId).toBe("settings");
    expect(instance?.params).toEqual({ section: "connectivity" });
    // Back이 유령 라우트를 다시 밟지 않도록 replace로 캔버스에 선다.
    expect(currentPath()).toBe("/operations");
  });

  it("falls back to appearance for an unknown section id", () => {
    mountAt("/settings?section=vanished-plugin:room");

    expect(getPaneStoreSnapshot().rail[0]?.params).toEqual({ section: "appearance" });
    expect(currentPath()).toBe("/operations");
  });
});
