import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleLockPayload } from "../core/host/console-contract-types.js";
import { createConsoleHealthClient } from "../core/host/health.js";

const LOCK: ConsoleLockPayload = {
  pid: 1234,
  host: "127.0.0.1",
  port: 37283,
  endpoint: "http://127.0.0.1:37283/",
  startedAt: 1,
  token: "bootstrap-token",
  version: "test",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("console health client", () => {
  it("returns immediately when discovery has no lock", async () => {
    const fetchImpl = vi.fn();
    const health = createConsoleHealthClient({ fetch: fetchImpl as unknown as typeof fetch });

    await expect(health.probe(null, { timeoutMs: 0 })).resolves.toEqual({
      healthy: false,
      lock: null,
      error: "lock missing",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cuts off a hanging request at the caller's total budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>(() => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }));
    const health = createConsoleHealthClient({
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => Date.now(),
    });

    const resultPromise = health.probe(LOCK, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({
      healthy: false,
      lock: LOCK,
      error: "health check timed out",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight request when the owning lifecycle ends", async () => {
    const caller = new AbortController();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>(() => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }));
    const health = createConsoleHealthClient({ fetch: fetchImpl as unknown as typeof fetch });

    const resultPromise = health.probe(LOCK, { timeoutMs: 5_000, signal: caller.signal });
    caller.abort();

    await expect(resultPromise).resolves.toMatchObject({
      healthy: false,
      lock: LOCK,
      error: "health check aborted",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("shares one remaining budget between primary and legacy endpoints", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const abortedUrls: string[] = [];
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("api/v1/health")) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response("", { status: 503 })), 600);
        });
      }
      return new Promise<Response>(() => {
        init?.signal?.addEventListener("abort", () => abortedUrls.push(String(url)), { once: true });
      });
    });
    const health = createConsoleHealthClient({
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => Date.now(),
    });

    const resultPromise = health.probe(LOCK, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({ healthy: false, lock: LOCK });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `${LOCK.endpoint}api/v1/health`,
      `${LOCK.endpoint}health`,
    ]);
    expect(abortedUrls).toEqual([`${LOCK.endpoint}health`]);
    expect(Date.now()).toBe(1_000);
  });
});
