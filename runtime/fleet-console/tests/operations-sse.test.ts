import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyObserverStatus: vi.fn(),
  applyDesktopFullscreenSnapshot: vi.fn(),
  applyOperationUpdate: vi.fn(),
  fetchObserverStatus: vi.fn(),
  fetchOperations: vi.fn(),
  getState: vi.fn(),
  hydrateOperations: vi.fn(),
  resetDesktopFullscreenSnapshot: vi.fn(),
  resumeConsoleSession: vi.fn(),
  setConnectionState: vi.fn(),
}));

vi.mock("../core/client/src/integration/api.js", () => ({
  ApiError: class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  fetchGroups: vi.fn(async () => null),
  fetchObserverStatus: mocks.fetchObserverStatus,
  fetchOperations: mocks.fetchOperations,
  fetchTheaters: vi.fn(async () => null),
  resumeConsoleSession: mocks.resumeConsoleSession,
}));

vi.mock("../core/client/src/integration/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/client/src/integration/store.js")>();
  return {
    ...actual,
    applyObserverStatus: mocks.applyObserverStatus,
    applyOperationUpdate: mocks.applyOperationUpdate,
    getState: mocks.getState,
    hydrateOperations: mocks.hydrateOperations,
    setConnectionState: mocks.setConnectionState,
  };
});

vi.mock("../core/client/src/integration/desktop-fullscreen.js", () => ({
  applyDesktopFullscreenSnapshot: mocks.applyDesktopFullscreenSnapshot,
  resetDesktopFullscreenSnapshot: mocks.resetDesktopFullscreenSnapshot,
}));

import { connectOperationsSse, reconnectOperationsSseNow } from "../core/client/src/integration/operations-sse.js";

class TestEventSource {
  static instances: TestEventSource[] = [];

  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(_url: string) {
    TestEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const registered = this.listeners.get(type) ?? [];
    registered.push(listener);
    this.listeners.set(type, registered);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent<string>);
  }

  open(): void {
    this.onopen?.();
  }
}

describe("operations SSE update availability", () => {
  afterEach(() => {
    TestEventSource.instances = [];
    mocks.applyObserverStatus.mockReset();
    mocks.applyDesktopFullscreenSnapshot.mockReset();
    mocks.applyOperationUpdate.mockReset();
    mocks.fetchObserverStatus.mockReset();
    mocks.fetchOperations.mockReset();
    mocks.getState.mockReset();
    mocks.hydrateOperations.mockReset();
    mocks.resetDesktopFullscreenSnapshot.mockReset();
    mocks.resumeConsoleSession.mockReset();
    mocks.setConnectionState.mockReset();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("adds Operations created by another caller and updates them without duplicates or focus changes", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    const actual = await vi.importActual<typeof import("../core/client/src/integration/store.js")>("../core/client/src/integration/store.js");
    const previous = actual.getState();
    actual.setState({ operations: [], activeOperationId: null });
    mocks.applyOperationUpdate.mockImplementation(actual.applyOperationUpdate);
    try {
      connectOperationsSse();
      const operation = { id: "external-operation", theaterId: "theater-1", type: "agent", pluginId: null, title: "External launch", payload: {}, geometry: null, ts: { createdAt: 1, updatedAt: 1 } };
      const source = TestEventSource.instances.at(-1)!;
      source.emit("operation:changed", JSON.stringify({ operation }));
      expect(actual.getState().operations).toMatchObject([{ id: operation.id, title: "External launch" }]);
      source.emit("operation:changed", JSON.stringify({ operation: { ...operation, title: "Renamed" } }));
      expect(actual.getState().operations).toMatchObject([{ id: operation.id, title: "Renamed" }]);
      expect(actual.getState().operations).toHaveLength(1);
      expect(actual.getState().activeOperationId).toBeNull();
    } finally { actual.setState({ operations: previous.operations, activeOperationId: previous.activeOperationId }); }
  });

  it("re-reads observer status instead of trusting an update frame payload", async () => {
    const status = { version: "1.0.0", updateAvailable: true };
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: "theater-1" });
    mocks.fetchObserverStatus.mockResolvedValue(status);

    connectOperationsSse();
    TestEventSource.instances[0]?.emit("update:available");

    await vi.waitFor(() => expect(mocks.applyObserverStatus).toHaveBeenCalledWith(status));
    expect(mocks.fetchObserverStatus).toHaveBeenCalledWith("theater-1");
  });

  it("does not hydrate or connect a delayed manual snapshot from a superseded generation", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    let resolveStaleOperations: (operations: readonly { readonly id: string }[]) => void = () => {
      throw new Error("stale operations fetch did not start");
    };
    let resolveCurrentOperations: (operations: readonly { readonly id: string }[]) => void = () => {
      throw new Error("current operations fetch did not start");
    };
    mocks.fetchOperations
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveStaleOperations = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveCurrentOperations = resolve;
      }));

    reconnectOperationsSseNow();
    reconnectOperationsSseNow();
    resolveCurrentOperations([{ id: "current" }]);
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    resolveStaleOperations([{ id: "stale" }]);
    await vi.waitFor(() => expect(mocks.hydrateOperations).toHaveBeenCalledTimes(1));

    expect(mocks.hydrateOperations).toHaveBeenCalledWith([{ id: "current" }]);
    expect(TestEventSource.instances).toHaveLength(1);
  });

  /**
   * 회수·인계는 사람이 다시 열 때까지 끝난 채로 남는다. 모듈 변수는 reload와 함께 사라지므로, 새 문서가
   * 401에서 페어링으로 조용히 재합류하면 주인의 Take back이 몇 초 만에 뒤집힌다. 시간이 지나도 풀리지 않고,
   * 새 조인으로 세션이 살아 있는 채 스트림이 열려야만 풀린다.
   */
  it("keeps a reclaimed session ended across reload until a stream opens on a new session", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    });
    const notices: unknown[] = [];
    vi.stubGlobal("window", { dispatchEvent: (event: CustomEvent<{ reason: string }>) => { notices.push(event.detail.reason); return true; }, setTimeout: vi.fn() });
    vi.stubGlobal("location", { reload: vi.fn() });
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    mocks.fetchObserverStatus.mockResolvedValue({ version: "1.0.0" });
    mocks.resumeConsoleSession.mockResolvedValue(undefined);
    const { ApiError } = await import("../core/client/src/integration/api.js");
    connectOperationsSse();
    TestEventSource.instances.at(-1)!.emit("control:reclaimed", JSON.stringify({ reason: "reclaimed" }));
    expect(notices).toEqual(["reclaimed"]);

    // reload한 새 문서의 연결: 판단은 모듈 상태가 아니라 탭 세션에 적힌 표식으로 한다. 401을 받아도 스스로
    // 재합류하지 않고 끝난 사실만 다시 보인다 — 한참 지나도 같다.
    mocks.fetchOperations.mockRejectedValue(new ApiError(401, "unauthorized"));
    connectOperationsSse();
    TestEventSource.instances.at(-1)!.onerror?.();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.resumeConsoleSession).not.toHaveBeenCalled();
    expect(notices).toEqual(["reclaimed", "reclaimed"]);

    // 사람이 다시 열어 새로 합류한 문서: 스트림이 열리면 표식이 풀리고, 이후의 단절에서는 평소처럼 한 번 재합류한다.
    reconnectOperationsSseNow();
    await vi.advanceTimersByTimeAsync(0);
    TestEventSource.instances.at(-1)!.open();
    TestEventSource.instances.at(-1)!.onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.resumeConsoleSession).toHaveBeenCalledTimes(1);
  });

  it("strictly replaces control holder snapshots and preserves them across SSE loss", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    const actualState = await vi.importActual<typeof import("../core/client/src/integration/store.js")>("../core/client/src/integration/store.js");
    actualState.setState({ controlHolder: null, controlCurtainDismissed: false });

    connectOperationsSse();
    const holder = { handle: "remote-a", device: "Kitchen iPad", openedAt: 42 };
    TestEventSource.instances[0]?.emit("control:changed", JSON.stringify({ holder }));
    expect(actualState.getState().controlHolder).toEqual(holder);

    TestEventSource.instances[0]?.emit("control:changed", JSON.stringify({ holder: { ...holder, extra: true } }));
    TestEventSource.instances[0]?.emit("control:changed", "{not-json");
    expect(actualState.getState().controlHolder).toEqual(holder);

    TestEventSource.instances[0]?.emit("control:changed", JSON.stringify({ holder: null }));
    expect(actualState.getState().controlHolder).toBeNull();
    TestEventSource.instances[0]?.emit("control:changed", JSON.stringify({ holder }));

    TestEventSource.instances[0]?.onerror?.();
    expect(actualState.getState().controlHolder).toEqual(holder);
    actualState.setState({ controlHolder: null, controlCurtainDismissed: false });
  });
});
