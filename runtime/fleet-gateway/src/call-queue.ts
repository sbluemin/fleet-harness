import type { GatewayQueuedToolCall, GatewayToolCallResult } from "./api-types.js";

export interface PendingGatewayToolCall extends GatewayQueuedToolCall {
  readonly resolve: (result: GatewayToolCallResult) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export interface GatewayCallQueueDeps {
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxPendingCalls?: number;
}

export interface GatewayCallEnqueueOptions {
  readonly signal?: AbortSignal;
}

interface GatewayCallWaiter {
  readonly resolve: (call: PendingGatewayToolCall | null) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PENDING_CALLS = 64;

export function createGatewayCallQueue(deps: GatewayCallQueueDeps = {}) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPendingCalls = deps.maxPendingCalls ?? DEFAULT_MAX_PENDING_CALLS;
  const pending = new Map<string, PendingGatewayToolCall[]>();
  const delivered = new Map<string, Set<string>>();
  const waiters = new Map<string, GatewayCallWaiter[]>();
  const abortListeners = new WeakMap<PendingGatewayToolCall, { readonly signal?: AbortSignal; readonly listener: () => void }>();

  function enqueue(sessionId: string, callId: string, toolName: string, args: Record<string, unknown>, options: GatewayCallEnqueueOptions = {}): Promise<GatewayToolCallResult> {
    const queue = pending.get(sessionId) ?? [];
    if (queue.length >= maxPendingCalls) {
      return Promise.resolve({ content: [{ type: "text", text: "Too many pending tool calls" }], isError: true });
    }
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        resolve(clientDisconnectedResult());
        return;
      }
      const call: PendingGatewayToolCall = {
        callId,
        sessionId,
        toolName,
        args,
        createdAt: now(),
        resolve,
        reject,
        timeout: setTimeout(() => {
          remove(sessionId, callId);
          resolve({ content: [{ type: "text", text: "Tool call timed out" }], isError: true });
        }, timeoutMs),
      };
      const abortListener = () => {
        const removed = remove(sessionId, callId);
        if (!removed) return;
        clearTimeout(removed.timeout);
        resolve(clientDisconnectedResult());
      };
      options.signal?.addEventListener("abort", abortListener, { once: true });
      abortListeners.set(call, { signal: options.signal, listener: abortListener });
      queue.push(call);
      pending.set(sessionId, queue);
      notify(sessionId);
    });
  }

  function next(sessionId: string): PendingGatewayToolCall | null {
    const queue = pending.get(sessionId);
    const deliveredSet = delivered.get(sessionId) ?? new Set<string>();
    for (const call of queue ?? []) {
      if (!deliveredSet.has(call.callId)) {
        deliveredSet.add(call.callId);
        delivered.set(sessionId, deliveredSet);
        return call;
      }
    }
    return null;
  }

  function waitForNext(sessionId: string, options: { readonly signal?: AbortSignal } = {}): Promise<PendingGatewayToolCall | null> {
    const existing = next(sessionId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      if (options.signal?.aborted) {
        resolve(null);
        return;
      }
      const list = waiters.get(sessionId) ?? [];
      const waiter: GatewayCallWaiter = { resolve, signal: options.signal };
      waiter.abortListener = () => {
        removeWaiter(sessionId, waiter);
        resolve(null);
      };
      options.signal?.addEventListener("abort", waiter.abortListener, { once: true });
      list.push(waiter);
      waiters.set(sessionId, list);
    });
  }

  function releaseDelivered(sessionId: string, callId: string): boolean {
    const queue = pending.get(sessionId);
    if (!queue?.some((call) => call.callId === callId)) return false;
    const didRelease = delivered.get(sessionId)?.delete(callId) ?? false;
    if (didRelease) notify(sessionId);
    return didRelease;
  }

  function releaseDeliveredForSession(sessionId: string): number {
    const queue = pending.get(sessionId);
    const deliveredSet = delivered.get(sessionId);
    if (!queue || !deliveredSet) return 0;
    let released = 0;
    for (const call of queue) {
      if (deliveredSet.delete(call.callId)) released += 1;
    }
    if (deliveredSet.size === 0) delivered.delete(sessionId);
    if (released > 0) notify(sessionId);
    return released;
  }

  function resolveCall(sessionId: string, callId: string, result: GatewayToolCallResult): boolean {
    const call = remove(sessionId, callId);
    if (!call) return false;
    clearTimeout(call.timeout);
    call.resolve(result);
    return true;
  }

  function clearSession(sessionId: string): void {
    const queue = pending.get(sessionId) ?? [];
    for (const call of queue) {
      clearTimeout(call.timeout);
      clearCallAbortListener(call);
      call.resolve({ content: [{ type: "text", text: "Session closed" }], isError: true });
    }
    pending.delete(sessionId);
    delivered.delete(sessionId);
    waiters.delete(sessionId);
  }

  function clear(): void {
    for (const sessionId of Array.from(pending.keys())) clearSession(sessionId);
  }

  function notify(sessionId: string): void {
    const list = waiters.get(sessionId);
    while (list && list.length > 0) {
      const waiter = list.shift();
      if (!waiter) continue;
      if (waiter.signal?.aborted) continue;
      const call = next(sessionId);
      if (!call) {
        list.unshift(waiter);
        return;
      }
      clearWaiterAbortListener(waiter);
      waiter.resolve(call);
      return;
    }
    if (list?.length === 0) waiters.delete(sessionId);
  }

  function remove(sessionId: string, callId: string): PendingGatewayToolCall | null {
    const queue = pending.get(sessionId);
    if (!queue) return null;
    const index = queue.findIndex((call) => call.callId === callId);
    if (index < 0) return null;
    const [call] = queue.splice(index, 1);
    if (queue.length === 0) pending.delete(sessionId);
    delivered.get(sessionId)?.delete(callId);
    if (call) clearCallAbortListener(call);
    return call ?? null;
  }

  function removeWaiter(sessionId: string, waiter: GatewayCallWaiter): void {
    const list = waiters.get(sessionId);
    if (!list) return;
    const index = list.indexOf(waiter);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) waiters.delete(sessionId);
    clearWaiterAbortListener(waiter);
  }

  function clearWaiterAbortListener(waiter: GatewayCallWaiter): void {
    if (!waiter.signal || !waiter.abortListener) return;
    waiter.signal.removeEventListener("abort", waiter.abortListener);
    waiter.abortListener = undefined;
  }

  function clearCallAbortListener(call: PendingGatewayToolCall): void {
    const entry = abortListeners.get(call);
    if (!entry?.signal) return;
    entry.signal.removeEventListener("abort", entry.listener);
    abortListeners.delete(call);
  }

  return { enqueue, next, waitForNext, releaseDelivered, releaseDeliveredForSession, resolveCall, clearSession, clear };
}

function clientDisconnectedResult(): GatewayToolCallResult {
  return { content: [{ type: "text", text: "Client disconnected" }], isError: true };
}
