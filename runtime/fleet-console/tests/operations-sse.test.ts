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

vi.mock("../core/client/src/api.js", () => ({
  ApiError: class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  fetchObserverStatus: mocks.fetchObserverStatus,
  fetchOperations: mocks.fetchOperations,
  resumeConsoleSession: mocks.resumeConsoleSession,
}));

vi.mock("../core/client/src/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/client/src/store.js")>();
  return {
    ...actual,
    applyObserverStatus: mocks.applyObserverStatus,
    applyOperationUpdate: mocks.applyOperationUpdate,
    getState: mocks.getState,
    hydrateOperations: mocks.hydrateOperations,
    setConnectionState: mocks.setConnectionState,
  };
});

vi.mock("../core/client/src/desktop-fullscreen.js", () => ({
  applyDesktopFullscreenSnapshot: mocks.applyDesktopFullscreenSnapshot,
  resetDesktopFullscreenSnapshot: mocks.resetDesktopFullscreenSnapshot,
}));

import { connectOperationsSse, reconnectOperationsSseNow } from "../core/client/src/operations-sse.js";

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

  it("re-reads observer status when the SSE channel opens", async () => {
    const status = { version: "1.0.0", updateAvailable: false };
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    mocks.fetchObserverStatus.mockResolvedValue(status);

    connectOperationsSse();
    TestEventSource.instances[0]?.open();

    await vi.waitFor(() => expect(mocks.applyObserverStatus).toHaveBeenCalledWith(status));
    expect(mocks.fetchObserverStatus).toHaveBeenCalledWith(null);
    expect(mocks.fetchOperations).not.toHaveBeenCalled();
    expect(mocks.setConnectionState).toHaveBeenCalledWith("live");
  });

  it("hydrates missed operations before creating the manual reconnect source", async () => {
    const operations = [{ id: "created-while-offline" }];
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    let resolveOperations: (operations: readonly { readonly id: string }[]) => void = () => {
      throw new Error("operations fetch did not start");
    };
    mocks.fetchOperations.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOperations = resolve;
    }));

    reconnectOperationsSseNow();
    expect(TestEventSource.instances).toHaveLength(0);
    resolveOperations(operations);

    await vi.waitFor(() => expect(mocks.hydrateOperations).toHaveBeenCalledWith(operations));
    expect(TestEventSource.instances).toHaveLength(1);
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

  it("keeps one active source and ignores every callback from superseded generations", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });

    connectOperationsSse();
    const staleSource = TestEventSource.instances[0]!;
    connectOperationsSse();
    const currentSource = TestEventSource.instances[1]!;

    expect(staleSource.closed).toBe(true);
    staleSource.emit("operation:changed", JSON.stringify({ operation: { id: "stale" } }));
    staleSource.emit("update:available");
    staleSource.emit("desktop:fullscreen", JSON.stringify({ fullscreen: true }));
    staleSource.emit("control:changed", JSON.stringify({ holder: { handle: "stale", device: null, openedAt: 1 } }));
    staleSource.open();
    staleSource.onerror?.();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.applyOperationUpdate).not.toHaveBeenCalled();
    expect(mocks.fetchObserverStatus).not.toHaveBeenCalled();
    expect(mocks.applyDesktopFullscreenSnapshot).not.toHaveBeenCalled();
    expect(mocks.resetDesktopFullscreenSnapshot).not.toHaveBeenCalled();
    expect(mocks.setConnectionState).not.toHaveBeenCalled();
    expect(TestEventSource.instances).toHaveLength(2);
    expect(currentSource.closed).toBe(false);
  });

  it("trails a status refresh when a later update frame arrives in flight", async () => {
    let resolveFirstStatus: ((status: { version: string; updateAvailable: boolean }) => void) | null = null;
    const staleStatus = { version: "1.0.0", updateAvailable: false };
    const currentStatus = { version: "1.0.0", updateAvailable: true };
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    mocks.fetchObserverStatus
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstStatus = resolve;
      }))
      .mockResolvedValueOnce(currentStatus);

    connectOperationsSse();
    TestEventSource.instances[0]?.emit("update:available");
    TestEventSource.instances[0]?.emit("update:available");
    const resolveStaleStatus: (status: { version: string; updateAvailable: boolean }) => void = resolveFirstStatus ?? (() => {
      throw new Error("first status fetch did not start");
    });
    resolveStaleStatus(staleStatus);

    await vi.waitFor(() => expect(mocks.fetchObserverStatus).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.applyObserverStatus).toHaveBeenLastCalledWith(currentStatus));
  });

  it("strictly applies Desktop fullscreen frames and resets malformed frames or SSE loss", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });

    connectOperationsSse();
    TestEventSource.instances[0]?.emit("desktop:fullscreen", JSON.stringify({ fullscreen: true }));
    expect(mocks.applyDesktopFullscreenSnapshot).toHaveBeenCalledWith({ fullscreen: true });

    TestEventSource.instances[0]?.emit("desktop:fullscreen", "{not-json");
    expect(mocks.resetDesktopFullscreenSnapshot).toHaveBeenCalledOnce();
    TestEventSource.instances[0]?.onerror?.();
    expect(mocks.resetDesktopFullscreenSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.setConnectionState).toHaveBeenCalledWith("offline");
  });

  it("strictly replaces control holder snapshots and preserves them across SSE loss", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    const actualState = await vi.importActual<typeof import("../core/client/src/store.js")>("../core/client/src/store.js");
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

  it.each(["reclaimed", "superseded"] as const)("keeps a %s session ended instead of automatically taking control again", async (reason) => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });

    connectOperationsSse();
    const endedSource = TestEventSource.instances[0]!;
    endedSource.emit("control:reclaimed", JSON.stringify({ reason }));
    endedSource.onerror?.();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(endedSource.closed).toBe(true);
    expect(mocks.fetchOperations).not.toHaveBeenCalled();
    expect(mocks.resumeConsoleSession).not.toHaveBeenCalled();
    expect(TestEventSource.instances).toHaveLength(1);
  });

  it("keeps the explicit reconnect path available after a session ends", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    mocks.fetchOperations.mockResolvedValue([]);

    connectOperationsSse();
    TestEventSource.instances[0]?.emit("control:reclaimed", JSON.stringify({ reason: "reclaimed" }));
    reconnectOperationsSseNow();

    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(2));
    expect(mocks.fetchOperations).toHaveBeenCalledOnce();
    expect(mocks.resumeConsoleSession).not.toHaveBeenCalled();
  });

  it("marks the retry attempt connecting while preserving the existing exponential retry path", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    let resolveOperations: (operations: readonly []) => void = () => {
      throw new Error("operations fetch did not start");
    };
    mocks.fetchOperations.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOperations = resolve;
    }));

    connectOperationsSse();
    TestEventSource.instances[0]?.onerror?.();
    expect(mocks.setConnectionState).toHaveBeenLastCalledWith("offline");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.setConnectionState).toHaveBeenLastCalledWith("connecting");
    expect(mocks.fetchOperations).toHaveBeenCalledOnce();
    expect(TestEventSource.instances).toHaveLength(1);
    resolveOperations([]);
    await vi.waitFor(() => expect(mocks.hydrateOperations).toHaveBeenCalledWith([]));
    expect(TestEventSource.instances).toHaveLength(2);
  });

  it("cancels the pending backoff and reconnects immediately", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    mocks.fetchOperations.mockResolvedValue([]);

    reconnectOperationsSseNow();
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    TestEventSource.instances[0]?.onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(2));
    TestEventSource.instances[1]?.onerror?.();

    reconnectOperationsSseNow();
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(3));
    TestEventSource.instances[2]?.onerror?.();

    await vi.advanceTimersByTimeAsync(999);
    expect(TestEventSource.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(4));
  });

  it("discards an observer status response from a superseded connection generation", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    mocks.fetchOperations.mockResolvedValue([]);
    let resolveStaleStatus: (status: { version: string; updateAvailable: boolean }) => void = () => {
      throw new Error("status fetch did not start");
    };
    const currentStatus = { version: "2.0.0", updateAvailable: true };
    mocks.fetchObserverStatus
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveStaleStatus = resolve;
      }))
      .mockResolvedValueOnce(currentStatus);

    reconnectOperationsSseNow();
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(1));
    TestEventSource.instances[0]?.open();
    reconnectOperationsSseNow();
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(2));
    TestEventSource.instances[1]?.open();
    resolveStaleStatus({ version: "1.0.0", updateAvailable: false });

    await vi.waitFor(() => expect(mocks.fetchObserverStatus).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.applyObserverStatus).toHaveBeenCalledOnce());
    expect(mocks.applyObserverStatus).toHaveBeenCalledWith(currentStatus);
  });
});
