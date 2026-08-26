// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchSearch: vi.fn(async () => ({ entries: [{ id: "storm-watch" }] })),
  fetchDrydock: vi.fn(async () => ({ pendingCount: 3, archivedCount: 1, items: [] })),
  fetchSchemaCatalog: vi.fn(async () => ({ schema: { exists: true, ref: "schema.md" }, templates: [] })),
  fetchHealth: vi.fn(async () => ({ lastDrydock: null, conflictCount: 0, pendingCount: 3 })),
}));

vi.mock("../core/client/src/codex/api.js", () => apiMocks);

import {
  CODEX_LIVE_CHANGED_EVENT,
  applyCodexChanged,
  applyCodexWatchState,
  installCodexLiveRevalidation,
  resetCodexLiveForTest,
  syncCodexLiveWorkspace,
} from "../core/client/src/codex/live.js";
import { getState, setCurrentWorkspaceId } from "../core/client/src/codex/state.js";

const WS = "79f37753da01";

/** 재검증은 여러 fetch를 동시에 띄운다 — 마이크로태스크 몇 바퀴를 돌려 전부 정착시킨다. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("codex live refresh", () => {
  beforeEach(() => {
    resetCodexLiveForTest();
    for (const mock of Object.values(apiMocks)) mock.mockClear();
    setCurrentWorkspaceId(WS);
  });

  afterEach(() => {
    resetCodexLiveForTest();
    setCurrentWorkspaceId(null);
  });

  it("re-reads the queue and the status chip when a draft is staged", async () => {
    applyCodexChanged(WS, ["queue"]);
    await settle();

    expect(apiMocks.fetchDrydock).toHaveBeenCalledTimes(1);
    // 상태 칩은 어느 범위가 변하든 함께 읽는다 — 대기 수가 그 칩에 살기 때문이다.
    expect(apiMocks.fetchHealth).toHaveBeenCalledTimes(1);
    // 문서 목록은 이 변화와 무관하므로 요청하지 않는다.
    expect(apiMocks.fetchSearch).not.toHaveBeenCalled();
    expect(getState().pendingPatchCount).toBe(3);
    expect(getState().lastCheckedAt).not.toBeNull();
  });

  it("re-reads the catalog when an entry lands in wiki/", async () => {
    applyCodexChanged(WS, ["wiki"]);
    await settle();

    expect(apiMocks.fetchSearch).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchDrydock).not.toHaveBeenCalled();
    expect(getState().index).toHaveLength(1);
  });

  /** 이벤트는 모든 화면에 방송된다 — 지금 보고 있는 워크스페이스의 것만 화면을 움직여야 한다. */
  it("ignores an event addressed to another workspace", async () => {
    applyCodexChanged("other-ws-0001", ["queue", "wiki"]);
    await settle();

    expect(apiMocks.fetchDrydock).not.toHaveBeenCalled();
    expect(apiMocks.fetchSearch).not.toHaveBeenCalled();
    expect(apiMocks.fetchHealth).not.toHaveBeenCalled();
  });

  it("tells the open reader only after the catalog has caught up", async () => {
    const order: string[] = [];
    apiMocks.fetchDrydock.mockImplementationOnce(async () => {
      order.push("revalidate");
      return { pendingCount: 9, archivedCount: 0, items: [] };
    });
    const listener = () => { order.push("notify"); };
    document.addEventListener(CODEX_LIVE_CHANGED_EVENT, listener);

    applyCodexChanged(WS, ["queue"]);
    await settle();
    document.removeEventListener(CODEX_LIVE_CHANGED_EVENT, listener);

    // 리더는 갱신된 카탈로그를 근거로 판정하므로 순서가 뒤집히면 오판한다.
    expect(order).toEqual(["revalidate", "notify"]);
  });

  it("tells the open reader what changed without touching its body", async () => {
    const seen: string[][] = [];
    const listener = (event: Event) => {
      seen.push([...(event as CustomEvent<{ scopes: string[] }>).detail.scopes]);
    };
    document.addEventListener(CODEX_LIVE_CHANGED_EVENT, listener);

    applyCodexChanged(WS, ["queue"]);
    await settle();
    document.removeEventListener(CODEX_LIVE_CHANGED_EVENT, listener);

    expect(seen).toEqual([["queue"]]);
  });

  it("falls back to periodic checking when the host watcher dies", async () => {
    expect(getState().liveState).toBe("unknown");

    applyCodexWatchState(WS, "watching");
    expect(getState().liveState).toBe("live");

    applyCodexWatchState(WS, "degraded");
    await settle();

    expect(getState().liveState).toBe("polling");
    // 강등된 순간 이미 놓친 변화가 있을 수 있으므로 한 번은 전 범위를 다시 읽는다.
    expect(apiMocks.fetchSearch).toHaveBeenCalled();
    expect(apiMocks.fetchDrydock).toHaveBeenCalled();
  });

  it("carries each workspace's own watch state across a Theater switch", async () => {
    applyCodexWatchState(WS, "degraded");
    await settle();
    expect(getState().liveState).toBe("polling");

    setCurrentWorkspaceId("fresh-ws-0002");
    syncCodexLiveWorkspace("fresh-ws-0002");
    // 새 워크스페이스에 대해서는 아직 아무 통지도 받지 못했다 — 살아 있다고 말할 근거가 없다.
    expect(getState().liveState).toBe("unknown");

    setCurrentWorkspaceId(WS);
    syncCodexLiveWorkspace(WS);
    expect(getState().liveState).toBe("polling");
  });

  /**
   * 감시 통지는 화면이 워크스페이스를 정하기 전에 도착한다. 그 순간의 통지를 흘려보내면
   * 살아 있는 감시가 영영 "연결 전"으로 표시된다 — 실측에서 실제로 그렇게 나왔다.
   */
  it("adopts a watch notice that arrived before the workspace was known", () => {
    setCurrentWorkspaceId(null);
    const uninstall = installCodexLiveRevalidation();

    applyCodexWatchState(WS, "watching");
    expect(getState().liveState).toBe("unknown");

    setCurrentWorkspaceId(WS);
    expect(getState().liveState).toBe("live");

    uninstall();
  });

  /**
   * 패널이 뜨는 동안 워크스페이스는 같은 값으로 두 번 설정된다. 그 두 번째가 감시 상태를
   * 지우면 이미 받은 "감시 중" 통지는 다시 오지 않는다 — 실측에서 이 경로로 고착됐다.
   */
  it("does not forget the watch state when the same workspace is set again", () => {
    const uninstall = installCodexLiveRevalidation();
    applyCodexWatchState(WS, "watching");
    expect(getState().liveState).toBe("live");

    setCurrentWorkspaceId(WS);
    expect(getState().liveState).toBe("live");

    uninstall();
  });

  /**
   * 스트림이 끊겼다 붙는 사이의 변화는 이벤트로 오지 않는다 — 재연결은 곧 "놓친 것이 있을 수
   * 있다"는 뜻이다.
   */
  it("catches up when the stream reconnects", async () => {
    applyCodexWatchState(WS, "watching");
    await settle();
    expect(apiMocks.fetchSearch).not.toHaveBeenCalled();

    applyCodexWatchState(WS, "watching");
    await settle();

    expect(apiMocks.fetchSearch).toHaveBeenCalled();
    expect(apiMocks.fetchDrydock).toHaveBeenCalled();
  });

  it("does not claim a fresh check when every request failed", async () => {
    applyCodexChanged(WS, ["queue"]);
    await settle();
    const checkedAt = getState().lastCheckedAt;
    expect(checkedAt).not.toBeNull();

    apiMocks.fetchDrydock.mockRejectedValueOnce(new Error("offline"));
    apiMocks.fetchHealth.mockRejectedValueOnce(new Error("offline"));
    applyCodexChanged(WS, ["queue"]);
    await settle();

    // 확인한 것이 없는데 시각을 밀면 신선도 표기가 거짓말을 한다.
    expect(getState().lastCheckedAt).toBe(checkedAt);
  });

  it("keeps the previous catalog when a revalidation request fails", async () => {
    applyCodexChanged(WS, ["wiki"]);
    await settle();
    expect(getState().index).toHaveLength(1);

    apiMocks.fetchSearch.mockRejectedValueOnce(new Error("offline"));
    applyCodexChanged(WS, ["wiki"]);
    await settle();

    expect(getState().index).toHaveLength(1);
  });
});
