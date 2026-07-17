import { afterEach, describe, expect, it, vi } from "vitest";

import { createDesktopFullscreenSynchronizer } from "../src/desktop-fullscreen-sync.js";

afterEach(() => vi.useRealTimers());

describe("Desktop fullscreen synchronizer", () => {
  it("publishes only after activation with the exact origin and JSON request", async () => {
    const window = createWindow(false);
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const synchronizer = createDesktopFullscreenSynchronizer(window as never, { fetch });

    window.emit("enter-full-screen", true);
    expect(fetch).not.toHaveBeenCalled();
    synchronizer.activate("http://127.0.0.1:4310");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4310/api/v1/desktop/fullscreen", expect.objectContaining({
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:4310" },
      body: JSON.stringify({ fullscreen: true }),
      signal: expect.any(AbortSignal),
    }));
    synchronizer.stop();
  });

  it("serializes rapid native transitions so the newest state is published last", async () => {
    const window = createWindow(false);
    let resolveEnter: (() => void) | undefined;
    const fetch = vi.fn((_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      if (init?.body === JSON.stringify({ fullscreen: true })) return new Promise<Response>((resolve) => { resolveEnter = () => resolve(new Response(null, { status: 204 })); });
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const synchronizer = createDesktopFullscreenSynchronizer(window as never, { fetch });
    synchronizer.activate("http://127.0.0.1:4310");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    window.emit("enter-full-screen", true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    window.emit("leave-full-screen", false);
    resolveEnter?.();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ fullscreen: false }),
      JSON.stringify({ fullscreen: true }),
      JSON.stringify({ fullscreen: false }),
    ]);
    synchronizer.stop();
  });

  it("queues a previous-origin reset after its unresolved publication while the new origin proceeds", async () => {
    const window = createWindow(true);
    let resolveOldTrue: (() => void) | undefined;
    const fetch = vi.fn((url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      if (String(url).startsWith("http://127.0.0.1:4310") && init?.body === JSON.stringify({ fullscreen: true })) {
        return new Promise<Response>((resolve) => { resolveOldTrue = () => resolve(new Response(null, { status: 204 })); });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const synchronizer = createDesktopFullscreenSynchronizer(window as never, { fetch });
    synchronizer.activate("http://127.0.0.1:4310");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    synchronizer.activate("http://127.0.0.1:4311");
    synchronizer.reset("http://127.0.0.1:4310");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(String(fetch.mock.calls[1]?.[0]).startsWith("http://127.0.0.1:4311")).toBe(true);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ fullscreen: true }));

    resolveOldTrue?.();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const oldOriginBodies = fetch.mock.calls
      .filter(([url]) => String(url).startsWith("http://127.0.0.1:4310"))
      .map(([, init]) => init?.body);
    expect(oldOriginBodies).toEqual([JSON.stringify({ fullscreen: true }), JSON.stringify({ fullscreen: false })]);
    synchronizer.stop();
  });

  it.each([404, 405])("treats %i as unsupported until the next activation", async (status) => {
    const window = createWindow(false);
    const fetch = vi.fn(async () => new Response(null, { status }));
    const synchronizer = createDesktopFullscreenSynchronizer(window as never, { fetch });
    synchronizer.activate("http://127.0.0.1:4310");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    window.emit("enter-full-screen", true);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();

    synchronizer.activate("http://127.0.0.1:4311");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    synchronizer.stop();
  });

  it("retries transient transport failures in a bounded sequence and resyncs after reload", async () => {
    const window = createWindow(true);
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const synchronizer = createDesktopFullscreenSynchronizer(window as never, { fetch });
    synchronizer.activate("http://127.0.0.1:4310");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));

    window.finishLoad();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    synchronizer.stop();
  });

  it("times out hanging requests and bounds their transient retries", async () => {
    vi.useFakeTimers();
    const window = createWindow(true);
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Promise<Response>(() => undefined);
    });
    const synchronizer = createDesktopFullscreenSynchronizer(window as never, { fetch, requestTimeoutMs: 10 });
    synchronizer.activate("http://127.0.0.1:4310");
    await vi.advanceTimersByTimeAsync(30);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    synchronizer.stop();
  });

  it("aborts a hanging old-origin request so a new origin publishes immediately", async () => {
    const window = createWindow(true);
    let oldSignal: AbortSignal | undefined;
    const fetch = vi.fn((url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      if (String(url).startsWith("http://127.0.0.1:4310")) {
        oldSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => oldSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const synchronizer = createDesktopFullscreenSynchronizer(window as never, { fetch });
    synchronizer.activate("http://127.0.0.1:4310");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    synchronizer.activate("http://127.0.0.1:4311");

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(oldSignal?.aborted).toBe(true);
    expect(String(fetch.mock.calls[1]?.[0]).startsWith("http://127.0.0.1:4311")).toBe(true);
    synchronizer.stop();
  });

  it("aborts outstanding work on stop and does not publish afterward", async () => {
    const window = createWindow(true);
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const synchronizer = createDesktopFullscreenSynchronizer(window as never, { fetch });
    synchronizer.activate("http://127.0.0.1:4310");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    synchronizer.stop();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    window.emit("leave-full-screen", false);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops idempotently after BrowserWindow destruction without reading webContents again", () => {
    const window = createWindow(false);
    const synchronizer = createDesktopFullscreenSynchronizer(window as never, { fetch: vi.fn() });

    window.destroy();
    expect(() => {
      synchronizer.stop();
      synchronizer.stop();
    }).not.toThrow();
  });

  it("does not infer maximize because only native fullscreen listeners are attached", () => {
    const window = createWindow(false);
    const synchronizer = createDesktopFullscreenSynchronizer(window as never, { fetch: vi.fn() });
    expect(window.windowEvents).toEqual(["enter-full-screen", "leave-full-screen"]);
    synchronizer.stop();
  });
});

function createWindow(initialFullscreen: boolean) {
  let fullscreen = initialFullscreen;
  let destroyed = false;
  const windowListeners = new Map<string, () => void>();
  const contentsListeners = new Map<string, () => void>();
  const webContents = {
    on(event: string, listener: () => void) { contentsListeners.set(event, listener); },
    removeListener(event: string) { contentsListeners.delete(event); },
  };
  return {
    windowEvents: [] as string[],
    isFullScreen: () => fullscreen,
    on(event: string, listener: () => void) {
      this.windowEvents.push(event);
      windowListeners.set(event, listener);
      return this;
    },
    removeListener(event: string) {
      windowListeners.delete(event);
      return this;
    },
    get webContents() {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return webContents;
    },
    emit(event: "enter-full-screen" | "leave-full-screen", next: boolean) {
      fullscreen = next;
      windowListeners.get(event)?.();
    },
    finishLoad() { contentsListeners.get("did-finish-load")?.(); },
    destroy() { destroyed = true; },
  };
}
