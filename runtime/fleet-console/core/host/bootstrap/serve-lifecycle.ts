import type { ConsoleLifecycleState, ConsoleStopReason } from "@fleet-console/protocol/lifecycle";

/** The lock instance a serve published: the pair that names this instance in its exit record. */
export interface ConsoleServeLockInstance {
  readonly pid: number;
  readonly startedAt: number;
}

export interface ConsoleServeLifecycleHooks {
  /**
   * binding → starting: this serve just published its lock and has not started any owned child yet. The serve starts its
   * reaper here, synchronously, so no child can be started before the reaper knows the Console.
   */
  readonly onLockAcquired?: (instance: ConsoleServeLockInstance) => void;
  /** Runs once, synchronously, on the first accepted stop request — before any cleanup. The serve arms its deadline here. */
  readonly onStopRequested?: (reason: ConsoleStopReason) => void;
  /** The single shutdown failed. Every stop request still settles. */
  readonly onShutdownFailed?: (error: unknown) => void;
  /**
   * The single shutdown ended. When it succeeded the lock is released and only leftover handles keep the process alive;
   * when it failed the instance stays stopping, possibly still holding the lock, until the process ends.
   */
  readonly onShutdownEnded?: () => void;
}

/**
 * The one owner of a Console instance's lifecycle state (docs/console-lifecycle-contract.md §2). The server reports
 * its startup transitions and registers its shutdown; every stop request — a signal, an accepted update, an API call —
 * goes through `requestStop`, which runs that shutdown exactly once and hands every caller the same promise. The lock
 * is released only at the end of that shutdown, so no caller sees the Console stopped while its cleanup still runs.
 */
export interface ConsoleServeLifecycle {
  state(): ConsoleLifecycleState;
  /** The lock instance this serve holds or held, or null before it took the lock. */
  lockInstance(): ConsoleServeLockInstance | null;
  /** Whether the startup in progress, if any, has settled. A stop requested during startup waits for it. */
  isStartupSettled(): boolean;
  /** Runs the startup. Stop requests wait for it to settle before the shutdown starts. A serve starts at most once. */
  startup<T>(run: () => Promise<T>): Promise<T>;
  /** binding → starting: this serve published its lock. */
  lockAcquired(instance: ConsoleServeLockInstance): void;
  /** starting → ready. A stop already requested keeps the instance stopping. */
  activated(): void;
  /** Registers the shutdown the first stop request runs. */
  setShutdown(shutdown: () => Promise<void>): void;
  /** Accepts a stop request. The first arms the hooks and runs the shutdown; every call returns that one shutdown. */
  requestStop(reason: ConsoleStopReason): Promise<void>;
  /** Whether a stop request was accepted. */
  stopRequested(): boolean;
  /** Settles once the shutdown has ended, successfully or not. Pending until a stop is requested. */
  whenStopped(): Promise<void>;
}

export function createConsoleServeLifecycle(hooks: ConsoleServeLifecycleHooks = {}): ConsoleServeLifecycle {
  let state: ConsoleLifecycleState = "binding";
  let lock: ConsoleServeLockInstance | null = null;
  let startupRun: Promise<unknown> | null = null;
  let startupSettled = true;
  let shutdown: (() => Promise<void>) | null = null;
  let stopping: Promise<void> | null = null;
  let markStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { markStopped = resolve; });

  return {
    state: () => state,
    lockInstance: () => lock,
    isStartupSettled: () => startupSettled,
    startup(run) {
      if (startupRun) return Promise.reject(new Error("Console serve can start only once"));
      startupSettled = false;
      const result = run();
      startupRun = result.then(() => {
        startupSettled = true;
      }, () => {
        startupSettled = true;
        // A failed start released whatever it took; without a stop request the instance only has to exit.
        if (!stopping) state = "releasing";
      });
      return result;
    },
    lockAcquired(instance) {
      lock = { pid: instance.pid, startedAt: instance.startedAt };
      if (state === "binding") state = "starting";
      hooks.onLockAcquired?.(lock);
    },
    activated() {
      if (state === "starting") state = "ready";
    },
    setShutdown(run) {
      shutdown = run;
    },
    requestStop(reason) {
      if (stopping) return stopping;
      if (state === "binding" || state === "starting" || state === "ready") state = "stopping";
      hooks.onStopRequested?.(reason);
      stopping = (async () => {
        let failed = false;
        try {
          if (startupRun) await startupRun;
          await shutdown?.();
        } catch (error) {
          failed = true;
          hooks.onShutdownFailed?.(error);
          throw error;
        } finally {
          // A shutdown that failed part-way may not have released the lock: the instance stays stopping (§2.2).
          if (!failed) state = "releasing";
          hooks.onShutdownEnded?.();
          markStopped();
        }
      })();
      return stopping;
    },
    stopRequested: () => stopping !== null,
    whenStopped: () => stopped,
  };
}
