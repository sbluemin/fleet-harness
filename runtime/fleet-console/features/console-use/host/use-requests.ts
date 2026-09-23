import { randomUUID } from "node:crypto";

/**
 * 패널 안 허용 요청 — Operation 의 AI 가 허용받지 않은 콘솔 사용·컴퓨터 사용 도구를 부르면, 거부하는 대신
 * 그 호출을 붙잡아 두고 그 Operation 패널에 허용/거절 카드를 띄운다. 사람의 답이 호출의 결말이 된다.
 *
 * - 한 Operation 의 한 도구군에는 요청이 하나뿐이다. 그사이 들어온 호출은 같은 요청에 합쳐져 한 번의 답을 함께 받는다.
 * - 「이번 작업만」 허가는 메모리에만 산다. 턴이 끝나거나(settle) 5분 동안 쓰이지 않거나 스위치를 거두면 풀리고,
 *   서버가 다시 뜨면 요청도 허가도 없다 — 붙잡혀 있던 호출은 연결과 함께 끝난다.
 * - 붙잡는 시간은 MCP 호출 상한(5분)보다 짧다. 답이 없으면 `no_response` 로 끝나 에이전트가 먼저 회신을 받는다.
 */

export type UseCapability = "console" | "computer";
export type UseAnswer = "deny" | "turn" | "always";
/** 붙잡은 호출의 결말. `authorized` 는 사람이 답하기 전에 다른 길(메뉴 스위치 등)로 허용이 선 경우다. */
export type UseHoldOutcome = "turn" | "always" | "authorized" | "declined" | "no_response" | "stopped";
export type UseRequestBlock = "experiment_disabled";

export interface UseRequestView {
  readonly id: string;
  readonly operationId: string;
  readonly capability: UseCapability;
  /** 이 요청에 합쳐진 도구 이름(중복 없이, 들어온 순서). 인자·내용은 싣지 않는다. */
  readonly tools: readonly string[];
  /** 사람이 이 카드에서 바로 허용할 수 없는 사유. 풀리면 null 로 돌아온다. */
  readonly blocked: UseRequestBlock | null;
  readonly expiresAt: number;
}

export interface UseHoldInput {
  readonly operationId: string;
  readonly capability: UseCapability;
  readonly tool: string;
  readonly signal?: AbortSignal;
  /** 지금 이 호출이 이미 허용되는가 — 메뉴 스위치가 켜지면 답을 기다리지 않고 풀어 준다. */
  readonly authorized: () => boolean;
  /** 카드에서 허용할 수 없게 막는 사유. 매 조회마다 다시 읽는다. */
  readonly blocked?: () => UseRequestBlock | null;
}

export interface UseRequestBroker {
  hold(input: UseHoldInput): Promise<UseHoldOutcome>;
  answer(operationId: string, requestId: string, answer: UseAnswer): { readonly ok: true; readonly capability: UseCapability } | { readonly ok: false; readonly error: "request_not_found" | "experiment_disabled" };
  /** 「이번 작업만」 허가가 살아 있는가. 유휴 시한을 넘긴 허가는 여기서 걷힌다. */
  granted(operationId: string, capability: UseCapability): boolean;
  /** 허가로 통과한 호출이 있었다 — 유휴 시한을 다시 잰다. */
  touch(operationId: string, capability: UseCapability): void;
  /** 턴이 끝났다 — 그 Operation 의 요청은 `stopped`, 허가는 모두 풀린다. */
  settle(operationId: string): void;
  /** 스위치를 거두었다 — 그 도구군의 요청과 허가만 걷는다. */
  revoke(operationId: string, capability: UseCapability): void;
  list(): { readonly requests: readonly UseRequestView[]; readonly grants: { readonly console: readonly string[]; readonly computer: readonly string[] } };
  dispose(): void;
}

export interface UseRequestBrokerOptions {
  readonly holdMs?: number;
  readonly idleMs?: number;
  readonly recheckMs?: number;
  readonly now?: () => number;
}

export const USE_REQUEST_HOLD_MS = 4 * 60_000;
export const USE_GRANT_IDLE_MS = 5 * 60_000;

interface PendingRequest {
  readonly id: string;
  readonly operationId: string;
  readonly capability: UseCapability;
  readonly tools: string[];
  readonly expiresAt: number;
  readonly waiters: Set<{ readonly input: UseHoldInput; readonly resolve: (outcome: UseHoldOutcome) => void }>;
  readonly timer: ReturnType<typeof setTimeout>;
}

const key = (operationId: string, capability: UseCapability) => `${capability}:${operationId}`;

export function createUseRequestBroker(options: UseRequestBrokerOptions = {}): UseRequestBroker {
  const holdMs = options.holdMs ?? USE_REQUEST_HOLD_MS;
  const idleMs = options.idleMs ?? USE_GRANT_IDLE_MS;
  const now = options.now ?? Date.now;
  const pending = new Map<string, PendingRequest>();
  const grants = new Map<string, number>();
  let disposed = false;

  const finish = (request: PendingRequest, outcome: UseHoldOutcome) => {
    if (pending.get(key(request.operationId, request.capability)) !== request) return;
    pending.delete(key(request.operationId, request.capability));
    clearTimeout(request.timer);
    for (const waiter of request.waiters) waiter.resolve(outcome);
    request.waiters.clear();
    syncRecheck();
  };

  // 메뉴 스위치·설정으로 허용이 선 것을 알아채는 순찰. 요청이 있을 때만 돈다.
  let recheck: ReturnType<typeof setInterval> | null = null;
  const syncRecheck = () => {
    if (pending.size > 0 && !recheck && !disposed) {
      recheck = setInterval(() => {
        for (const request of [...pending.values()]) {
          const waiter = request.waiters.values().next().value;
          if (waiter?.input.authorized()) finish(request, "authorized");
        }
        syncRecheck();
      }, options.recheckMs ?? 250);
      recheck.unref?.();
    } else if (pending.size === 0 && recheck) {
      clearInterval(recheck);
      recheck = null;
    }
  };

  const blockedOf = (request: PendingRequest): UseRequestBlock | null => {
    for (const waiter of request.waiters) {
      const blocked = waiter.input.blocked?.() ?? null;
      if (blocked) return blocked;
    }
    return null;
  };

  const granted = (operationId: string, capability: UseCapability) => {
    const at = grants.get(key(operationId, capability));
    if (at === undefined) return false;
    if (now() - at > idleMs) { grants.delete(key(operationId, capability)); return false; }
    return true;
  };

  return {
    hold(input) {
      if (disposed || input.signal?.aborted) return Promise.resolve("stopped");
      if (input.authorized()) return Promise.resolve("authorized");
      const k = key(input.operationId, input.capability);
      let request = pending.get(k);
      if (!request) {
        const created: PendingRequest = {
          id: randomUUID(),
          operationId: input.operationId,
          capability: input.capability,
          tools: [],
          expiresAt: now() + holdMs,
          waiters: new Set(),
          timer: setTimeout(() => finish(created, "no_response"), holdMs),
        };
        created.timer.unref?.();
        request = created;
        pending.set(k, request);
      }
      if (!request.tools.includes(input.tool)) request.tools.push(input.tool);
      const current = request;
      return new Promise<UseHoldOutcome>((resolve) => {
        const onAbort = () => {
          current.waiters.delete(waiter);
          // 이 요청을 기다리는 호출이 모두 떠났으면 카드도 내린다.
          if (current.waiters.size === 0) finish(current, "stopped");
          resolve("stopped");
        };
        const waiter = {
          input,
          resolve: (outcome: UseHoldOutcome) => { input.signal?.removeEventListener("abort", onAbort); resolve(outcome); },
        };
        current.waiters.add(waiter);
        input.signal?.addEventListener("abort", onAbort, { once: true });
        syncRecheck();
      });
    },
    answer(operationId, requestId, answer) {
      const request = [...pending.values()].find((candidate) => candidate.id === requestId && candidate.operationId === operationId);
      if (!request) return { ok: false, error: "request_not_found" };
      if (answer !== "deny" && blockedOf(request)) return { ok: false, error: "experiment_disabled" };
      if (answer === "turn") grants.set(key(operationId, request.capability), now());
      finish(request, answer === "deny" ? "declined" : answer);
      return { ok: true, capability: request.capability };
    },
    granted,
    touch(operationId, capability) {
      if (granted(operationId, capability)) grants.set(key(operationId, capability), now());
    },
    settle(operationId) {
      for (const capability of ["console", "computer"] as const) {
        grants.delete(key(operationId, capability));
        const request = pending.get(key(operationId, capability));
        if (request) finish(request, "stopped");
      }
      syncRecheck();
    },
    revoke(operationId, capability) {
      grants.delete(key(operationId, capability));
      const request = pending.get(key(operationId, capability));
      if (request) finish(request, "stopped");
      syncRecheck();
    },
    list() {
      const requests = [...pending.values()].map((request) => ({
        id: request.id,
        operationId: request.operationId,
        capability: request.capability,
        tools: [...request.tools],
        blocked: blockedOf(request),
        expiresAt: request.expiresAt,
      }));
      const active = { console: [] as string[], computer: [] as string[] };
      for (const k of [...grants.keys()]) {
        const [capability, ...rest] = k.split(":");
        const operationId = rest.join(":");
        if ((capability === "console" || capability === "computer") && granted(operationId, capability)) active[capability].push(operationId);
      }
      return { requests, grants: active };
    },
    dispose() {
      disposed = true;
      for (const request of [...pending.values()]) finish(request, "stopped");
      grants.clear();
      if (recheck) clearInterval(recheck);
      recheck = null;
    },
  };
}
