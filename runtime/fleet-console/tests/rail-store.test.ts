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

/* 전면 해도 개편(P3): 레일은 단일 활성 슬롯이 아니라 다중 고정(pin) 스택이다.
   push/overlay 이원은 퇴역했다 — "가리지 않는다"는 구 push 기대는 아레나 인셋이 승계한다. */

describe("pinned panel stack", () => {
  it("toggleRailPanel은 고정/해제를 오간다", async () => {
    const { toggleRailPanel, getRailStoreSnapshot } = await freshStore();
    toggleRailPanel("panel-a");
    expect(getRailStoreSnapshot().pinnedPanelIds).toEqual(["panel-a"]);
    toggleRailPanel("panel-a");
    expect(getRailStoreSnapshot().pinnedPanelIds).toEqual([]);
  });

  it("복수 고정은 핀 순서를 유지한다", async () => {
    const { toggleRailPanel, getRailStoreSnapshot } = await freshStore();
    toggleRailPanel("panel-a");
    toggleRailPanel("panel-b");
    toggleRailPanel("panel-c");
    expect(getRailStoreSnapshot().pinnedPanelIds).toEqual(["panel-a", "panel-b", "panel-c"]);
    toggleRailPanel("panel-b");
    expect(getRailStoreSnapshot().pinnedPanelIds).toEqual(["panel-a", "panel-c"]);
  });

  it("openRailPanel은 ensure-open이다 — 이미 고정된 패널을 닫지 않고 접힘만 푼다", async () => {
    const { openRailPanel, toggleRailSectionCollapsed, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    toggleRailSectionCollapsed("panel-a");
    expect(getRailStoreSnapshot().collapsedPanelIds).toEqual(["panel-a"]);
    openRailPanel("panel-a");
    expect(getRailStoreSnapshot().pinnedPanelIds).toEqual(["panel-a"]);
    expect(getRailStoreSnapshot().collapsedPanelIds).toEqual([]);
  });

  it("closeRailPanel은 해당 패널만 내린다", async () => {
    const { openRailPanel, closeRailPanel, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    openRailPanel("panel-b");
    closeRailPanel("panel-a");
    expect(getRailStoreSnapshot().pinnedPanelIds).toEqual(["panel-b"]);
  });

  it("섹션 접힘은 고정된 패널에만 걸리고, 해제 시 함께 걷힌다", async () => {
    const { openRailPanel, closeRailPanel, toggleRailSectionCollapsed, getRailStoreSnapshot } = await freshStore();
    toggleRailSectionCollapsed("panel-x");
    expect(getRailStoreSnapshot().collapsedPanelIds).toEqual([]);
    openRailPanel("panel-a");
    toggleRailSectionCollapsed("panel-a");
    expect(getRailStoreSnapshot().collapsedPanelIds).toEqual(["panel-a"]);
    closeRailPanel("panel-a");
    expect(getRailStoreSnapshot().collapsedPanelIds).toEqual([]);
  });
});

describe("requestRailPanelExtraWidth", () => {
  it("① 고정 패널 요청이 자기 항목에 반영된다", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 200);
    expect(getRailStoreSnapshot().panelExtraWidths["panel-a"]).toBe(200);
  });

  it("② 비고정 panelId 요청은 무시된다", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 100);
    requestRailPanelExtraWidth("panel-b", 999);
    expect(getRailStoreSnapshot().panelExtraWidths).toEqual({ "panel-a": 100 });
  });

  it("② 뒷섹션(비활성이던 층)도 고정돼 있으면 요구가 반영된다 — 스택 계약", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    openRailPanel("panel-b");
    requestRailPanelExtraWidth("panel-b", 180);
    expect(getRailStoreSnapshot().panelExtraWidths["panel-b"]).toBe(180);
  });

  it("③ closeRailPanel 시 그 패널의 extraWidth가 사라진다", async () => {
    const { openRailPanel, closeRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 300);
    closeRailPanel("panel-a");
    expect(getRailStoreSnapshot().panelExtraWidths["panel-a"]).toBeUndefined();
  });

  it("④ 음수는 0으로 정규화", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", -100);
    expect(getRailStoreSnapshot().panelExtraWidths["panel-a"]).toBe(0);
  });

  it("④ NaN은 0으로 정규화", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", NaN);
    expect(getRailStoreSnapshot().panelExtraWidths["panel-a"]).toBe(0);
  });

  it("④ 소수점은 반올림된다", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 100.6);
    expect(getRailStoreSnapshot().panelExtraWidths["panel-a"]).toBe(101);
  });

  it("⑤ null은 0으로 처리(원복)", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 200);
    requestRailPanelExtraWidth("panel-a", null);
    expect(getRailStoreSnapshot().panelExtraWidths["panel-a"]).toBe(0);
  });

  it("⑥ 클램프: innerWidth - 548 상한을 초과하지 않는다", async () => {
    vi.stubGlobal("window", { innerWidth: 1000 });
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 600);
    expect(getRailStoreSnapshot().panelExtraWidths["panel-a"]).toBe(452);
  });

  it("⑦ same-value 노옵: 동일 값 재요청 시 리스너가 호출되지 않는다", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, subscribeRailStore } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 200);
    const listener = vi.fn();
    subscribeRailStore(listener);
    requestRailPanelExtraWidth("panel-a", 200);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("rail occupied width report", () => {
  it("실측 점유 폭이 스토어에 반영되고 same-value는 노옵이다", async () => {
    const { reportRailOccupiedPx, getRailStoreSnapshot, subscribeRailStore } = await freshStore();
    reportRailOccupiedPx(356);
    expect(getRailStoreSnapshot().railOccupiedPx).toBe(356);
    const listener = vi.fn();
    subscribeRailStore(listener);
    reportRailOccupiedPx(356);
    expect(listener).not.toHaveBeenCalled();
    reportRailOccupiedPx(-10);
    expect(getRailStoreSnapshot().railOccupiedPx).toBe(0);
  });
});

describe("persistence and legacy migration", () => {
  function stubStorage(initial: Readonly<Record<string, string>> = {}) {
    const values = new Map<string, string>(Object.entries(initial));
    const setItem = vi.fn((key: string, value: string) => values.set(key, value));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem,
      removeItem: (key: string) => values.delete(key),
    });
    return { values, setItem };
  }

  it("고정 목록이 JSON 배열로 영속되고 재로드에 복원된다", async () => {
    const storage = stubStorage();
    const { openRailPanel } = await freshStore();
    openRailPanel("panel-a");
    openRailPanel("panel-b");
    expect(JSON.parse(storage.values.get("fleet-console.rail.pinnedPanels") ?? "[]")).toEqual(["panel-a", "panel-b"]);

    vi.resetModules();
    const restored = await freshStore();
    expect(restored.getRailStoreSnapshot().pinnedPanelIds).toEqual(["panel-a", "panel-b"]);
  });

  it("접힘 상태는 영속되지 않는다 — 세션 전용", async () => {
    const storage = stubStorage();
    const { openRailPanel, toggleRailSectionCollapsed } = await freshStore();
    openRailPanel("panel-a");
    toggleRailSectionCollapsed("panel-a");
    expect([...storage.values.keys()].some((key) => key.includes("collapsed"))).toBe(false);

    vi.resetModules();
    const restored = await freshStore();
    expect(restored.getRailStoreSnapshot().collapsedPanelIds).toEqual([]);
  });

  it("구 단일 활성 기억이 스택의 첫 고정으로 승격된다", async () => {
    const storage = stubStorage({ "fleet-console.rail.activePanelId": "terminal" });
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().pinnedPanelIds).toEqual(["terminal"]);
    expect(JSON.parse(storage.values.get("fleet-console.rail.pinnedPanels") ?? "[]")).toEqual(["terminal"]);
    expect(storage.values.has("fleet-console.rail.activePanelId")).toBe(false);
  });

  it.each(["diff", "history"])("legacy %s는 repository로 정규화되어 승격된다", async (legacy) => {
    stubStorage({ "fleet-console.rail.activePanelId": legacy });
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().pinnedPanelIds).toEqual(["repository"]);
  });

  it("legacy history는 Repository 소스 시드도 유지한다", async () => {
    const storage = stubStorage({ "fleet-console.rail.activePanelId": "history" });
    await freshStore();
    expect(storage.values.get("fleet-console.repository.source")).toBe("history");
  });

  it("legacy alerts는 빈 스택으로 승격된다", async () => {
    stubStorage({ "fleet-console.rail.activePanelId": "alerts" });
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().pinnedPanelIds).toEqual([]);
  });

  it("이미 새 키가 있으면 legacy를 읽지 않는다", async () => {
    stubStorage({
      "fleet-console.rail.pinnedPanels": JSON.stringify(["panel-b"]),
      "fleet-console.rail.activePanelId": "terminal",
    });
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().pinnedPanelIds).toEqual(["panel-b"]);
  });
});

describe("rail chrome state", () => {
  it("collapses and reopens chrome without changing pinned or extra-width state", async () => {
    const { getRailStoreSnapshot, requestRailPanelExtraWidth, openRailPanel, setRailChromeExpanded } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 240);
    setRailChromeExpanded(false);

    expect(getRailStoreSnapshot()).toMatchObject({
      pinnedPanelIds: ["panel-a"],
      panelExtraWidths: { "panel-a": 240 },
      railChromeExpanded: false,
    });

    setRailChromeExpanded(true);
    expect(getRailStoreSnapshot()).toMatchObject({ pinnedPanelIds: ["panel-a"], railChromeExpanded: true });
  });
});

describe("overlay alpha", () => {
  it("clamps into [40, 100] and persists", async () => {
    const storage = (() => {
      const values = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      });
      return values;
    })();
    const { setRailOverlayAlpha, getRailStoreSnapshot } = await freshStore();
    setRailOverlayAlpha(10);
    expect(getRailStoreSnapshot().overlayAlpha).toBe(40);
    setRailOverlayAlpha(250);
    expect(getRailStoreSnapshot().overlayAlpha).toBe(100);
    setRailOverlayAlpha(72.4);
    expect(getRailStoreSnapshot().overlayAlpha).toBe(72);
    expect(storage.get("fleet-console.rail.overlayAlpha")).toBe("72");
  });
});
