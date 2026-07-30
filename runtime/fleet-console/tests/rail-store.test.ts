import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RailStoreModule = typeof import("../core/client/src/rail/rail-store.js");

async function freshStore(): Promise<RailStoreModule> {
  return import("../core/client/src/rail/rail-store.js");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestRailPanelExtraWidth", () => {
  it("① 활성 패널 요청이 panelExtraWidth에 반영된다", async () => {
    const { setActiveRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 200);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(200);
  });

  it("② 비활성 panelId 요청은 무시된다", async () => {
    const { setActiveRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 100);
    requestRailPanelExtraWidth("panel-b", 999);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(100);
  });

  it("③ setActiveRailPanel 전환 시 panelExtraWidth를 0으로 리셋", async () => {
    const { setActiveRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 300);
    setActiveRailPanel("panel-b");
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(0);
  });

  it("③ toggleRailPanel 닫기 시 panelExtraWidth를 0으로 리셋", async () => {
    const { setActiveRailPanel, toggleRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 300);
    toggleRailPanel("panel-a");
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(0);
  });

  it("③ closeRailPanel 시 panelExtraWidth를 0으로 리셋", async () => {
    const { setActiveRailPanel, closeRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 300);
    closeRailPanel();
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(0);
  });

  it("④ 음수는 0으로 정규화", async () => {
    const { setActiveRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", -100);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(0);
  });

  it("④ NaN은 0으로 정규화", async () => {
    const { setActiveRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", NaN);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(0);
  });

  it("④ Infinity는 0으로 정규화", async () => {
    const { setActiveRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", Infinity);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(0);
  });

  it("④ 소수점은 반올림된다", async () => {
    const { setActiveRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 100.6);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(101);
  });

  it("⑤ null은 0으로 처리(원복)", async () => {
    const { setActiveRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 200);
    requestRailPanelExtraWidth("panel-a", null);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(0);
  });

  it("⑥ 클램프: innerWidth - 548 상한을 초과하지 않는다", async () => {
    vi.stubGlobal("window", { innerWidth: 1000 });
    const { setActiveRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 600);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(452);
  });

  it("⑦ same-value 노옵: 동일 값 재요청 시 리스너가 호출되지 않는다", async () => {
    const { setActiveRailPanel, requestRailPanelExtraWidth, subscribeRailStore } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 200);
    const listener = vi.fn();
    subscribeRailStore(listener);
    requestRailPanelExtraWidth("panel-a", 200);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("legacy active Repository panel migration", () => {
  function stubStorage(initial: string | null) {
    const values = new Map<string, string>();
    if (initial !== null) values.set("fleet-console.rail.activePanelId", initial);
    const setItem = vi.fn((key: string, value: string) => values.set(key, value));
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem, removeItem: (key: string) => values.delete(key) });
    return { values, setItem };
  }

  it.each(["diff", "history"])("normalizes and writes back legacy %s", async (legacy) => {
    const storage = stubStorage(legacy);
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().activeRailPanelId).toBe("repository");
    expect(storage.values.get("fleet-console.rail.activePanelId")).toBe("repository");
    expect(storage.setItem).toHaveBeenCalledWith("fleet-console.rail.activePanelId", "repository");
  });

  it("seeds History as the Repository source during history migration", async () => {
    const storage = stubStorage("history");
    await freshStore();
    expect(storage.values.get("fleet-console.repository.source")).toBe("history");
    expect(storage.setItem).toHaveBeenCalledWith("fleet-console.repository.source", "history");
  });

  it.each(["repository", "terminal", null])("passes through %s without migration", async (id) => {
    const storage = stubStorage(id);
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().activeRailPanelId).toBe(id);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

describe("rail chrome state", () => {
  it("collapses and reopens chrome without changing panel or extra-width state", async () => {
    const { getRailStoreSnapshot, requestRailPanelExtraWidth, setActiveRailPanel, setRailChromeExpanded } = await freshStore();
    setActiveRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 240);
    setRailChromeExpanded(false);

    expect(getRailStoreSnapshot()).toMatchObject({
      activeRailPanelId: "panel-a",
      panelExtraWidth: 240,
      railChromeExpanded: false,
    });

    setRailChromeExpanded(true);
    expect(getRailStoreSnapshot()).toMatchObject({ activeRailPanelId: "panel-a", panelExtraWidth: 240, railChromeExpanded: true });
  });

  it("keeps chrome state independent from active-icon re-click semantics", async () => {
    const { getRailStoreSnapshot, setActiveRailPanel, setRailChromeExpanded, toggleRailPanel } = await freshStore();
    setActiveRailPanel("panel-a");
    setRailChromeExpanded(true);
    toggleRailPanel("panel-a");

    expect(getRailStoreSnapshot()).toMatchObject({ activeRailPanelId: null, railChromeExpanded: true });
  });
});

describe("rail panel behavior", () => {
  function stubPanelBehaviorStorage(initial: string | null = null) {
    const values = new Map<string, string>();
    if (initial !== null) values.set("fleet-console.rail.panelBehavior", initial);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    return values;
  }

  it("defaults to push", async () => {
    stubPanelBehaviorStorage();
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().panelBehavior).toBe("push");
  });

  it("toggles from push to overlay and back", async () => {
    stubPanelBehaviorStorage();
    const { getRailStoreSnapshot, toggleRailPanelBehavior } = await freshStore();
    toggleRailPanelBehavior();
    expect(getRailStoreSnapshot().panelBehavior).toBe("overlay");
    toggleRailPanelBehavior();
    expect(getRailStoreSnapshot().panelBehavior).toBe("push");
  });

  it("persists and restores the selected behavior", async () => {
    const values = stubPanelBehaviorStorage();
    const { setRailPanelBehavior } = await freshStore();
    setRailPanelBehavior("overlay");
    expect(values.get("fleet-console.rail.panelBehavior")).toBe("overlay");

    vi.resetModules();
    const restored = await freshStore();
    expect(restored.getRailStoreSnapshot().panelBehavior).toBe("overlay");
  });

  it("falls back to push for an unknown stored value", async () => {
    stubPanelBehaviorStorage("floating");
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().panelBehavior).toBe("push");
  });
});

describe("rail overlay alpha", () => {
  function stubOverlayAlphaStorage(initial: string | null = null) {
    const values = new Map<string, string>();
    if (initial !== null) values.set("fleet-console.rail.overlayAlpha", initial);
    const setItem = vi.fn((key: string, value: string) => values.set(key, value));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem,
      removeItem: (key: string) => values.delete(key),
    });
    return { values, setItem };
  }

  it("defaults to 100 when no value is stored", async () => {
    stubOverlayAlphaStorage();
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().overlayAlpha).toBe(100);
  });

  it.each([
    ["100", 100],
    ["90", 90],
    ["75", 75],
    ["60", 60],
    ["83", 83],
    ["150", 100],
    ["10", 40],
  ] as const)("restores stored alpha %s", async (stored, expected) => {
    stubOverlayAlphaStorage(stored);
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().overlayAlpha).toBe(expected);
  });

  it("persists 65 as an exact string", async () => {
    const storage = stubOverlayAlphaStorage();
    const { setRailOverlayAlpha } = await freshStore();
    setRailOverlayAlpha(65);
    expect(storage.values.get("fleet-console.rail.overlayAlpha")).toBe("65");
    expect(storage.setItem).toHaveBeenCalledWith("fleet-console.rail.overlayAlpha", "65");
  });

  it("clamps 37 to 40 before persisting", async () => {
    const storage = stubOverlayAlphaStorage();
    const { getRailStoreSnapshot, setRailOverlayAlpha } = await freshStore();
    setRailOverlayAlpha(37);
    expect(getRailStoreSnapshot().overlayAlpha).toBe(40);
    expect(storage.values.get("fleet-console.rail.overlayAlpha")).toBe("40");
    expect(storage.setItem).toHaveBeenCalledWith("fleet-console.rail.overlayAlpha", "40");
  });

  it("falls back to 100 for a non-numeric stored value", async () => {
    stubOverlayAlphaStorage("abc");
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().overlayAlpha).toBe(100);
  });
});
