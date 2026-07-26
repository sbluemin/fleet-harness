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
  setConnectionState: vi.fn(),
}));

vi.mock("../core/client/src/api.js", () => ({
  fetchObserverStatus: mocks.fetchObserverStatus,
  fetchOperations: mocks.fetchOperations,
}));

vi.mock("../core/client/src/store.js", () => ({
  applyObserverStatus: mocks.applyObserverStatus,
  applyOperationUpdate: mocks.applyOperationUpdate,
  getState: mocks.getState,
  hydrateOperations: mocks.hydrateOperations,
  setConnectionState: mocks.setConnectionState,
}));

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
    expect(mocks.setConnectionState).toHaveBeenCalledWith("live");
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

  it("marks the retry attempt connecting while preserving the existing exponential retry path", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    mocks.fetchOperations.mockResolvedValue([]);

    connectOperationsSse();
    TestEventSource.instances[0]?.onerror?.();
    expect(mocks.setConnectionState).toHaveBeenLastCalledWith("offline");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.setConnectionState).toHaveBeenLastCalledWith("connecting");
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(2));
  });

  it("cancels the pending backoff and reconnects immediately", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", TestEventSource);
    mocks.getState.mockReturnValue({ activeTheaterId: null });
    mocks.fetchOperations.mockResolvedValue([]);

    reconnectOperationsSseNow();
    TestEventSource.instances[0]?.onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(2));
    TestEventSource.instances[1]?.onerror?.();

    reconnectOperationsSseNow();
    expect(TestEventSource.instances).toHaveLength(3);
    TestEventSource.instances[2]?.onerror?.();

    await vi.advanceTimersByTimeAsync(999);
    expect(TestEventSource.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(TestEventSource.instances).toHaveLength(4));
  });
});
