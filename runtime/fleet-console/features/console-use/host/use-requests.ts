import { randomUUID } from "node:crypto";

/**
 * 패널 안 허용 요청 — Objective 의 AI 가 허용받지 않은 콘솔 사용·컴퓨터 사용 도구를 부르면, 거부하는 대신
 * 그 호출을 붙잡아 두고 그 Objective 패널에 허용/거절 카드를 띄운다. 사람의 답이 호출의 결말이 된다.
 *
 * - 한 Objective 의 한 도구군에는 요청이 하나뿐이다. 그사이 들어온 호출은 같은 요청에 합쳐져 한 번의 답을 함께 받는다.
 * - 「이번 작업만」 허가는 메모리에만 산다. 턴이 끝나거나(settle) 5분 동안 쓰이지 않거나 스위치를 거두면 풀리고,
 *   서버가 다시 뜨면 요청도 허가도 없다 — 붙잡혀 있던 호출은 연결과 함께 끝난다.
 * - 붙잡는 시간은 MCP 호출 상한(5분)보다 짧다. 답이 없으면 `no_response` 로 끝나 에이전트가 먼저 회신을 받는다.
 */

export type UseCapability = "console" | "computer";
export type UseAnswer = "deny" | "turn" | "always";
/**
 * 붙잡은 호출의 결말. `authorized` 는 사람이 답하기 전에 다른 길(메뉴 스위치 등)로 허용이 선 경우고,
 * `withdrawn` 은 사람의 답으로 허용할 수 없게 된 경우(예: 실험 스위치를 끔)다.
 */
export type UseHoldOutcome = "turn" | "always" | "authorized" | "declined" | "no_response" | "stopped" | "withdrawn";

export interface UseRequestView {
  readonly id: string;
  readonly objectiveId: string;
  readonly capability: UseCapability;
  /** 이 요청에 합쳐진 도구 이름(중복 없이, 들어온 순서). 인자·내용은 싣지 않는다. */
  readonly tools: readonly string[];
  /** 지금 이 요청을 기다리는 참가자(호출한 세션) id — 중복 없이, 들어온 순서. 공유 컨텍스트에서는 루트와 다를 수 있다. */
  readonly requestedBy: readonly string[];
  readonly expiresAt: number;
}

export interface UseHoldInput {
  /** 허용의 주인(공유 컨텍스트면 루트). 요청·허가는 이 키에 선다. */
  readonly objectiveId: string;
  /** 실제로 호출한 세션. 없으면 `objectiveId` 와 같다. */
  readonly participantId?: string;
  readonly capability: UseCapability;
  readonly tool: string;
  readonly signal?: AbortSignal;
  /** 지금 이 호출이 이미 허용되는가 — 메뉴 스위치가 켜지면 답을 기다리지 않고 풀어 준다. */
  readonly authorized: () => boolean;
  /** 참이 되면 사람의 답으로도 허용할 수 없다 — 카드를 거두고 `withdrawn` 으로 끝낸다. 순찰마다 다시 읽는다. */
  readonly withdrawn?: () => boolean;
}

export interface UseRequestBroker {
  hold(input: UseHoldInput): Promise<UseHoldOutcome>;
  answer(objectiveId: string, requestId: string, answer: UseAnswer): { readonly ok: true; readonly capability: UseCapability } | { readonly ok: false; readonly error: "request_not_found" };
  /** 「이번 작업만」 허가가 살아 있는가. 유휴 시한을 넘긴 허가는 여기서 걷힌다. */
  granted(objectiveId: string, capability: UseCapability): boolean;
  /** 허가로 통과한 호출이 있었다 — 유휴 시한을 다시 잰다. */
  touch(objectiveId: string, capability: UseCapability): void;
  /** 턴이 끝났다 — 그 Objective 의 요청은 `stopped`, 허가는 모두 풀린다. */
  settle(objectiveId: string): void;
  /**
   * 한 참가자만 턴을 닫았다 — 그 참가자의 붙잡힌 호출만 `stopped` 로 끝내고, 남은 waiter 가 없으면 카드를 내린다.
   * 허가는 건드리지 않는다(다른 참가자가 아직 쓰는 중일 수 있다). 걷을 때인지는 호출자가 판정해 `settle` 을 부른다.
   */
  leave(objectiveId: string, participantId: string): void;
  /** 스위치를 거두었다 — 그 도구군의 요청과 허가만 걷는다. */
  revoke(objectiveId: string, capability: UseCapability): void;
  list(): { readonly requests: readonly UseRequestView[]; readonly grants: { readonly console: readonly string[]; readonly computer: readonly string[] } };
  dispose(): void;
}

export interface UseRequestBrokerOptions {
  readonly holdMs?: number;
  readonly idleMs?: number;
  readonly recheckMs?: number;
  readonly now?: () => number;
  /** 요청·허가가 바뀔 때마다 불린다 — 호스트가 이걸로 objective-use 스냅샷을 밀어낸다. */
  readonly onChange?: () => void;
}

export const USE_REQUEST_HOLD_MS = 4 * 60_000;
export const USE_GRANT_IDLE_MS = 5 * 60_000;

interface PendingRequest {
  readonly id: string;
  readonly objectiveId: string;
  readonly capability: UseCapability;
  readonly tools: string[];
  readonly expiresAt: number;
  readonly waiters: Set<{ readonly input: UseHoldInput; readonly resolve: (outcome: UseHoldOutcome) => void }>;
  readonly timer: ReturnType<typeof setTimeout>;
}

const key = (objectiveId: string, capability: UseCapability) => `${capability}:${objectiveId}`;

export function createUseRequestBroker(options: UseRequestBrokerOptions = {}): UseRequestBroker {
  const holdMs = options.holdMs ?? USE_REQUEST_HOLD_MS;
  const idleMs = options.idleMs ?? USE_GRANT_IDLE_MS;
  const now = options.now ?? Date.now;
  const pending = new Map<string, PendingRequest>();
  const grants = new Map<string, number>();
  // 「이번 작업만」 허가의 유휴 시한 타이머. 예전에는 읽을 때만(lazy) 정리했지만, 폴링을 걷어내면
  // 아무도 읽지 않아 만료가 영영 안 온다 — 그래서 여기서 능동적으로 걷어낸다.
  const grantTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const clearGrantTimer = (k: string) => {
    const timer = grantTimers.get(k);
    if (timer !== undefined) { clearTimeout(timer); grantTimers.delete(k); }
  };
  const scheduleGrantExpiry = (k: string) => {
    clearGrantTimer(k);
    const timer = setTimeout(() => {
      grantTimers.delete(k);
      if (grants.delete(k)) options.onChange?.();
    }, idleMs);
    timer.unref?.();
    grantTimers.set(k, timer);
  };

  const finish = (request: PendingRequest, outcome: UseHoldOutcome) => {
    if (pending.get(key(request.objectiveId, request.capability)) !== request) return;
    pending.delete(key(request.objectiveId, request.capability));
    clearTimeout(request.timer);
    for (const waiter of request.waiters) waiter.resolve(outcome);
    request.waiters.clear();
    syncRecheck();
    options.onChange?.();
  };

  // 메뉴 스위치·설정으로 허용이 서거나 거두어진 것을 알아채는 순찰. 요청이 있을 때만 돈다.
  let recheck: ReturnType<typeof setInterval> | null = null;
  const syncRecheck = () => {
    if (pending.size > 0 && !recheck && !disposed) {
      recheck = setInterval(() => {
        for (const request of [...pending.values()]) {
          const waiter = request.waiters.values().next().value;
          if (withdrawnOf(request)) finish(request, "withdrawn");
          else if (waiter?.input.authorized()) finish(request, "authorized");
        }
        syncRecheck();
      }, options.recheckMs ?? 250);
      recheck.unref?.();
    } else if (pending.size === 0 && recheck) {
      clearInterval(recheck);
      recheck = null;
    }
  };

  const withdrawnOf = (request: PendingRequest): boolean => [...request.waiters].some((waiter) => waiter.input.withdrawn?.() === true);

  const granted = (objectiveId: string, capability: UseCapability) => {
    const k = key(objectiveId, capability);
    const at = grants.get(k);
    if (at === undefined) return false;
    if (now() - at > idleMs) { grants.delete(k); clearGrantTimer(k); return false; }
    return true;
  };

  return {
    hold(input) {
      if (disposed || input.signal?.aborted) return Promise.resolve("stopped");
      if (input.withdrawn?.() === true) return Promise.resolve("withdrawn");
      if (input.authorized()) return Promise.resolve("authorized");
      const k = key(input.objectiveId, input.capability);
      let request = pending.get(k);
      let changed = false;
      if (!request) {
        const created: PendingRequest = {
          id: randomUUID(),
          objectiveId: input.objectiveId,
          capability: input.capability,
          tools: [],
          expiresAt: now() + holdMs,
          waiters: new Set(),
          timer: setTimeout(() => finish(created, "no_response"), holdMs),
        };
        created.timer.unref?.();
        request = created;
        pending.set(k, request);
        changed = true;
      }
      if (!request.tools.includes(input.tool)) { request.tools.push(input.tool); changed = true; }
      // 새 참가자가 같은 카드에 합쳐지면 requestedBy 가 바뀐다 — 스냅숏을 다시 흘린다.
      if (![...request.waiters].some((waiter) => (waiter.input.participantId ?? request.objectiveId) === (input.participantId ?? input.objectiveId))) changed = true;
      if (changed) options.onChange?.();
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
    answer(objectiveId, requestId, answer) {
      const request = [...pending.values()].find((candidate) => candidate.id === requestId && candidate.objectiveId === objectiveId);
      if (!request) return { ok: false, error: "request_not_found" };
      // 순찰 사이에 거두어졌으면 허용 답은 받지 않고 요청을 거둔다 — 붙잡힌 호출은 `withdrawn` 으로 끝난다.
      if (answer !== "deny" && withdrawnOf(request)) { finish(request, "withdrawn"); return { ok: false, error: "request_not_found" }; }
      if (answer === "turn") { grants.set(key(objectiveId, request.capability), now()); scheduleGrantExpiry(key(objectiveId, request.capability)); }
      finish(request, answer === "deny" ? "declined" : answer);
      return { ok: true, capability: request.capability };
    },
    granted,
    touch(objectiveId, capability) {
      const k = key(objectiveId, capability);
      if (granted(objectiveId, capability)) { grants.set(k, now()); scheduleGrantExpiry(k); }
    },
    settle(objectiveId) {
      for (const capability of ["console", "computer"] as const) {
        const k = key(objectiveId, capability);
        const hadGrant = grants.delete(k);
        clearGrantTimer(k);
        const request = pending.get(k);
        if (request) finish(request, "stopped");
        else if (hadGrant) options.onChange?.();
      }
      syncRecheck();
    },
    leave(objectiveId, participantId) {
      for (const capability of ["console", "computer"] as const) {
        const request = pending.get(key(objectiveId, capability));
        if (!request) continue;
        const leaving = [...request.waiters].filter((waiter) => (waiter.input.participantId ?? objectiveId) === participantId);
        if (!leaving.length) continue;
        if (leaving.length === request.waiters.size) { finish(request, "stopped"); continue; }
        for (const waiter of leaving) { request.waiters.delete(waiter); waiter.resolve("stopped"); }
        options.onChange?.();
      }
    },
    revoke(objectiveId, capability) {
      const k = key(objectiveId, capability);
      const hadGrant = grants.delete(k);
      clearGrantTimer(k);
      const request = pending.get(k);
      if (request) finish(request, "stopped");
      else if (hadGrant) options.onChange?.();
      syncRecheck();
    },
    list() {
      const requests = [...pending.values()].map((request) => ({
        id: request.id,
        objectiveId: request.objectiveId,
        capability: request.capability,
        tools: [...request.tools],
        requestedBy: [...new Set([...request.waiters].map((waiter) => waiter.input.participantId ?? request.objectiveId))],
        expiresAt: request.expiresAt,
      }));
      const active = { console: [] as string[], computer: [] as string[] };
      for (const k of [...grants.keys()]) {
        const [capability, ...rest] = k.split(":");
        const objectiveId = rest.join(":");
        if ((capability === "console" || capability === "computer") && granted(objectiveId, capability)) active[capability].push(objectiveId);
      }
      return { requests, grants: active };
    },
    dispose() {
      disposed = true;
      for (const request of [...pending.values()]) finish(request, "stopped");
      grants.clear();
      for (const timer of grantTimers.values()) clearTimeout(timer);
      grantTimers.clear();
      if (recheck) clearInterval(recheck);
      recheck = null;
    },
  };
}
