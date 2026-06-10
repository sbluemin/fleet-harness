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

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PENDING_CALLS = 64;

export function createGatewayCallQueue(deps: GatewayCallQueueDeps = {}) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPendingCalls = deps.maxPendingCalls ?? DEFAULT_MAX_PENDING_CALLS;
  const pending = new Map<string, PendingGatewayToolCall[]>();
  const delivered = new Map<string, Set<string>>();
  const waiters = new Map<string, Array<(call: PendingGatewayToolCall) => void>>();

  function enqueue(sessionId: string, callId: string, toolName: string, args: Record<string, unknown>): Promise<GatewayToolCallResult> {
    const queue = pending.get(sessionId) ?? [];
    if (queue.length >= maxPendingCalls) {
      return Promise.resolve({ content: [{ type: "text", text: "Too many pending tool calls" }], isError: true });
    }
    return new Promise((resolve, reject) => {
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

  function waitForNext(sessionId: string): Promise<PendingGatewayToolCall> {
    const existing = next(sessionId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const list = waiters.get(sessionId) ?? [];
      list.push(resolve);
      waiters.set(sessionId, list);
    });
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
    const waiter = waiters.get(sessionId)?.shift();
    if (!waiter) return;
    const call = next(sessionId);
    if (call) waiter(call);
  }

  function remove(sessionId: string, callId: string): PendingGatewayToolCall | null {
    const queue = pending.get(sessionId);
    if (!queue) return null;
    const index = queue.findIndex((call) => call.callId === callId);
    if (index < 0) return null;
    const [call] = queue.splice(index, 1);
    if (queue.length === 0) pending.delete(sessionId);
    delivered.get(sessionId)?.delete(callId);
    return call ?? null;
  }

  return { enqueue, next, waitForNext, resolveCall, clearSession, clear };
}
