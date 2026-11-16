/**
 * delegation-intent — 위임 하나의 의도를 도구 호출 id로 적어 두고, 자식 실행 id로 찾아준다.
 *
 * 두 id는 서로 다른 자리에서만 보인다. 호출 전 판정은 `tool_use_id`를 알고 자식 실행 id는
 * 모르며, 자식 요청 헤더는 실행 id만 싣는다. 그 둘을 잇는 유일한 고지가 SDK의
 * `system/task_started`이고, 그 메시지는 (session_id, task_id, tool_use_id)를 함께 싣는다
 * (0.3.322 실측). 이 장부가 그 연결을 보관한다.
 *
 * 모든 키는 **SDK 세션 id까지 포함한 복합 키**다. Objective id와 SDK 세션 id는 다른 값이고,
 * 두 세션이 같은 도구 호출 id를 가질 수 있으므로 세션을 빼면 다른 실행의 기록을 집는다.
 *
 * 배정 자체는 여기서 정하지 않는다 — 노출·쿼터·후보 선택은 AI Gateway 정책이다. 이 장부는
 * "무엇을 요청했는가"라는 사실만 나른다.
 */

/** 호출 전 판정이 남기는 의도. 판정에 쓰이는 필드만 담는다. */
export interface DelegationIntent {
  readonly sessionId: string;
  readonly toolUseId: string;
  /** 호출자가 도구 입력에 적은 모델(alias). 등급 힌트로만 쓰인다. */
  readonly requestedModel?: string;
  /** 호출자가 부른 에이전트 이름. `Explore` 등급 판정과 "정의가 모델을 고른다" 판정에 쓰인다. */
  readonly subagentType?: string;
  /** 위임 한 줄 설명. 배정 라벨에만 쓰인다. */
  readonly description?: string;
  /**
   * 배정이 "상속"으로 끝날 때 쓸 모델 — 호출 시점의 상위 세션 모델 id.
   *
   * 후보가 없거나 모두 위험한 것은 오류가 아니라 정상 상속이다. 자식 요청은 가상 id를 싣고
   * 오므로, 상속을 실제 모델로 바꿀 근거가 여기 있어야 한다.
   */
  readonly inheritModel?: string;
}

export interface DelegationIntentLedger {
  /** 호출 전 판정에서 부른다. 용량을 넘으면 `false` — 조용히 다른 기록을 버리지 않는다. */
  record(intent: DelegationIntent): boolean;
  /** `task_started`에서 부른다. 도구 호출 id를 실행 id에 잇는다. 연결되면 true. */
  bind(input: { readonly sessionId: string; readonly toolUseId: string; readonly taskId: string }): boolean;
  /**
   * 실행 id의 의도를 기다린다. 이미 연결돼 있으면 즉시 돌려준다.
   *
   * `task_started`와 첫 HTTP 요청의 순서는 보장되지 않는다 — 실측에서도 같은 밀리초대에
   * 도착했다. 그래서 잠깐 기다리되, 시한을 넘기면 `undefined`를 돌려주고 호출자가 명시
   * 오류로 끝낸다. 여기서 임의의 기본값을 지어내면 잘못된 배정이 조용히 남는다.
   */
  awaitIntent(sessionId: string, taskId: string, timeoutMs: number): Promise<DelegationIntent | undefined>;
  /**
   * 실행 하나가 끝났다는 고지. 배정은 지우지 않는다 — 재개된 같은 작업은 새 `run_id`를 받을 뿐
   * `task_id`가 같고, 그때 다시 고르면 같은 실행이 도중에 다른 모델로 갈 수 있다.
   */
  noteTaskRunEnded(input: { readonly sessionId: string; readonly taskId: string; readonly runId?: string }): void;
  /** 세션이 접힐 때 그 세션의 기록만 걷는다. 다른 세션의 배정은 남는다. */
  releaseSession(sessionId: string): void;
  readonly size: { readonly pending: number; readonly bound: number };
}

export interface DelegationIntentLedgerOptions {
  /** 도구 호출 기록의 상한. 넘으면 새 기록을 거절한다 — 살아 있는 기록을 밀어내지 않는다. */
  readonly maxPending?: number;
  /** 실행 기록의 상한. 넘으면 새 연결을 거절한다. */
  readonly maxBound?: number;
}

const DEFAULT_MAX_PENDING = 256;
const DEFAULT_MAX_BOUND = 4096;

function keyOf(sessionId: string, id: string): string {
  return `${sessionId}\u0000${id}`;
}

export function createDelegationIntentLedger(options: DelegationIntentLedgerOptions = {}): DelegationIntentLedger {
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const maxBound = options.maxBound ?? DEFAULT_MAX_BOUND;
  const pending = new Map<string, DelegationIntent>();
  const bound = new Map<string, DelegationIntent>();
  const waiters = new Map<string, Set<() => void>>();

  const wake = (lookupKey: string): void => {
    const listeners = waiters.get(lookupKey);
    if (!listeners) return;
    waiters.delete(lookupKey);
    for (const listener of listeners) listener();
  };

  return {
    record(intent) {
      const lookupKey = keyOf(intent.sessionId, intent.toolUseId);
      const replacing = pending.has(lookupKey);
      if (!replacing && pending.size >= maxPending) return false;
      pending.delete(lookupKey);
      pending.set(lookupKey, intent);
      return true;
    },
    bind({ sessionId, toolUseId, taskId }) {
      const intent = pending.get(keyOf(sessionId, toolUseId));
      if (!intent) return false;
      const taskKey = keyOf(sessionId, taskId);
      const replacing = bound.has(taskKey);
      if (!replacing && bound.size >= maxBound) return false;
      pending.delete(keyOf(sessionId, toolUseId));
      bound.delete(taskKey);
      bound.set(taskKey, intent);
      wake(taskKey);
      return true;
    },
    awaitIntent(sessionId, taskId, timeoutMs) {
      const taskKey = keyOf(sessionId, taskId);
      const existing = bound.get(taskKey);
      if (existing) return Promise.resolve(existing);
      return new Promise<DelegationIntent | undefined>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          const listeners = waiters.get(taskKey);
          listeners?.delete(settle);
          if (listeners && listeners.size === 0) waiters.delete(taskKey);
          resolve(bound.get(taskKey));
        };
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const listeners = waiters.get(taskKey);
          listeners?.delete(settle);
          if (listeners && listeners.size === 0) waiters.delete(taskKey);
          resolve(undefined);
        }, Math.max(0, timeoutMs));
        if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
        (waiters.get(taskKey) ?? waiters.set(taskKey, new Set()).get(taskKey)!).add(settle);
      });
    },
    noteTaskRunEnded() {
      // 배정은 실행이 끝나도 남긴다. 재개는 같은 `task_id`로 돌아오므로 여기서 지우면
      // 같은 실행이 도중에 다른 모델로 갈 수 있다. 정리는 세션 종료가 맡는다.
    },
    releaseSession(sessionId) {
      const prefix = `${sessionId}\u0000`;
      for (const [lookupKey, intent] of pending) {
        if (intent.sessionId === sessionId || lookupKey.startsWith(prefix)) pending.delete(lookupKey);
      }
      for (const [lookupKey, intent] of bound) {
        if (intent.sessionId === sessionId || lookupKey.startsWith(prefix)) {
          bound.delete(lookupKey);
          wake(lookupKey);
        }
      }
    },
    get size() {
      return { pending: pending.size, bound: bound.size };
    },
  };
}
