/**
 * The update worker's lifecycle runtime. The build emits it as a self-contained bundle (dist/lifecycle-worker-runtime.mjs);
 * an accepted update copies that bundle beside its worker while the installed package is still intact, and the worker
 * imports the copy once its bytes match. So the worker reads, judges, and stops the Console it replaces with the one
 * lifecycle contract (docs/console-lifecycle-contract.md, "Update worker") instead of a copy of its own.
 */
import {
  captureProvenProcessStart,
  consoleLockInstanceState,
  createConsoleHealthClient,
  isPidAlive,
  observeConsoleInstance,
  observeConsoleLockFile,
  readConsoleEnding,
  reproveConsoleInstance,
  runStopLadder,
  writeConsoleExitRecord,
  type ConsoleInstanceObservation,
} from "@fleet-console/lifecycle";
import {
  CONSOLE_EXIT_RECORD_VERSION,
  CONSOLE_LIFECYCLE_CONTRACT_VERSION,
  CONSOLE_START_POLL_MS,
  CONSOLE_START_TIMEOUT_MS,
  HEALTH_PROBE_TIMEOUT_MS,
  UPDATE_WORKER_COMMIT_MS,
  STOP_POLL_MS,
  describeReplacedLockAuthor,
} from "@fleet-console/protocol/lifecycle";

export { CONSOLE_LIFECYCLE_CONTRACT_VERSION, CONSOLE_START_POLL_MS, CONSOLE_START_TIMEOUT_MS };

/** The Console instance the update replaces: the lock it published, as that Console handed it to the worker. */
export interface UpdatedConsole {
  readonly lockFile: string;
  readonly pid: number;
  readonly endpoint: string;
  readonly token: string;
  readonly startedAt: number;
}

/** The old Console's lock instance, as the worker observes and reproves it. */
type WorkerLock = Pick<UpdatedConsole, "pid" | "endpoint" | "token" | "startedAt">;

export interface StopUpdatedConsoleInput {
  readonly console: UpdatedConsole;
  /** POSIX parent link (E2): true while that Console is still this worker's parent. Read before anything waited. */
  readonly isParent: () => boolean;
  readonly log: (line: string) => void;
}

/**
 * How stopping the updated Console ended.
 * - stopped: its process is gone (or its released lock now names another program); the install may go on.
 * - still-running: it released its lock but its process outlived EXTERNAL_ESCALATION_MS, still reaping children; files
 *   it has loaded must not be replaced under it, so the install does not start. Nothing is signalled for that.
 * - replaced: its lock is still held by a live pid that started after the lock was written, another program that reused
 *   the pid; no Console can start there until that pid exits, so the install does not start. Nothing is signalled.
 * - unverified: still holding its lock after the stop budget, and its identity could not be proven again; nothing was
 *   signalled.
 * - kill-failed: it outlived SIGKILL.
 * `ending` is how it ended once it is gone (its exit record, or the contract's reading of none), else null; `detail`
 * explains a replaced lock with the contract's shared text.
 */
export interface StopUpdatedConsoleResult {
  readonly result: "stopped" | "still-running" | "replaced" | "unverified" | "kill-failed";
  readonly ending: string | null;
  readonly detail?: string;
}

/**
 * Stops the Console the update replaces. The Console stops itself once it accepted the update, so the request is already
 * delivered: no SIGTERM is sent (on Windows that would be TerminateProcess), and only a Console still holding its lock
 * after EXTERNAL_ESCALATION_MS whose identity is proven again (parent link, unchanged start time, or a fresh health answer)
 * is SIGKILLed.
 */
export async function stopUpdatedConsole(input: StopUpdatedConsoleInput): Promise<StopUpdatedConsoleResult> {
  const { console: target, isParent, log } = input;
  const lock: WorkerLock = { pid: target.pid, endpoint: target.endpoint, token: target.token, startedAt: target.startedAt };
  const provenAt = Date.now();
  const observed = await observe(target.lockFile, lock);
  log(`old console ${target.pid}: ${observed.state} (identity ${observed.identity}${isParent() ? ", parent link" : ""})`);
  const instance = { pid: target.pid, token: target.token };
  if (observed.state === "exited") return { result: "stopped", ending: endingOf(target, observed, false) };
  if (observed.state === "replaced") {
    // The pid now names another program. With the old lock released the old Console is gone and the slot is free; with
    // the old lock still in place no Console can start until that program exits, so the update stops here.
    if (consoleLockInstanceState(target.lockFile, instance) === "released") return { result: "stopped", ending: null };
    return { result: "replaced", ending: null, detail: describeReplacedLockAuthor(target.lockFile, target.pid) };
  }
  // Every other state, a Console that already released its lock included, goes through the ladder: the install waits for
  // the old process to end within EXTERNAL_ESCALATION_MS, and only a proven Console still holding its lock is SIGKILLed.
  const provenStart = observed.identity === "verified" && !isParent() ? await captureProvenProcessStart(target.pid, provenAt) : null;
  const ended = await runStopLadder({
    request: "delivered",
    isAlive: () => isPidAlive(target.pid),
    isReleased: () => consoleLockInstanceState(target.lockFile, instance) === "released",
    reprove: () => reproveConsoleInstance({ lockFile: target.lockFile, lock, provenStart, isOwnChild: isParent, observe: (proven) => observe(target.lockFile, proven) }),
    signal: (signal) => signalPid(target.pid, signal),
  });
  log(`old console ${target.pid}: stop ladder ${ended}`);
  if (ended === "unproven" || ended === "held") return { result: "unverified", ending: null };
  if (ended === "released-alive") return { result: "still-running", ending: null };
  if (ended === "kill-failed") return { result: "kill-failed", ending: null };
  if (ended === "forced") {
    let recorded = true;
    try {
      recorded = writeConsoleExitRecord(target.lockFile, { v: CONSOLE_EXIT_RECORD_VERSION, pid: target.pid, lockStartedAt: target.startedAt, outcome: "forced-external", killed: 0, at: Date.now() });
    } catch {
      // The record only informs later readers; this stop still knows it forced the Console.
    }
    return { result: "stopped", ending: recorded ? "forced-external" : endingOf(target, observed, false) };
  }
  return { result: "stopped", ending: endingOf(target, observed, false) };
}

/** commit 전달만으로 정지를 추정하지 않는다. 살아서 응답하는 host에는 ladder를 시작하지 않는다. */
export async function waitForUpdatedConsoleStop(target: UpdatedConsole): Promise<boolean> {
  const deadline = performance.now() + UPDATE_WORKER_COMMIT_MS;
  while (performance.now() < deadline) {
    const observation = await observeConsoleInstance({
      lock: target,
      trusted: true,
      isHeld: () => consoleLockInstanceState(target.lockFile, target) !== "released",
      probe: (lock) => createConsoleHealthClient().probe(lock, { timeoutMs: Math.max(1, Math.min(HEALTH_PROBE_TIMEOUT_MS, deadline - performance.now())) }),
    });
    if (["stopping", "releasing", "exited", "replaced"].includes(observation.state)) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(STOP_POLL_MS, Math.max(0, deadline - performance.now()))));
  }
  return false;
}

/** What the slot holds right now, for a worker that may start a Console there. */
export type SlotForStart =
  | { readonly kind: "free" }
  | { readonly kind: "exited"; readonly pid: number }
  | { readonly kind: "held"; readonly pid: number; readonly detail: string }
  | { readonly kind: "blocked"; readonly detail: string };

/**
 * Whether a new serve may start in the slot. Only ESRCH frees a slot (docs/console-lifecycle-contract.md, "Evidence
 * direction"): a lock whose pid still runs — a Console, or another program that reused an ended Console's pid — keeps the
 * slot, and a lock that cannot be read keeps it too.
 */
export function judgeSlotForStart(lockFile: string, oldConsole: { readonly pid: number; readonly token: string }): SlotForStart {
  const observed = observeConsoleLockFile(lockFile);
  if (observed.kind === "absent") return { kind: "free" };
  if (observed.kind !== "owner") return { kind: "blocked", detail: observed.reason };
  const { pid, payload } = observed.instance;
  if (!observed.alive) return { kind: "exited", pid };
  const sameInstance = pid === oldConsole.pid && payload.token === oldConsole.token;
  const detail = sameInstance ? `pid ${pid} is alive and still holds the old console's lock` : `pid ${pid} is alive and holds the lock`;
  return { kind: "held", pid, detail };
}

export interface SlotConsoleProbe {
  readonly state: "healthy" | "starting" | "unhealthy";
  readonly endpoint: string | null;
}

/**
 * The Console now in the slot, by its authenticated health. Starting is a reason to wait, never health. With a target
 * version, only a Console other than `oldPid` that answers with that version counts as healthy.
 */
export async function probeSlotConsole(lockFile: string, options: { readonly deadline: number; readonly targetVersion?: string; readonly oldPid?: number }): Promise<SlotConsoleProbe> {
  const observed = observeConsoleLockFile(lockFile);
  if (observed.kind !== "owner" || observed.untrusted !== null || !observed.alive) return { state: "unhealthy", endpoint: null };
  const lock = observed.instance.payload;
  const remaining = Math.max(1, Math.min(HEALTH_PROBE_TIMEOUT_MS, options.deadline - Date.now()));
  const probe = await createConsoleHealthClient().probe(lock, { timeoutMs: remaining });
  if (probe.starting) return { state: "starting", endpoint: lock.endpoint };
  if (!probe.healthy || probe.health?.pid !== lock.pid) return { state: "unhealthy", endpoint: lock.endpoint };
  if (options.targetVersion === undefined) return { state: "healthy", endpoint: lock.endpoint };
  if (lock.pid === options.oldPid || probe.health?.version !== options.targetVersion) return { state: "unhealthy", endpoint: lock.endpoint };
  return { state: "healthy", endpoint: lock.endpoint };
}

function observe(lockFile: string, lock: WorkerLock): Promise<ConsoleInstanceObservation<WorkerLock>> {
  return observeConsoleInstance({
    lock,
    trusted: true,
    isHeld: () => consoleLockInstanceState(lockFile, { pid: lock.pid, token: lock.token }) !== "released",
    probe: (target, options) => createConsoleHealthClient().probe(target, options),
  });
}

function endingOf(target: UpdatedConsole, observed: ConsoleInstanceObservation<WorkerLock>, terminatedByReader: boolean): string | null {
  if (isPidAlive(target.pid)) return null;
  return readConsoleEnding(target.lockFile, { pid: target.pid, lockStartedAt: target.startedAt }, { lifecycleWire: observed.probe?.health?.lifecycleWire, terminatedByReader }).outcome;
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ESRCH") throw error;
  }
}
