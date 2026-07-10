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

describe("path context state", () => {
  it("isolates contexts per Theater and never writes a path selection preference", async () => {
    const { getRailStoreSnapshot, hydrateRailPathContext, selectRailPathContextTheater } = await freshStore();
    await hydrateRailPathContext("a", async () => ({ kind: "directory", relPath: "packages/a", label: "a" }));
    selectRailPathContextTheater("b");
    expect(getRailStoreSnapshot().pathContext).toBeNull();
    await hydrateRailPathContext("b", async () => ({ kind: "worktree", relPath: "wt", label: "wt" }));
    selectRailPathContextTheater("a");
    expect(getRailStoreSnapshot().pathContext?.relPath).toBe("packages/a");
  });

  it("suppresses stale hydration responses", async () => {
    const { getRailStoreSnapshot, hydrateRailPathContext } = await freshStore();
    let resolveFirst!: (value: { kind: "directory"; relPath: string; label: string }) => void;
    const first = hydrateRailPathContext("a", async () => new Promise((resolve) => { resolveFirst = resolve; }));
    const second = hydrateRailPathContext("a", async () => ({ kind: "directory", relPath: "new", label: "new" }));
    await second;
    resolveFirst({ kind: "directory", relPath: "old", label: "old" });
    await first;
    expect(getRailStoreSnapshot().pathContext?.relPath).toBe("new");
  });
});
