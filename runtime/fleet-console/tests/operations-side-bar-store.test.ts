import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  const localStorage = createStorage();
  vi.stubGlobal("window", { innerWidth: 1440, localStorage });
  vi.stubGlobal("localStorage", localStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("two-state SideBar store", () => {
  it("clamps legacy widths to the 280px expanded minimum", async () => {
    window.localStorage.setItem("fleet-console.operations.side-width", "180");
    const store = await loadStore();

    expect(store.getSideBarState()).toMatchObject({ width: 280, collapsed: false });
    store.setSideBarWidth(56);
    expect(store.getSideBarState().width).toBe(280);
  });

  it("preserves expanded width and Theater state through close and reopen", async () => {
    const store = await loadStore();
    store.setSideBarWidth(356);
    store.setTheaterCollapsed("theater-a", true);
    store.setSideBarCollapsed(true);
    store.setSideBarCollapsed(false);

    expect(store.getSideBarState()).toEqual({ width: 356, collapsed: false, peeking: false });
    expect(window.localStorage.getItem("fleet-console.operations.theater-collapsed")).toBe('["theater-a"]');
  });

  it("does not notify for no-op width or close state writes", async () => {
    const store = await loadStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribeSideBarState(listener);

    store.setSideBarWidth(store.getSideBarState().width);
    store.setSideBarCollapsed(store.getSideBarState().collapsed);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("keeps the STATUS axis in memory only and starts a fresh module in GROUP mode", async () => {
    const store = await loadStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribeStatusAxis(listener);

    expect(store.getSideBarStatusAxis()).toBe(false);
    store.toggleSideBarStatusAxis();

    expect(store.getSideBarStatusAxis()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(window.localStorage.length).toBe(0);

    vi.resetModules();
    const reloadedStore = await loadStore();
    expect(reloadedStore.getSideBarStatusAxis()).toBe(false);
    unsubscribe();
  });

  it("derives per-Theater STATUS collapse from empty sections and keeps explicit overrides in memory only", async () => {
    const store = await loadStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribeStatusSectionCollapse(listener);

    expect(store.getSideBarStatusSectionCollapsed("theater-a", "awaiting", true)).toBe(true);
    expect(store.getSideBarStatusSectionCollapsed("theater-a", "running", false)).toBe(false);

    store.toggleSideBarStatusSectionCollapsed("theater-a", "awaiting", true);
    expect(store.getSideBarStatusSectionCollapsed("theater-a", "awaiting", true)).toBe(false);
    expect(store.getSideBarStatusSectionCollapsed("theater-a", "awaiting", false)).toBe(false);

    store.toggleSideBarStatusSectionCollapsed("theater-a", "awaiting", false);
    expect(store.getSideBarStatusSectionCollapsed("theater-a", "awaiting", true)).toBe(true);
    expect(store.getSideBarStatusSectionCollapsed("theater-b", "awaiting", false)).toBe(false);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(window.localStorage.length).toBe(0);

    vi.resetModules();
    const reloadedStore = await loadStore();
    expect(reloadedStore.getSideBarStatusSectionCollapsed("theater-a", "awaiting", true)).toBe(true);
    expect(reloadedStore.getSideBarStatusSectionCollapsed("theater-a", "awaiting", false)).toBe(false);
    unsubscribe();
  });
});

describe("SideBar glass preferences", () => {
  it("restores stored alpha and blur, clamping values from an older or hand-edited store", async () => {
    window.localStorage.setItem("fleet-console.operations.side-glass-alpha", "12");
    window.localStorage.setItem("fleet-console.operations.side-glass-blur", "999");
    const store = await loadStore();

    // 아래는 판독성 바닥(40%)이고 위는 브라우저가 실제로 그리는 반경 상한(40px)이다 —
    // 손으로 고친 값이나 옛 범위가 들어와도 화면 계약 밖으로 나가지 않는다.
    expect(store.getSideBarGlass()).toEqual({ alpha: 40, blur: 40 });
  });

  it("persists each handle on its own key and notifies subscribers once per change", async () => {
    const store = await loadStore();
    expect(store.getSideBarGlass()).toEqual({ alpha: 100, blur: 24 });

    let notified = 0;
    const unsubscribe = store.subscribeSideBarGlass(() => { notified += 1; });
    store.setSideBarGlassAlpha(70);
    store.setSideBarGlassBlur(8);
    // 같은 값 재설정은 아무 일도 아니다 — 슬라이더 드래그가 프레임마다 같은 값을 던진다.
    store.setSideBarGlassAlpha(70);
    expect(notified).toBe(2);
    unsubscribe();

    expect(window.localStorage.getItem("fleet-console.operations.side-glass-alpha")).toBe("70");
    expect(window.localStorage.getItem("fleet-console.operations.side-glass-blur")).toBe("8");

    vi.resetModules();
    const reloaded = await loadStore();
    expect(reloaded.getSideBarGlass()).toEqual({ alpha: 70, blur: 8 });
  });
});

async function loadStore() {
  return import("../core/client/src/sidebar/operations-side-bar-store.js");
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}
