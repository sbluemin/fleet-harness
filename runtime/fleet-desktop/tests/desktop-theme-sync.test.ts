import { describe, expect, it, vi } from "vitest";

import { createDesktopThemeSynchronizer, MAX_DESKTOP_THEME_SSE_BUFFER_CHARS, parseDesktopThemeEvent } from "../src/desktop-theme-sync.js";

const DESKTOP_THEME_EVENT = "desktop:theme";

describe("desktop theme synchronizer", () => {
  it("applies the saved Console snapshot before subscribing to same-origin events", async () => {
    const applied: string[] = [];
    const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) => {
      if (String(url).endsWith("/api/v1/desktop/theme")) return jsonResponse(snapshot("future-aurora", "#123456", "#abcdef", 48));
      return new Promise<Response>(() => undefined);
    });
    const synchronizer = createDesktopThemeSynchronizer({ applyTheme: (snapshot) => applied.push(snapshot.theme), fetch });

    await synchronizer.start("http://127.0.0.1:4310");

    expect(applied).toEqual(["future-aurora"]);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:4310/api/v1/desktop/theme",
      "http://127.0.0.1:4310/api/v1/desktop/theme/events",
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { Accept: "application/json", Origin: "http://127.0.0.1:4310" },
      { Accept: "text/event-stream", Origin: "http://127.0.0.1:4310" },
    ]);
    synchronizer.stop();
  });

  it.each([404, 405])("keeps the Instrument fallback and does not subscribe when a v1 Console returns %i", async (status) => {
    const fetch = vi.fn(async (_url: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) => new Response(null, { status }));
    const applyTheme = vi.fn();
    const synchronizer = createDesktopThemeSynchronizer({ applyTheme, fetch });

    await synchronizer.start("http://127.0.0.1:4310");

    expect(applyTheme).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ Accept: "application/json", Origin: "http://127.0.0.1:4310" });
  });

  it("aborts an active same-origin event stream during cleanup", async () => {
    let eventSignal: AbortSignal | undefined;
    const fetch = vi.fn((url: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      if (String(url).endsWith("/api/v1/desktop/theme")) return Promise.resolve(jsonResponse(snapshot("instrument", "#03080e", "#989fa6")));
      eventSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        eventSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const applyTheme = vi.fn();
    const synchronizer = createDesktopThemeSynchronizer({ applyTheme, fetch });

    await synchronizer.start("http://127.0.0.1:4310");
    synchronizer.stop();

    expect(applyTheme).toHaveBeenCalledWith(snapshot("instrument", "#03080e", "#989fa6"));
    expect(eventSignal?.aborted).toBe(true);
  });

  it("keeps SSE retry available after a transient snapshot failure", async () => {
    const fetch = vi.fn((url: Parameters<typeof globalThis.fetch>[0]) => {
      if (String(url).endsWith("/api/v1/desktop/theme")) return Promise.resolve(new Response(null, { status: 503 }));
      return new Promise<Response>(() => undefined);
    });
    const synchronizer = createDesktopThemeSynchronizer({ applyTheme: vi.fn(), fetch });

    await synchronizer.start("http://127.0.0.1:4310");

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:4310/api/v1/desktop/theme",
      "http://127.0.0.1:4310/api/v1/desktop/theme/events",
    ]);
    synchronizer.stop();
  });

  it("accepts an SSE frame exactly at the buffer boundary", async () => {
    let cancelled = false;
    const setTimeout = vi.fn((_callback: () => void, delay: number) => delay as never);
    const fetch = vi.fn((url: Parameters<typeof globalThis.fetch>[0]) => {
      if (String(url).endsWith("/api/v1/desktop/theme")) return Promise.resolve(jsonResponse(snapshot("instrument", "#03080e", "#989fa6")));
      const stream = new ReadableStream({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode(`${":".repeat(MAX_DESKTOP_THEME_SSE_BUFFER_CHARS)}\n\n`));
          controller.close();
        },
        cancel: () => { cancelled = true; },
      });
      return Promise.resolve(new Response(stream));
    });
    const synchronizer = createDesktopThemeSynchronizer({ applyTheme: vi.fn(), fetch, reconnectDelayMs: 1, setTimeout });

    await synchronizer.start("http://127.0.0.1:4310");
    await vi.waitFor(() => expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 1));

    expect(cancelled).toBe(false);
    synchronizer.stop();
  });

  it("cancels a terminated SSE frame one character over the buffer boundary", async () => {
    let cancelled = false;
    const setTimeout = vi.fn((_callback: () => void, delay: number) => delay as never);
    const fetch = vi.fn((url: Parameters<typeof globalThis.fetch>[0]) => {
      if (String(url).endsWith("/api/v1/desktop/theme")) return Promise.resolve(jsonResponse(snapshot("instrument", "#03080e", "#989fa6")));
      return Promise.resolve(new Response(new ReadableStream({
        start: (controller) => controller.enqueue(new TextEncoder().encode(`${":".repeat(MAX_DESKTOP_THEME_SSE_BUFFER_CHARS + 1)}\n\n`)),
        cancel: () => { cancelled = true; },
      })));
    });
    const synchronizer = createDesktopThemeSynchronizer({ applyTheme: vi.fn(), fetch, reconnectDelayMs: 1, setTimeout });

    await synchronizer.start("http://127.0.0.1:4310");
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 2);
    synchronizer.stop();
  });

  it("cancels oversized unterminated SSE frames and exponentially backs off repeats", async () => {
    let cancelled = 0;
    const scheduled: { callback: () => void; delay: number }[] = [];
    const setTimeout = vi.fn((callback: () => void, delay: number) => {
      scheduled.push({ callback, delay });
      return scheduled.length as never;
    });
    const fetch = vi.fn((url: Parameters<typeof globalThis.fetch>[0]) => {
      if (String(url).endsWith("/api/v1/desktop/theme")) return Promise.resolve(jsonResponse(snapshot("instrument", "#03080e", "#989fa6")));
      return Promise.resolve(new Response(new ReadableStream({
        start: (controller) => controller.enqueue(new TextEncoder().encode(":".repeat(MAX_DESKTOP_THEME_SSE_BUFFER_CHARS + 1))),
        cancel: () => { cancelled += 1; },
      })));
    });
    const synchronizer = createDesktopThemeSynchronizer({ applyTheme: vi.fn(), fetch, reconnectDelayMs: 1, setTimeout });

    await synchronizer.start("http://127.0.0.1:4310");
    await vi.waitFor(() => expect(cancelled).toBe(1));
    expect(scheduled.map(({ delay }) => delay)).toEqual([2]);

    scheduled[0]?.callback();
    await vi.waitFor(() => expect(cancelled).toBe(2));
    expect(scheduled.map(({ delay }) => delay)).toEqual([2, 4]);
    synchronizer.stop();
  });

  it("reconnects after an SSE close", async () => {
    let eventRequests = 0;
    let reconnect: (() => void) | undefined;
    const setTimeout = vi.fn((callback: () => void) => {
      reconnect = callback;
      return 1 as never;
    });
    const fetch = vi.fn((url: Parameters<typeof globalThis.fetch>[0]) => {
      if (String(url).endsWith("/api/v1/desktop/theme")) return Promise.resolve(jsonResponse(snapshot("instrument", "#03080e", "#989fa6")));
      eventRequests += 1;
      if (eventRequests === 1) return Promise.resolve(new Response(new ReadableStream({ start: (controller) => controller.close() })));
      return new Promise<Response>(() => undefined);
    });
    const synchronizer = createDesktopThemeSynchronizer({ applyTheme: vi.fn(), fetch, reconnectDelayMs: 1, setTimeout });

    await synchronizer.start("http://127.0.0.1:4310");
    await vi.waitFor(() => expect(reconnect).toBeTypeOf("function"));
    reconnect?.();

    await vi.waitFor(() => expect(eventRequests).toBe(2));
    synchronizer.stop();
  });

  it("rejects arbitrary origins and malformed or forged SSE payloads", async () => {
    const synchronizer = createDesktopThemeSynchronizer({ applyTheme: vi.fn(), fetch: vi.fn() });

    // 원격 콘솔이 생기면서 https origin 자체는 유효해졌다. 거절해야 하는 것은 모양이 어긋난 쪽이다.
    for (const origin of ["http://fleet.example:4310", "https://fleet.example/console/", "https://user:pw@fleet.example", "http://127.0.0.1", "not-a-url"]) {
      await expect(synchronizer.start(origin)).rejects.toThrow("desktop_theme_origin_invalid");
    }
    expect(parseDesktopThemeEvent(`event: ${DESKTOP_THEME_EVENT}\ndata: ${JSON.stringify(snapshot("future-aurora", "#123456", "#abcdef", 48))}`)).toEqual(snapshot("future-aurora", "#123456", "#abcdef", 48));
    expect(parseDesktopThemeEvent(`event: ${DESKTOP_THEME_EVENT}\ndata: {"theme":"carbon","titleBarOverlay":{"color":"white","symbolColor":"#ffffff","height":44}}`)).toBeNull();
    expect(parseDesktopThemeEvent(`event: other\ndata: ${JSON.stringify(snapshot("carbon", "#334455", "#ddeeff", 52))}`)).toBeNull();
    expect(parseDesktopThemeEvent(`event: ${DESKTOP_THEME_EVENT}\ndata: ${JSON.stringify(snapshot("carbon", "#334455", "#ddeeff", 52))}`)).toEqual(snapshot("carbon", "#334455", "#ddeeff", 52));
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function snapshot(theme: string, color: string, symbolColor: string, height = 43) {
  return { theme, titleBarOverlay: { color, symbolColor, height } } as const;
}
