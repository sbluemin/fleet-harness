import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyObserverStatus: vi.fn(),
  applyOperationUpdate: vi.fn(),
  fetchObserverStatus: vi.fn(),
  fetchOperations: vi.fn(),
  getState: vi.fn(),
  hydrateOperations: vi.fn(),
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
}));

import { connectOperationsSse } from "../core/client/src/operations-sse.js";

class TestEventSource {
  static instances: TestEventSource[] = [];

  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  private readonly listeners = new Map<string, (() => void)[]>();

  constructor(_url: string) {
    TestEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    const registered = this.listeners.get(type) ?? [];
    registered.push(listener);
    this.listeners.set(type, registered);
  }

  close(): void {}

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  open(): void {
    this.onopen?.();
  }
}

describe("operations SSE update availability", () => {
  afterEach(() => {
    TestEventSource.instances = [];
    mocks.applyObserverStatus.mockReset();
    mocks.applyOperationUpdate.mockReset();
    mocks.fetchObserverStatus.mockReset();
    mocks.fetchOperations.mockReset();
    mocks.getState.mockReset();
    mocks.hydrateOperations.mockReset();
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
});
