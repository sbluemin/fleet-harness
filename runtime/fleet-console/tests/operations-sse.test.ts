import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../core/client/src/integration/api.js", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof import("../core/client/src/integration/api.js")>()).ApiError,
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
import { ApiError } from "../core/client/src/integration/api.js";
import { getState as readState, setState } from "../core/client/src/integration/store.js";

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
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../core/client/src/integration/store.js")>("../core/client/src/integration/store.js");
    setState({ controlReclaimed: null });
    mocks.getState.mockImplementation(actual.getState);
    mocks.fetchObserverStatus.mockResolvedValue({ version: "test", updateAvailable: false });
    vi.stubGlobal("window", new EventTarget());
  });

  afterEach(() => {
    setState({ controlReclaimed: null });
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
    mocks.getState.mockReturnValue({ activeTheaterId: "theater-1", controlReclaimed: null });
    mocks.fetchObserverStatus.mockResolvedValue(status);

    connectOperationsSse();
    TestEventSource.instances[0]?.emit("update:available");

    await vi.waitFor(() => expect(mocks.applyObserverStatus).toHaveBeenCalledWith(status));
    expect(mocks.fetchObserverStatus).toHaveBeenCalledWith("theater-1");
  });

  it("does not hydrate or connect a delayed manual snapshot from a superseded generation", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null, controlReclaimed: null });
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

  it("keeps a live session-ended frame disconnected without reloading or reconnecting", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    connectOperationsSse();
    const source = TestEventSource.instances.at(-1)!;
    source.emit("control:reclaimed", JSON.stringify({ reason: "superseded" }));
    expect(readState().controlReclaimed).toBe("superseded");
    expect(source.closed).toBe(true);
    source.onerror?.();
    reconnectOperationsSseNow();
    connectOperationsSse();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(TestEventSource.instances).toHaveLength(1);
    expect(mocks.resumeConsoleSession).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("recovers a lost session-ended frame from the retry 401 instead of joining again", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.fetchOperations.mockRejectedValue(new ApiError(401, "unauthorized", "reclaimed"));
    connectOperationsSse();
    const source = TestEventSource.instances.at(-1)!;
    source.open();
    source.onerror?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readState().controlReclaimed).toBe("reclaimed");
    expect(TestEventSource.instances).toHaveLength(1);
    expect(mocks.resumeConsoleSession).not.toHaveBeenCalled();
  });

  it("resumes vanished sessions but stops joining when the pairing has been forgotten", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.fetchOperations.mockRejectedValue(new ApiError(401, "unauthorized"));
    mocks.resumeConsoleSession.mockResolvedValueOnce(undefined).mockRejectedValue(new ApiError(401, "unauthorized"));
    connectOperationsSse();
    TestEventSource.instances.at(-1)!.open();
    TestEventSource.instances.at(-1)!.onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.resumeConsoleSession).toHaveBeenCalledTimes(1);
    expect(readState().controlReclaimed).toBeNull();
    TestEventSource.instances.at(-1)!.open();
    TestEventSource.instances.at(-1)!.onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.resumeConsoleSession).toHaveBeenCalledTimes(2);
    TestEventSource.instances.at(-1)!.onerror?.();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.resumeConsoleSession).toHaveBeenCalledTimes(2);
    expect(readState().controlReclaimed).toBeNull();
  });

  it("strictly replaces control holder snapshots and preserves them across SSE loss", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null, controlReclaimed: null });
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
