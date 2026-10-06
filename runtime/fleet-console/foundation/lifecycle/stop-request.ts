import process from "node:process";

import {
  CONSOLE_STOP_REQUEST_PATH,
  CONSOLE_STOP_REQUEST_REVISION,
  HEALTH_PROBE_TIMEOUT_MS,
  decideConsoleStopRoute,
  type ConsoleObservedState,
  type ConsoleStopAttemptResult,
  type ConsoleStopClientRoute,
} from "@fleet-console/protocol/lifecycle";

/** The lock fields a stop request needs: where to ask, with which token, and which pid must confirm. */
export interface ConsoleStopRequestLock {
  readonly pid: number;
  readonly endpoint: string;
  readonly token?: unknown;
}

export interface RequestConsoleStopOptions {
  /** The whole budget for the POST. The stop ladder's own clock starts only after it ends. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  /** The caller's lifetime: aborting it ends the attempt as inconclusive, never as accepted. */
  readonly signal?: AbortSignal;
}

export type RequestConsoleStopResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly status?: number }
  | { readonly kind: "uncertain"; readonly error: string };

/**
 * Sends one token-authenticated stop request to the lock's Console. Accepted only on 202 with `accepted: true` and the
 * lock's own pid; any other answer is a definite rejection. A missing answer (timeout, reset, refused, an unreadable
 * 202 body) is inconclusive: the request may still have landed. Sends no Origin header.
 */
export async function requestConsoleStop(
  lock: ConsoleStopRequestLock,
  options: RequestConsoleStopOptions = {},
): Promise<RequestConsoleStopResult> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  if (typeof lock.token !== "string" || lock.token.length === 0) return { kind: "rejected" };
  let url: string;
  try {
    url = new URL(CONSOLE_STOP_REQUEST_PATH, lock.endpoint).toString();
  } catch {
    return { kind: "rejected" };
  }
  if (options.signal?.aborted) return { kind: "uncertain", error: "stop request aborted" };
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const response = await new Promise<Response>((resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error("stop request timed out"));
        controller.abort();
      }, Math.max(1, timeoutMs));
      fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${lock.token}` },
        signal: controller.signal,
      }).then(resolve, reject);
    });
    if (response.status === 202) {
      const body = await response.json().catch(() => null) as { accepted?: unknown; pid?: unknown } | null;
      // A 202 that arrived means the Console took the request path; an unreadable body says nothing about whether it
      // finished the response, so only a confirming body accepts and only a denying one rejects.
      if (body === null) return { kind: "uncertain", error: "stop request answer unreadable" };
      return body.accepted === true && body.pid === lock.pid ? { kind: "accepted" } : { kind: "rejected", status: 202 };
    }
    return { kind: "rejected", status: response.status };
  } catch (error) {
    return { kind: "uncertain", error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export interface DeliverConsoleStopInput {
  /** The lock instance to stop, or null when there is none: without a token there is no request to send. */
  readonly lock: ConsoleStopRequestLock | null;
  /**
   * The `stopRequest` advertisement already read for this lock (a 200 or a 503 `console_starting` answer), or a getter
   * that reads it. A getter runs here, once, and only on the Windows token path — so an actor that already probed for
   * readiness passes its answer, while an owned-child stop that would probe only for this never pays a probe off Windows.
   */
  readonly stopRequest?: unknown | (() => Promise<unknown>);
  /** The actor's POST budget (the CLI health probe budget, the Desktop interactive one). */
  readonly timeoutMs?: number;
  /** Injectable for the Windows-only client path. Defaults to the host platform. */
  readonly platform?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  /**
   * Observes the same lock instance again when the attempt was inconclusive. Only a Console still serving under the
   * same lock falls back to a signal; without it the route waits.
   */
  readonly observe?: () => Promise<ConsoleObservedState>;
}

/**
 * Chooses how this actor's stop reaches the Console, through the contract's single rule: POSIX always signals, and so
 * does a Console that does not advertise the stop request route or definitely rejects it. A 202-confirmed request is
 * delivered; an inconclusive attempt re-observes before deciding. The stop ladder starts after this returns, so its
 * clock never includes the POST.
 */
export async function deliverConsoleStop(input: DeliverConsoleStopInput): Promise<ConsoleStopClientRoute> {
  const platform = input.platform ?? process.platform;
  const lock = input.lock;
  const hasToken = lock !== null && typeof lock.token === "string" && lock.token.length > 0;
  if (lock === null || platform !== "win32" || !hasToken) {
    return decideConsoleStopRoute({ platform, advertised: false, result: { kind: "rejected" } });
  }
  let stopRequest: unknown;
  if (typeof input.stopRequest === "function") {
    try {
      stopRequest = await (input.stopRequest as () => Promise<unknown>)();
    } catch {
      stopRequest = undefined;
    }
  } else {
    stopRequest = input.stopRequest;
  }
  const advertised = stopRequest === CONSOLE_STOP_REQUEST_REVISION;
  if (!advertised) {
    return decideConsoleStopRoute({ platform, advertised, result: { kind: "rejected" } });
  }
  const attempt = await requestConsoleStop(lock, { timeoutMs: input.timeoutMs, fetch: input.fetch, signal: input.signal });
  let result: ConsoleStopAttemptResult;
  if (attempt.kind === "accepted") {
    result = { kind: "accepted" };
  } else if (attempt.kind === "rejected") {
    result = { kind: "rejected" };
  } else {
    // No answer is no proof either way: wait unless the Console still serves under the same lock. Without a fresh
    // observation there is nothing to prove a signal safe, so the route waits and escalation stays gated on re-proof.
    const observed = await input.observe?.().catch(() => undefined);
    result = { kind: "uncertain", observed: observed ?? "unverified" };
  }
  return decideConsoleStopRoute({ platform, advertised, result });
}
