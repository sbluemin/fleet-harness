/**
 * A per-origin ceiling on concurrent upstream calls, and the queue that holds the overflow.
 *
 * Node's `fetch` opens one socket per in-flight request and caps nothing per origin — measured
 * 2026-08-21: forty simultaneous requests produced forty sockets and queued none. Every gateway
 * turn is an SSE stream that holds its socket for the whole turn, so in-flight count *is* socket
 * count, and a fan-out of N agents is a fan-out of N long-lived connections from one process, one
 * address, and one credential. That is the shape an edge culls, and a cull that lands mid-stream
 * is unrecoverable at both this layer and the client's.
 *
 * The gate is a decorator over the injected `fetch` rather than a concrete HTTP client, because
 * this package's contract is that its host supplies transport. A dispatcher would bind us to one.
 *
 * Two properties matter more than the ceiling itself:
 *
 * - **The wait happens before the response commits.** A caller awaits `fetch` before it writes a
 *   status line, so a queued turn has not told the client anything yet. That keeps a queue
 *   timeout an ordinary HTTP failure the client's retry budget can act on, instead of a
 *   mid-response error that neither layer may retry.
 * - **A permit is held until the body ends**, not until the headers arrive. Releasing at headers
 *   would bound how fast turns start while leaving their sockets uncounted, which is the ceiling
 *   this file exists to impose.
 */

import type { FetchLike } from "./upstream-sse.js";

/** In-flight upstream calls one origin may hold at once. */
export const DEFAULT_MAX_IN_FLIGHT_PER_ORIGIN = 32;

/**
 * Longest a call waits for a permit before it is failed instead.
 *
 * The wait is invisible to the client — it is just a slow turn — but it cannot be unbounded, or a
 * saturated origin turns into a queue that never drains and the caller learns nothing. Failing at
 * a bound the client can retry past is the honest outcome.
 */
export const DEFAULT_MAX_QUEUE_WAIT_MS = 45_000;

export class UpstreamQueueTimeoutError extends Error {
  constructor(readonly origin: string, readonly waitedMs: number) {
    super(`Upstream ${origin} had no free connection after ${waitedMs}ms`);
    this.name = "UpstreamQueueTimeoutError";
  }
}

export interface UpstreamGateOptions {
  /** Concurrent calls allowed per origin. */
  readonly maxInFlight?: number;
  /** Longest a call waits for a permit. */
  readonly maxQueueWaitMs?: number;
}

/** What the gate is holding right now, per origin. */
export interface UpstreamGateOriginStats {
  readonly origin: string;
  readonly inFlight: number;
  readonly queued: number;
}

export interface UpstreamGate {
  /** The wrapped fetch. Drop-in for the one it decorates. */
  readonly fetch: FetchLike;
  /** Live occupancy, for a diagnostics sink or an operator surface. */
  stats(): readonly UpstreamGateOriginStats[];
  /** Reject every waiter and stop admitting. Idempotent. */
  dispose(): void;
}

type Release = () => void;

interface Waiter {
  readonly settle: (release: Release) => void;
  readonly fail: (error: unknown) => void;
  readonly cleanup: () => void;
  aborted: boolean;
}

class OriginQueue {
  private inFlight = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly origin: string,
    private readonly maxInFlight: number,
  ) {}

  get occupancy(): UpstreamGateOriginStats {
    return { origin: this.origin, inFlight: this.inFlight, queued: this.waiters.length };
  }

  get idle(): boolean {
    return this.inFlight === 0 && this.waiters.length === 0;
  }

  async acquire(signal: AbortSignal | null | undefined, maxWaitMs: number): Promise<Release> {
    if (signal?.aborted) throw signal.reason;
    if (this.inFlight < this.maxInFlight) {
      this.inFlight += 1;
      return this.releaseOnce();
    }
    return await new Promise<Release>((resolve, reject) => {
      const startedAt = Date.now();
      const waiter: Waiter = {
        aborted: false,
        settle: (release) => {
          waiter.cleanup();
          resolve(release);
        },
        fail: (error) => {
          waiter.cleanup();
          reject(error);
        },
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      const onAbort = (): void => {
        waiter.aborted = true;
        this.drop(waiter);
        waiter.fail(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        waiter.aborted = true;
        this.drop(waiter);
        waiter.fail(new UpstreamQueueTimeoutError(this.origin, Date.now() - startedAt));
      }, maxWaitMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  rejectAll(error: unknown): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter && !waiter.aborted) waiter.fail(error);
    }
  }

  private drop(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) this.waiters.splice(index, 1);
  }

  /** A permit that can be handed back exactly once, however many times its holder calls it. */
  private releaseOnce(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      this.handOff();
    };
  }

  private handOff(): void {
    while (this.waiters.length > 0 && this.inFlight < this.maxInFlight) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.aborted) continue;
      this.inFlight += 1;
      waiter.settle(this.releaseOnce());
      return;
    }
  }
}

export function createUpstreamGate(
  fetchImpl: FetchLike,
  options: UpstreamGateOptions = {},
): UpstreamGate {
  const maxInFlight = positiveInteger(options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT_PER_ORIGIN);
  const maxQueueWaitMs = positiveInteger(options.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS);
  const queues = new Map<string, OriginQueue>();
  let disposed = false;

  const queueFor = (origin: string): OriginQueue => {
    let queue = queues.get(origin);
    if (!queue) {
      queue = new OriginQueue(origin, maxInFlight);
      queues.set(origin, queue);
    }
    return queue;
  };

  // An origin nobody is using must not keep a map entry alive for the process's lifetime.
  const sweep = (origin: string): void => {
    const queue = queues.get(origin);
    if (queue?.idle) queues.delete(origin);
  };

  const gatedFetch: FetchLike = async (input, init) => {
    if (disposed) throw new Error("Upstream gate is disposed");
    const origin = originOf(input);
    if (origin === undefined) return await fetchImpl(input, init);
    const queue = queueFor(origin);
    const release = await queue.acquire(init?.signal, maxQueueWaitMs);
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      release();
      sweep(origin);
      throw error;
    }
    return holdUntilBodyEnds(response, () => {
      release();
      sweep(origin);
    });
  };

  return {
    fetch: gatedFetch,
    stats: () => [...queues.values()].map((queue) => queue.occupancy),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const error = new Error("Upstream gate is disposed");
      for (const queue of queues.values()) queue.rejectAll(error);
      queues.clear();
    },
  };
}

/**
 * Keep the permit until the response body is finished, failed, or cancelled.
 *
 * The socket lives as long as the body does, so the permit has to as well. A response that cannot
 * carry a body has already freed its socket by the time it reaches here.
 */
function holdUntilBodyEnds(response: Response, release: Release): Response {
  if (!response.body || !canCarryBody(response.status)) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const held = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(held, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function canCarryBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}

function originOf(input: string | URL | Request): string | undefined {
  try {
    const raw = typeof input === "string" || input instanceof URL ? input : input.url;
    return new URL(raw).origin;
  } catch {
    // A caller the gate cannot key is passed through rather than refused; bounding is a
    // safeguard, not an admission check.
    return undefined;
  }
}

function positiveInteger(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`Upstream gate bounds must be positive integers, received ${value}`);
  }
  return value;
}
