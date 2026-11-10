import { randomUUID } from "node:crypto";

/**
 * 패널 안 허용 요청 — Objective 의 AI 가 허용받지 않은 컴퓨터 사용 도구를 부르면, 거부하는 대신
 * 그 호출을 붙잡아 두고 그 Objective 패널에 허용/거절 카드를 띄운다. 사람의 답이 호출의 결말이 된다.
 *
 * - 한 Objective 의 한 도구군에는 요청이 하나뿐이다. 그사이 들어온 호출은 같은 요청에 합쳐져 한 번의 답을 함께 받는다.
 * - 답은 거절 또는 계속 허용이다. 계속 허용은 그 Objective 의 스위치를 켠다. 요청 자체는 메모리에만 있고, 서버가 다시 뜨면 없다.
 * - 붙잡는 시간은 MCP 호출 상한(5분)보다 짧다. 답이 없으면 `no_response` 로 끝나 에이전트가 먼저 회신을 받는다.
 */

export type UseCapability = "console" | "computer";
export type UseAnswer = "deny" | "always";
/**
 * 붙잡은 호출의 결말. `authorized` 는 사람이 답하기 전에 다른 길(메뉴 스위치 등)로 허용이 선 경우고,
 * `withdrawn` 은 사람의 답으로 허용할 수 없게 된 경우(예: 실험 스위치를 끔)다.
 */
export type UseHoldOutcome = "always" | "authorized" | "declined" | "no_response" | "stopped" | "withdrawn";

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
  /** 턴이 끝났다 — 그 Objective 의 붙잡힌 요청은 `stopped`. */
  settle(objectiveId: string): void;
  /**
   * 한 참가자만 턴을 닫았다 — 그 참가자의 붙잡힌 호출만 `stopped` 로 끝내고, 남은 waiter 가 없으면 카드를 내린다.
   * 걷을 때인지는 호출자가 판정해 `settle` 을 부른다.
   */
  leave(objectiveId: string, participantId: string): void;
  /** 스위치를 거두었다 — 그 도구군의 붙잡힌 요청을 걷는다. */
  revoke(objectiveId: string, capability: UseCapability): void;
  list(): { readonly requests: readonly UseRequestView[] };
  dispose(): void;
}

/**
 * 컴퓨터 사용 허용 요청의 기록. 브로커는 붙잡힌 호출만 들고, 보이는 요청은 이 장부를 투영한다.
 */
export interface ComputerUseLedger {
  upsert(input: { readonly objectiveId: string; readonly participantId?: string; readonly tool: string }): { readonly id: string; readonly expiresAt: number };
  answer(objectiveId: string, requestId: string, decision: "deny" | "always"): { readonly ok: true; readonly capability: "computer" } | { readonly ok: false; readonly error: "request_not_found" };
  release(requestId: string): void;
  list(): readonly UseRequestView[];
  subscribe(listener: (requestId: string, outcome: UseHoldOutcome) => void): () => void;
}

export interface UseRequestBrokerOptions {
  readonly holdMs?: number;
  readonly recheckMs?: number;
  readonly now?: () => number;
  /** 요청이 바뀔 때마다 불린다 — 호스트가 이걸로 objective-use 스냅샷을 밀어낸다. */
  readonly onChange?: () => void;
  /** 컴퓨터 사용 요청의 원천. 없으면 컴퓨터 사용도 이 브로커 안에만 둔다(테스트). */
  readonly computerLedger?: () => ComputerUseLedger | null;
}

export const USE_REQUEST_HOLD_MS = 4 * 60_000;

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
  const now = options.now ?? Date.now;
  const pending = new Map<string, PendingRequest>();
  const computerWaiters = new Map<string, Set<{ readonly input: UseHoldInput; readonly resolve: (outcome: UseHoldOutcome) => void }>>();
  let ledgerUnsubscribe = () => {};
  let ledgerBound = false;
  let disposed = false;

  const ledger = () => {
    const current = options.computerLedger?.() ?? null;
    if (current && !ledgerBound) {
      ledgerBound = true;
      ledgerUnsubscribe = current.subscribe((requestId, outcome) => finishComputer(requestId, outcome));
    }
    return current;
  };
  const finishComputer = (requestId: string, outcome: UseHoldOutcome) => {
    const waiters = computerWaiters.get(requestId);
    if (!waiters?.size) return;
    computerWaiters.delete(requestId);
    for (const waiter of waiters) waiter.resolve(outcome);
    syncRecheck();
    options.onChange?.();
  };
  const computerBusy = () => [...computerWaiters.values()].some((waiters) => waiters.size > 0);

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
    if ((pending.size > 0 || computerBusy()) && !recheck && !disposed) {
      recheck = setInterval(() => {
        for (const request of [...pending.values()]) {
          const waiter = request.waiters.values().next().value;
          if (withdrawnOf(request)) finish(request, "withdrawn");
          else if (waiter?.input.authorized()) finish(request, "authorized");
        }
        for (const [requestId, waiters] of [...computerWaiters]) {
          const waiter = waiters.values().next().value;
          if (!waiter) continue;
          const outcome = [...waiters].some((entry) => entry.input.withdrawn?.() === true) ? "withdrawn" as const : waiter.input.authorized() ? "authorized" as const : null;
          if (!outcome) continue;
          finishComputer(requestId, outcome);
          ledger()?.release(requestId);
        }
        syncRecheck();
      }, options.recheckMs ?? 250);
      recheck.unref?.();
    } else if (pending.size === 0 && !computerBusy() && recheck) {
      clearInterval(recheck);
      recheck = null;
    }
  };

  const withdrawnOf = (request: PendingRequest): boolean => [...request.waiters].some((waiter) => waiter.input.withdrawn?.() === true);

  return {
    hold(input) {
      if (disposed || input.signal?.aborted) return Promise.resolve("stopped");
      if (input.withdrawn?.() === true) return Promise.resolve("withdrawn");
      if (input.authorized()) return Promise.resolve("authorized");
      const book = input.capability === "computer" ? ledger() : null;
      if (book) {
        const created = book.upsert({ objectiveId: input.objectiveId, participantId: input.participantId, tool: input.tool });
        const waiters = computerWaiters.get(created.id) ?? new Set();
        computerWaiters.set(created.id, waiters);
        options.onChange?.();
        return new Promise<UseHoldOutcome>((resolve) => {
          const waiter = { input, resolve: (outcome: UseHoldOutcome) => { input.signal?.removeEventListener("abort", onAbort); resolve(outcome); } };
          const onAbort = () => {
            waiters.delete(waiter);
            if (waiters.size === 0) { finishComputer(created.id, "stopped"); book.release(created.id); }
            resolve("stopped");
          };
          waiters.add(waiter);
          input.signal?.addEventListener("abort", onAbort, { once: true });
          syncRecheck();
        });
      }
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
      const book = ledger();
      if (book?.list().some((request) => request.id === requestId && request.objectiveId === objectiveId)) return book.answer(objectiveId, requestId, answer);
      const request = [...pending.values()].find((candidate) => candidate.id === requestId && candidate.objectiveId === objectiveId);
      if (!request) return { ok: false, error: "request_not_found" };
      // 순찰 사이에 거두어졌으면 허용 답은 받지 않고 요청을 거둔다 — 붙잡힌 호출은 `withdrawn` 으로 끝난다.
      if (answer !== "deny" && withdrawnOf(request)) { finish(request, "withdrawn"); return { ok: false, error: "request_not_found" }; }
      finish(request, answer === "deny" ? "declined" : "always");
      return { ok: true, capability: request.capability };
    },
    settle(objectiveId) {
      const book = ledger();
      for (const request of book?.list() ?? []) if (request.objectiveId === objectiveId) { finishComputer(request.id, "stopped"); book!.release(request.id); }
      for (const capability of ["console", "computer"] as const) {
        const request = pending.get(key(objectiveId, capability));
        if (request) finish(request, "stopped");
      }
      syncRecheck();
    },
    leave(objectiveId, participantId) {
      const book = ledger();
      for (const [requestId, waiters] of [...computerWaiters]) {
        const sample = waiters.values().next().value;
        if (sample?.input.objectiveId !== objectiveId) continue;
        const leaving = [...waiters].filter((waiter) => (waiter.input.participantId ?? objectiveId) === participantId);
        if (!leaving.length) continue;
        if (leaving.length === waiters.size) { finishComputer(requestId, "stopped"); book?.release(requestId); continue; }
        for (const waiter of leaving) { waiters.delete(waiter); waiter.resolve("stopped"); }
        options.onChange?.();
      }
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
      if (capability === "computer") {
        const book = ledger();
        for (const request of book?.list() ?? []) if (request.objectiveId === objectiveId) { finishComputer(request.id, "stopped"); book!.release(request.id); }
      }
      const request = pending.get(key(objectiveId, capability));
      if (request) finish(request, "stopped");
      syncRecheck();
    },
    list() {
      const own = [...pending.values()].filter((request) => request.capability !== "computer" || !ledger()).map((request) => ({
        id: request.id,
        objectiveId: request.objectiveId,
        capability: request.capability,
        tools: [...request.tools],
        requestedBy: [...new Set([...request.waiters].map((waiter) => waiter.input.participantId ?? request.objectiveId))],
        expiresAt: request.expiresAt,
      }));
      return { requests: [...own, ...(ledger()?.list() ?? [])] };
    },
    dispose() {
      disposed = true;
      ledgerUnsubscribe();
      for (const request of [...pending.values()]) finish(request, "stopped");
      for (const requestId of [...computerWaiters.keys()]) finishComputer(requestId, "stopped");
      if (recheck) clearInterval(recheck);
      recheck = null;
    },
  };
}
