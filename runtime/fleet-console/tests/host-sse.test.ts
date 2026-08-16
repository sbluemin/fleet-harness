import { EventEmitter } from "node:events";

import type http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SSE_KEEPALIVE_INTERVAL_MS, startSseKeepaliveLifecycle } from "../core/host/http-infra.js";

class TestResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly setTimeout = vi.fn();
  readonly write = vi.fn();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SSE keepalive lifecycle", () => {
  it("disables inactivity timeout and writes the exact heartbeat after 30 seconds", () => {
    vi.useFakeTimers();
    const res = new TestResponse();

    startSseKeepaliveLifecycle(res as unknown as http.ServerResponse, vi.fn());

    expect(res.setTimeout).toHaveBeenCalledWith(0);
    vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS - 1);
    expect(res.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(res.write).toHaveBeenCalledOnce();
    expect(res.write).toHaveBeenCalledWith(": keepalive\n\n");
  });

  it.each(["close", "error"] as const)("stops the timer and cleans up idempotently on %s", (event) => {
    vi.useFakeTimers();
    const res = new TestResponse();
    const cleanup = vi.fn();
    const stop = startSseKeepaliveLifecycle(res as unknown as http.ServerResponse, cleanup);

    res.emit(event);
    stop();
    vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS * 2);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(res.write).not.toHaveBeenCalled();
  });

  it.each([
    ["ended", { writableEnded: true, destroyed: false }],
    ["destroyed", { writableEnded: false, destroyed: true }],
  ] as const)("does not write to an %s response", (_state, responseState) => {
    vi.useFakeTimers();
    const res = new TestResponse();
    Object.assign(res, responseState);

    startSseKeepaliveLifecycle(res as unknown as http.ServerResponse, vi.fn());
    vi.advanceTimersByTime(SSE_KEEPALIVE_INTERVAL_MS);

    expect(res.write).not.toHaveBeenCalled();
  });
});
