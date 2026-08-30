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

/* 레일은 단일 독점 슬롯이다 — 카드에는 패널이 하나만 상주하고, 다른 패널을 열면 교체된다.
   push/overlay 이원은 퇴역했다 — "가리지 않는다"는 구 push 기대는 아레나 인셋이 승계한다. */

describe("exclusive active panel", () => {
  it("toggleRailPanel은 열림/닫힘을 오간다", async () => {
    const { toggleRailPanel, getRailStoreSnapshot } = await freshStore();
    toggleRailPanel("panel-a");
    expect(getRailStoreSnapshot().activePanelId).toBe("panel-a");
    toggleRailPanel("panel-a");
    expect(getRailStoreSnapshot().activePanelId).toBeNull();
  });

  it("다른 패널 토글은 교체다 — 스택으로 쌓이지 않는다", async () => {
    const { toggleRailPanel, getRailStoreSnapshot } = await freshStore();
    toggleRailPanel("panel-a");
    toggleRailPanel("panel-b");
    expect(getRailStoreSnapshot().activePanelId).toBe("panel-b");
    toggleRailPanel("panel-c");
    expect(getRailStoreSnapshot().activePanelId).toBe("panel-c");
  });

  it("openRailPanel은 ensure-active다 — 이미 활성인 패널을 닫지 않는다", async () => {
    const { openRailPanel, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    openRailPanel("panel-a");
    expect(getRailStoreSnapshot().activePanelId).toBe("panel-a");
    openRailPanel("panel-b");
    expect(getRailStoreSnapshot().activePanelId).toBe("panel-b");
  });

  it("closeRailPanel은 활성 패널일 때만 내린다 — 비활성 id는 노옵", async () => {
    const { openRailPanel, closeRailPanel, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    openRailPanel("panel-b");
    closeRailPanel("panel-a");
    expect(getRailStoreSnapshot().activePanelId).toBe("panel-b");
    closeRailPanel("panel-b");
    expect(getRailStoreSnapshot().activePanelId).toBeNull();
  });
});

describe("requestRailPanelExtraWidth", () => {
  it("① 활성 패널 요청이 반영된다", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 200);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(200);
  });

  it("② 비활성 panelId 요청은 무시된다", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 100);
    requestRailPanelExtraWidth("panel-b", 999);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(100);
  });

  it("② 패널 교체는 이전 패널의 요구를 0으로 리셋한다 — 화면 밖 요구는 실체가 없다", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 180);
    openRailPanel("panel-b");
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(0);
  });

  it("③ closeRailPanel 시 extraWidth가 0으로 돌아간다", async () => {
    const { openRailPanel, closeRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 300);
    closeRailPanel("panel-a");
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(0);
  });

  it("④ 음수는 0으로 정규화", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", -100);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(0);
  });

  it("④ NaN은 0으로 정규화", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", NaN);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(0);
  });

  it("④ 소수점은 반올림된다", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 100.6);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(101);
  });

  it("⑤ null은 0으로 처리(원복)", async () => {
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 200);
    requestRailPanelExtraWidth("panel-a", null);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(0);
  });

  it("⑥ 클램프: innerWidth - 548 상한을 초과하지 않는다", async () => {
    vi.stubGlobal("window", { innerWidth: 1000 });
    const { openRailPanel, requestRailPanelExtraWidth, getRailStoreSnapshot } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 600);
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(452);
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

  it("활성 패널이 평문으로 영속되고 재로드에 복원된다 — 마지막 열림이 남는다", async () => {
    const storage = stubStorage();
    const { openRailPanel } = await freshStore();
    openRailPanel("panel-a");
    openRailPanel("panel-b");
    expect(storage.values.get("fleet-console.rail.activePanelId")).toBe("panel-b");

    vi.resetModules();
    const restored = await freshStore();
    expect(restored.getRailStoreSnapshot().activePanelId).toBe("panel-b");
  });

  it("닫으면 키가 지워져 재로드는 닫힌 레일로 시작한다", async () => {
    const storage = stubStorage();
    const { openRailPanel, closeRailPanel } = await freshStore();
    openRailPanel("panel-a");
    closeRailPanel("panel-a");
    expect(storage.values.has("fleet-console.rail.activePanelId")).toBe(false);

    vi.resetModules();
    const restored = await freshStore();
    expect(restored.getRailStoreSnapshot().activePanelId).toBeNull();
  });

  it("스택 시절 고정 목록은 첫 고정이 독점 슬롯으로 승격된다", async () => {
    const storage = stubStorage({ "fleet-console.rail.pinnedPanels": JSON.stringify(["terminal", "codex"]) });
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().activePanelId).toBe("terminal");
    expect(storage.values.get("fleet-console.rail.activePanelId")).toBe("terminal");
    expect(storage.values.has("fleet-console.rail.pinnedPanels")).toBe(false);
  });

  it("빈 스택 기억은 닫힌 레일로 승격되고 스택 키는 걷힌다", async () => {
    const storage = stubStorage({ "fleet-console.rail.pinnedPanels": "[]" });
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().activePanelId).toBeNull();
    expect(storage.values.has("fleet-console.rail.pinnedPanels")).toBe(false);
  });

  it.each(["diff", "history"])("legacy %s는 repository로 정규화되고 키가 1회 재기록된다", async (legacy) => {
    const storage = stubStorage({ "fleet-console.rail.activePanelId": legacy });
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().activePanelId).toBe("repository");
    expect(storage.values.get("fleet-console.rail.activePanelId")).toBe("repository");
  });

  it("legacy history는 Repository 소스 시드도 유지한다 — 재로드가 사용자 소스를 덮지 않는다", async () => {
    const storage = stubStorage({ "fleet-console.rail.activePanelId": "history" });
    await freshStore();
    expect(storage.values.get("fleet-console.repository.source")).toBe("history");
    expect(storage.values.get("fleet-console.rail.activePanelId")).toBe("repository");
    storage.values.set("fleet-console.repository.source", "diff");
    vi.resetModules();
    await freshStore();
    expect(storage.values.get("fleet-console.repository.source")).toBe("diff");
  });

  it("legacy alerts는 닫힌 레일로 정규화되고 키가 걷힌다", async () => {
    const storage = stubStorage({ "fleet-console.rail.activePanelId": "alerts" });
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().activePanelId).toBeNull();
    expect(storage.values.has("fleet-console.rail.activePanelId")).toBe(false);
  });

  it("활성 키가 이미 있으면 스택 키는 읽지 않고 함께 걷는다 — 지운 활성이 옛 스택으로 되살아나면 안 된다", async () => {
    const storage = stubStorage({
      "fleet-console.rail.activePanelId": "terminal",
      "fleet-console.rail.pinnedPanels": JSON.stringify(["panel-b"]),
    });
    const { getRailStoreSnapshot } = await freshStore();
    expect(getRailStoreSnapshot().activePanelId).toBe("terminal");
    expect(storage.values.has("fleet-console.rail.pinnedPanels")).toBe(false);
  });
});

describe("rail chrome state", () => {
  it("collapses and reopens chrome without changing active-panel or extra-width state", async () => {
    const { getRailStoreSnapshot, requestRailPanelExtraWidth, openRailPanel, setRailChromeExpanded } = await freshStore();
    openRailPanel("panel-a");
    requestRailPanelExtraWidth("panel-a", 240);
    setRailChromeExpanded(false);

    expect(getRailStoreSnapshot()).toMatchObject({
      activePanelId: "panel-a",
      panelExtraWidth: 240,
      railChromeExpanded: false,
    });

    setRailChromeExpanded(true);
    expect(getRailStoreSnapshot()).toMatchObject({ activePanelId: "panel-a", railChromeExpanded: true });
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
