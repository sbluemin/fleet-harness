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
});
