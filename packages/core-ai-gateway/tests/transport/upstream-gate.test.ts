import { describe, expect, it, vi } from "vitest";

import {
  UpstreamQueueTimeoutError,
  createUpstreamGate,
} from "../../src/transport/upstream-gate.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A response whose body stays open until the test closes it, like a live SSE turn. */
function openStream(): { response: Response; close: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    response: new Response(body, { status: 200 }),
    close: () => controller.close(),
  };
}

async function drain(response: Response): Promise<void> {
  const reader = response.body!.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

describe("upstream gate", () => {
  it("holds a permit until the body ends, not until the headers arrive", async () => {
    const first = openStream();
    const second = openStream();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);
    const gate = createUpstreamGate(fetchMock, { maxInFlight: 1 });

    const a = await gate.fetch("https://up.example/v1");
    // Headers are back, but the stream is still open — the socket is still in use.
    expect(gate.stats()).toEqual([{ origin: "https://up.example", inFlight: 1, queued: 0 }]);

    const bPending = gate.fetch("https://up.example/v1");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(gate.stats()).toEqual([{ origin: "https://up.example", inFlight: 1, queued: 1 }]);

    first.close();
    await drain(a);
    const b = await bPending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.close();
    await drain(b);
    expect(gate.stats()).toEqual([]);
  });

  it("counts each origin separately", async () => {
    const streams = [openStream(), openStream()];
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streams[0]!.response)
      .mockResolvedValueOnce(streams[1]!.response);
    const gate = createUpstreamGate(fetchMock, { maxInFlight: 1 });

    await gate.fetch("https://one.example/v1");
    await gate.fetch("https://two.example/v1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(gate.stats()).toHaveLength(2);
  });

  it("fails a wait that outlives its bound instead of queueing forever", async () => {
    const held = openStream();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(held.response);
    const gate = createUpstreamGate(fetchMock, { maxInFlight: 1, maxQueueWaitMs: 20 });

    await gate.fetch("https://up.example/v1");
    await expect(gate.fetch("https://up.example/v1")).rejects.toBeInstanceOf(UpstreamQueueTimeoutError);
    // The timeout must not leak the slot it never took.
    expect(gate.stats()).toEqual([{ origin: "https://up.example", inFlight: 1, queued: 0 }]);
  });

  it("drops a queued call when its caller aborts", async () => {
    const held = openStream();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(held.response);
    const gate = createUpstreamGate(fetchMock, { maxInFlight: 1 });
    const caller = new AbortController();

    await gate.fetch("https://up.example/v1");
    const queued = gate.fetch("https://up.example/v1", { signal: caller.signal });
    await Promise.resolve();
    caller.abort(new Error("client disconnected"));

    await expect(queued).rejects.toThrow("client disconnected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("releases the permit when the upstream call throws", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("socket died"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const gate = createUpstreamGate(fetchMock, { maxInFlight: 1 });

    await expect(gate.fetch("https://up.example/v1")).rejects.toThrow("socket died");
    await expect(gate.fetch("https://up.example/v1")).resolves.toBeInstanceOf(Response);
  });

  it("releases the permit when the caller cancels the body", async () => {
    const held = openStream();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(held.response);
    const gate = createUpstreamGate(fetchMock, { maxInFlight: 1 });

    const response = await gate.fetch("https://up.example/v1");
    await response.body!.cancel("caller left");

    expect(gate.stats()).toEqual([]);
  });

  it("passes through a target it cannot key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok", { status: 200 }));
    const gate = createUpstreamGate(fetchMock, { maxInFlight: 1 });

    await expect(gate.fetch("not-a-url")).resolves.toBeInstanceOf(Response);
    expect(gate.stats()).toEqual([]);
  });

  it("rejects waiters on dispose", async () => {
    const held = openStream();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(held.response);
    const gate = createUpstreamGate(fetchMock, { maxInFlight: 1 });

    await gate.fetch("https://up.example/v1");
    const queued = gate.fetch("https://up.example/v1");
    await Promise.resolve();
    gate.dispose();

    await expect(queued).rejects.toThrow("disposed");
  });

  it("refuses a bound that is not a positive integer", () => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(() => createUpstreamGate(fetchMock, { maxInFlight: 0 })).toThrow(TypeError);
    expect(() => createUpstreamGate(fetchMock, { maxQueueWaitMs: -1 })).toThrow(TypeError);
  });
});
