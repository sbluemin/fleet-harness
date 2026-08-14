import type {
  ClaudeGatewayMessage,
  ClaudeGatewayRun,
  ClaudeGatewaySdk,
  ClaudeGatewayTurn,
} from "./contracts.js";
import {
  createClaudeExecutionEventDecoder,
  type ClaudeExecutionEvent,
} from "./execution-events.js";

export type ClaudeExecutionContinuation =
  | { readonly kind: "resume-child" }
  | { readonly kind: "oneshot" };

export type ClaudeExecutionSettlement =
  | { readonly kind: "result" }
  | { readonly kind: "result-required"; readonly watchdogMs?: number };

export type ClaudeExecutionTurn = Omit<ClaudeGatewayTurn, "prompt" | "resume">;

export interface ClaudeExecutionLoopOptions {
  readonly createSdk: () => Promise<ClaudeGatewaySdk>;
  readonly buildTurn: (prompt: string) => ClaudeExecutionTurn | Promise<ClaudeExecutionTurn>;
  readonly continuation: ClaudeExecutionContinuation;
  readonly settlement: ClaudeExecutionSettlement;
  readonly onEvent?: (event: ClaudeExecutionEvent) => void;
}

export interface ClaudeExecutionLoop {
  start(): Promise<void>;
  run(prompt: string): Promise<void>;
  cancel(): void;
  dispose(): Promise<void>;
}

type ClaudeResultEvent = Extract<ClaudeExecutionEvent, { kind: "result" }>;

/**
 * 한 턴의 런과 그 턴만의 종료. 늦은 정리 콜백이 지금 active인 다른 턴을 닫지 않게
 * 런 객체 식별로 close한다.
 */
interface TurnHandle {
  readonly run: ClaudeGatewayRun;
  /** 합성 결과 없이 이 턴만 닫고 대기 문을 연다. */
  stop(): void;
  /** 이 턴의 런만 한 번 close하고 active에서 뺀다. */
  close(): void;
}

/**
 * Claude 게이트웨이 턴의 실행 루프.
 *
 * SDK 생성·폐기, 직렬 큐, 세션 resume, 디코더, 종료 정산, 취소를 한 곳에서 소유한다.
 * 호출자가 넣는 것은 턴 조립과 이벤트 수신뿐이고, `prompt`와 `resume`은 루프가 쓴다 — 조립기가
 * 그 키를 실으면 호출자가 세션을 가로채거나 프롬프트를 바꿔 끼운 것과 같아서 런타임에 거부한다.
 */
export function createClaudeExecutionLoop(options: ClaudeExecutionLoopOptions): ClaudeExecutionLoop {
  let sdk: ClaudeGatewaySdk | null = null;
  let started = false;
  let disposed = false;
  let active: TurnHandle | null = null;
  let resumeId: string | null = null;
  let queueTail: Promise<void> = Promise.resolve();
  let startFlight: Promise<void> | null = null;
  let disposeFlight: Promise<void> | null = null;

  async function start(): Promise<void> {
    if (disposed) throw new Error("Session disposed");
    if (started) return;
    if (startFlight === null) startFlight = startSdk();
    try {
      await startFlight;
    } catch (error) {
      // 생성 실패는 재시도할 수 있다. 폐기가 이긴 레이스는 종점이라 비행을 남긴다.
      if (!disposed) startFlight = null;
      throw error;
    }
  }

  async function startSdk(): Promise<void> {
    const created = await options.createSdk();
    if (disposed) {
      await created.dispose().catch(() => undefined);
      throw new Error("Session disposed");
    }
    sdk = created;
    started = true;
    // 할당과 폐기 사이에 끼면 위에서 놓친 인스턴스를 여기서 거둔다.
    if (disposed) {
      sdk = null;
      started = false;
      await created.dispose().catch(() => undefined);
      throw new Error("Session disposed");
    }
  }

  function run(prompt: string): Promise<void> {
    if (disposed) return Promise.reject(new Error("Session disposed"));
    if (!started || sdk === null) return Promise.reject(new Error("Session not started"));
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return Promise.reject(new Error("Message required"));
    }
    const work = queueTail.then(() => runTurn(prompt));
    // 거절된 턴이 꼬리를 끊으면 뒤에 줄 선 턴이 영영 시작되지 않는다.
    queueTail = work.catch(() => undefined);
    return work;
  }

  /**
   * startTurn이 돌려준 런은 SDK 슬롯을 점유한다. next()가 거절되면 `done`이 아니라서
   * 슬롯이 안 풀리므로, 기대한 런이 지금 active일 때만 한 번 close한다.
   */
  function closeRun(expected: ClaudeGatewayRun): void {
    const current = active;
    if (current === null || current.run !== expected) return;
    current.close();
  }

  function cancel(): void {
    active?.stop();
  }

  function dispose(): Promise<void> {
    if (disposeFlight) return disposeFlight;
    disposed = true;
    active?.stop();
    disposeFlight = disposeResources();
    return disposeFlight;
  }

  async function disposeResources(): Promise<void> {
    // 폐기 직후 큐에 붙은 꼬리까지 기다린다. 한 번 await한 뒤에 꼬리가 바뀌면 그 새 꼬리도 기다린다.
    let observed = queueTail;
    for (;;) {
      await observed.catch(() => undefined);
      if (observed === queueTail) break;
      observed = queueTail;
    }
    await startFlight?.catch(() => undefined);
    const owned = sdk;
    sdk = null;
    started = false;
    await owned?.dispose().catch(() => undefined);
  }

  async function runTurn(prompt: string): Promise<void> {
    // 폐기 뒤에 줄 서 있던 턴은 새 SDK 턴을 열지 않는다.
    if (disposed) return;
    const owned = sdk;
    if (!owned) throw new Error("Session not started");

    let settled = false;
    let failed = false;
    let failure: unknown;
    let pendingResult: ClaudeResultEvent | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handle: TurnHandle | null = null;
    const decoder = createClaudeExecutionEventDecoder();
    const gate = createGate();

    const clearTimer = (): void => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    };

    /**
     * 이 턴의 대기 문을 연다. close는 이 턴의 런만, 한 번만. 이터레이터 EOF/return을 기다리지 않는다.
     * close 예외는 정리 실패일 뿐이라 타이머와 문을 남겨 두지 않는다.
     */
    const complete = (): void => {
      if (settled) return;
      settled = true;
      try {
        clearTimer();
        if (handle !== null) closeRun(handle.run);
      } finally {
        gate.open();
      }
    };

    const fail = (error: unknown): void => {
      if (!failed) {
        failed = true;
        failure = error;
      }
      complete();
    };

    const queueResult = (event: ClaudeResultEvent): void => {
      if (settled) return;
      pendingResult = event;
      complete();
    };

    try {
      const built = await options.buildTurn(prompt);
      if (disposed) return;
      assertLoopOwnedKeysAbsent(built);

      const resume =
        options.continuation.kind === "resume-child" && resumeId !== null
          ? { resume: resumeId }
          : {};
      let run: ClaudeGatewayRun;
      try {
        run = await owned.startTurn({ ...built, prompt, ...resume });
      } catch (error) {
        if (disposed) return;
        throw error;
      }
      const startedRun: ClaudeGatewayRun = run;
      let closed = false;
      handle = {
        run: startedRun,
        stop() {
          complete();
        },
        close() {
          if (closed) return;
          closed = true;
          if (active === handle) active = null;
          try {
            startedRun.close();
          } catch {
            // close는 정리. 정리 예외가 결과·관찰자·이터레이터·취소·폐기 종점을 바꾸지 않는다.
          }
        },
      };
      active = handle;
      if (disposed) {
        complete();
        return;
      }

      timer = armWatchdog(options.settlement, () => {
        // 타이머는 던지지 않는다. 관찰자 호출은 게이트가 열린 뒤 runTurn에서 한다.
        try {
          if (settled || disposed) return;
          queueResult({ kind: "result", isError: true, source: "watchdog" });
        } catch {
          // 워치독 콜백에서 예외가 새면 프로세스가 받는다.
        }
      });

      const consume = async (): Promise<void> => {
        let iterator: AsyncIterator<ClaudeGatewayMessage> | undefined;
        try {
          // 팩토리 동기 throw도 실패 턴 경로로 보낸다. try 밖에서 던지면 consume이 게이트를 못 연다.
          iterator = startedRun[Symbol.asyncIterator]();
          while (!settled) {
            const step = await iterator.next();
            if (step.done) {
              if (!settled && !disposed && options.settlement.kind === "result-required") {
                queueResult({ kind: "result", isError: true, source: "incomplete" });
              }
              break;
            }
            // 종점 뒤에 도착한 next는 세션 id도 이벤트도 쓰지 않는다.
            if (settled || disposed) break;
            const message = step.value;
            if (
              options.continuation.kind === "resume-child"
              && resumeId === null
              && typeof message.session_id === "string"
            ) {
              resumeId = message.session_id;
            }
            for (const event of decoder.decode(message)) {
              if (event.kind === "result") {
                // 디코더가 낸 result는 종점이다. return()/EOF를 기다리지 않고 이 턴만 닫는다.
                queueResult(event);
                break;
              }
              try {
                options.onEvent?.(event);
              } catch (error) {
                fail(error);
                break;
              }
            }
          }
        } catch (error) {
          // 종점 뒤에 close가 유발한 이터레이터 오류는 삼킨다.
          if (disposed || settled) return;
          fail(error);
        } finally {
          complete();
          // return()이 걸려도 run()은 이미 정산됐다. 늦은 정리가 새 턴을 닫지 않게 기다리지 않는다.
          const closing = iterator?.return?.();
          if (closing !== undefined) void closing.catch(() => undefined);
        }
      };

      const consumption = consume();
      consumption.catch(() => undefined);
      await gate.promise;

      if (disposed) return;
      // 종점 관찰자는 consume/타이머가 아니라 여기서 호출한다. 생성기 스택에 동기 throw가
      // 안 남고, 같은 오류로 run()을 거절한다.
      if (pendingResult !== undefined && !failed) {
        try {
          options.onEvent?.(pendingResult);
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    } catch (error) {
      if (!disposed && !failed) {
        failed = true;
        failure = error;
      }
    } finally {
      complete();
    }
    if (disposed) return;
    if (failed) return Promise.reject(failure);
  }

  return { start, run, cancel, dispose };
}

function assertLoopOwnedKeysAbsent(built: ClaudeExecutionTurn): void {
  if (!built || typeof built !== "object") return;
  const record = built as unknown as Record<string, unknown>;
  if (Object.hasOwn(record, "prompt") || Object.hasOwn(record, "resume")) {
    throw new TypeError("buildTurn must not set prompt or resume; those keys are loop-owned.");
  }
}

/**
 * 양수 유한 대기만 타이머로 쓴다. 0·음수·NaN·Infinity는 없는 것과 같다.
 * `unref`는 이 타이머만으로 프로세스가 살아 남지 않게 한다.
 */
function watchdogMsOf(settlement: ClaudeExecutionSettlement): number | undefined {
  if (settlement.kind !== "result-required") return undefined;
  const watchdogMs = settlement.watchdogMs;
  if (typeof watchdogMs !== "number" || !Number.isFinite(watchdogMs) || watchdogMs <= 0) {
    return undefined;
  }
  return watchdogMs;
}

/**
 * 턴 하나의 대기 문. Promise는 항상 fulfill한다. 관찰자/이터레이터 실패는 문이 열린 뒤
 * runTurn이 다시 던진다 — consume이나 타이머에서 reject하면 await가 붙기 전에
 * unhandled rejection이 된다.
 */
function createGate(): {
  readonly promise: Promise<void>;
  open(): void;
} {
  let opened = false;
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    open() {
      if (opened) return;
      opened = true;
      resolvePromise();
    },
  };
}

function armWatchdog(
  settlement: ClaudeExecutionSettlement,
  onTimeout: () => void,
): ReturnType<typeof setTimeout> | undefined {
  const watchdogMs = watchdogMsOf(settlement);
  if (watchdogMs === undefined) return undefined;
  const timer = setTimeout(onTimeout, watchdogMs);
  timer.unref?.();
  return timer;
}
