import path from "node:path";

/**
 * The single Console process lifecycle contract (docs/console-lifecycle-contract.md): the states one Console instance
 * passes through, the time budgets every actor derives its waits from, and how an instance reports the way it ended.
 * Pure: no filesystem, process, or network access. Observation and IO live in `@fleet-console/lifecycle`.
 */

/**
 * The life of one Console `serve` process. Only the serve process itself owns these states; other actors infer them
 * from the lock, the pid, and the health endpoint.
 * - binding: listening, no lock; a serve that loses the lock exits here with CONSOLE_SERVE_EXIT_LOCK_HELD and writes nothing.
 * - starting: holds the lock; restores durable state and activates; only health answers (503 console_starting).
 * - ready: serving.
 * - stopping: one stop request was accepted; listeners close first, then the single cleanup runs while the lock is held.
 * - releasing: the cleanup ended and released the lock; the process stays only while leftover children are reaped.
 * - exited: the process is gone. It leaves an exit record unless it never held the lock or was killed from outside.
 */
export type ConsoleLifecycleState = "binding" | "starting" | "ready" | "stopping" | "releasing" | "exited";

/** Why a stop was requested. Every reason enters the same single shutdown and arms the same deadline. */
export type ConsoleStopReason = "signal" | "update" | "api";

/**
 * The lifecycle wire revision a Console reports as `lifecycleWire` in its authenticated health answer. A Console that
 * omits it is wire 0 (before this contract). Raised only for an incompatible change; an observer that meets a revision
 * newer than its own treats that instance as unverified and never signals it or removes its lock on that basis.
 */
export const CONSOLE_LIFECYCLE_WIRE = 1;

// ---------- Time budgets ----------
// Every wait and escalation in Console, CLI, Desktop, and the update worker is derived from these. Never restate a value.

/** B_int: from the first accepted stop request until the serve process exits, whatever is still running. */
export const CONSOLE_STOP_DEADLINE_MS = 10_000;
/** The longest a process table read (`ps`) may take before the reader gives up without signalling anyone. */
export const PROCESS_TABLE_TIMEOUT_MS = 1_000;
/** Covers a busy event loop delaying the stop handler at signal time and the deadline timer at expiry. */
export const ESCALATION_MARGIN_MS = 1_000;
/**
 * B_ext: how long an actor that sent SIGTERM waits before it may escalate to SIGKILL. Derived so that a Console within
 * its own budget (deadline + process table read + loop delay) always ends by its own deadline first.
 */
export const EXTERNAL_ESCALATION_MS = CONSOLE_STOP_DEADLINE_MS + PROCESS_TABLE_TIMEOUT_MS + ESCALATION_MARGIN_MS;
/** How long an actor that sent SIGKILL waits to see the pid exit. */
export const KILL_CONFIRM_MS = 3_000;
/** How often a waiting actor looks again at the pid and the lock. */
export const STOP_POLL_MS = 50;
/** The whole budget for one token-authenticated health probe, primary and legacy endpoints together. */
export const HEALTH_PROBE_TIMEOUT_MS = 5_000;
/** How long `fleet console start` waits for a Console it spawned, or one another starter is restoring, to become ready. */
export const CONSOLE_START_TIMEOUT_MS = 60_000;
/** How often `fleet console start` probes while it waits. */
export const CONSOLE_START_POLL_MS = 100;
/**
 * How long a starter waits after SIGTERM before SIGKILL for a child it spawned that has not taken the lock: such a child
 * has written nothing yet. A child that holds the lock gets the full stop ladder instead.
 */
export const PRELOCK_CHILD_GRACE_MS = 500;

// ---------- Identity ----------

/**
 * Process start times are read in whole seconds (`ps -o lstart`), and Linux can round the boot time by one more. A start
 * time proves identity only when it precedes the moment identity was proven by at least this much.
 */
export const PROCESS_START_MARGIN_MS = 2_000;
/**
 * A Console listens before it writes its lock, so the lock's author always started before the lock's `startedAt`. A lock
 * pid that started this much later than `startedAt` is a reused pid: the author is gone. The margin covers start-time
 * rounding and a wall clock stepped forward after the Console started.
 */
export const LOCK_AUTHOR_REPLACED_MARGIN_MS = 10_000;

/** What one token-authenticated health probe of a lock's endpoint showed. */
export type ConsoleHealthEvidence =
  | { readonly kind: "answered"; readonly pid: unknown; readonly lifecycleWire?: unknown }
  | { readonly kind: "starting"; readonly pid: unknown }
  | { readonly kind: "refused" }
  | { readonly kind: "unanswered" };

/** A Console instance as an outside actor observes it (docs/console-lifecycle-contract.md, "Observing an instance"). */
export type ConsoleObservedState = "exited" | "starting" | "ready" | "stopping" | "releasing" | "unverified";

/**
 * Whether the observer may treat the lock pid as that Console: `verified` is the only basis for a signal, `absent` means
 * nothing runs under the lock any more (only the lock file may go, through the reclaim protocol), and `unverified`
 * forbids both a signal and a removal.
 */
export type ConsoleIdentity = "verified" | "absent" | "unverified";

export interface ConsoleInstanceEvidence {
  readonly lockPid: number;
  /** False only on ESRCH. */
  readonly pidAlive: boolean;
  /** The lock passed every trust check and carries a token, so its endpoint may be asked. */
  readonly trusted: boolean;
  /** The lock pid started well after the lock was written (see LOCK_AUTHOR_REPLACED_MARGIN_MS). */
  readonly authorReplaced: boolean;
  /** The lock file still holds the same instance (pid and token) the observer read. */
  readonly lockHeldBySameInstance: boolean;
  /** The health probe, or null when the endpoint was not asked. */
  readonly health: ConsoleHealthEvidence | null;
}

/**
 * The one rule every actor uses to read an instance from outside. A refused endpoint behind a live pid that still holds
 * the same lock is a Console that closed its listener and is cleaning up — stopping, never absent — and it is no basis for
 * a signal either. A Console that reports a newer lifecycle wire than this contract is unverified.
 */
export function classifyConsoleInstance(input: ConsoleInstanceEvidence): { readonly state: ConsoleObservedState; readonly identity: ConsoleIdentity } {
  if (!input.pidAlive || input.authorReplaced) return { state: "exited", identity: "absent" };
  if (!input.lockHeldBySameInstance) return { state: "releasing", identity: "unverified" };
  if (!input.trusted || input.health === null) return { state: "unverified", identity: "unverified" };
  const health = input.health;
  if (health.kind === "refused") return { state: "stopping", identity: "unverified" };
  if (health.kind === "starting" && health.pid === input.lockPid) return { state: "starting", identity: "verified" };
  if (health.kind === "answered" && health.pid === input.lockPid) {
    const wire = health.lifecycleWire === undefined ? 0 : health.lifecycleWire;
    if (typeof wire === "number" && Number.isSafeInteger(wire) && wire >= 0 && wire <= CONSOLE_LIFECYCLE_WIRE) return { state: "ready", identity: "verified" };
  }
  return { state: "unverified", identity: "unverified" };
}

// ---------- Exit record ----------

/**
 * How one Console instance ended.
 * - clean: the shutdown finished and the process exited on its own.
 * - deadline: CONSOLE_STOP_DEADLINE_MS ran out; the Console killed its leftover children (`killed`) and exited 1.
 * - crash: an uncaught exception ended the instance.
 * - failed: the instance took the lock, then its start or its shutdown failed, and it ended with an error.
 * - external: the process vanished without writing a record (SIGKILL or a frozen loop killed from outside).
 * - forced-external: the actor that sent SIGKILL after EXTERNAL_ESCALATION_MS.
 */
export type ConsoleExitOutcome = "clean" | "deadline" | "crash" | "failed" | "external" | "forced-external";

export const CONSOLE_EXIT_RECORD_VERSION = 1;

/** The pair that names one Console instance: its pid and the `startedAt` of the lock it published. */
export interface ConsoleInstanceKey {
  readonly pid: number;
  readonly lockStartedAt: number;
}

/**
 * The record a Console instance leaves beside its lock when it ends, in a file of its own named by its instance key.
 * No instance ever overwrites another's record: a previous owner that ends after a successor took the slot writes its
 * own file. A reader opens only the file of the instance it observed. It never carries the lock token.
 */
export interface ConsoleExitRecord extends ConsoleInstanceKey {
  readonly v: typeof CONSOLE_EXIT_RECORD_VERSION;
  readonly outcome: ConsoleExitOutcome;
  /** Leftover child processes the instance killed on its way out (deadline). */
  readonly killed: number;
  readonly at: number;
}

/** How many of the newest exit records a lock owner keeps when it prunes the slot right after taking the lock. */
export const CONSOLE_EXIT_RECORD_RETAIN = 16;

const EXIT_RECORD_NAME = /^console\.exit\.([1-9]\d*)-(\d+)\.json$/;
const EXIT_OUTCOMES: readonly ConsoleExitOutcome[] = ["clean", "deadline", "crash", "failed", "external", "forced-external"];

/**
 * A record as a reader sees it. A newer Console may write an outcome this reader does not know; that reads as `unknown`,
 * which a reader must never report as a clean stop.
 */
export interface ConsoleExitRecordRead extends Omit<ConsoleExitRecord, "outcome"> {
  readonly outcome: ConsoleExitOutcome | "unknown";
}

/** The exit record of `instance`, in the lock's own runtime slot: every actor that knows the lock knows where to read it. */
export function consoleExitRecordPath(lockFile: string, instance: ConsoleInstanceKey): string {
  return path.join(path.dirname(lockFile), `console.exit.${instance.pid}-${instance.lockStartedAt}.json`);
}

/** The instance key an exit record file name carries, or null for any other name. */
export function parseConsoleExitRecordName(name: string): ConsoleInstanceKey | null {
  const match = EXIT_RECORD_NAME.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  const lockStartedAt = Number(match[2]);
  return Number.isSafeInteger(pid) && Number.isSafeInteger(lockStartedAt) ? { pid, lockStartedAt } : null;
}

/** The record in `text`, or null when it is not a record of this version. An outcome this contract does not name reads as `unknown`. */
export function parseConsoleExitRecord(text: string): ConsoleExitRecordRead | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== CONSOLE_EXIT_RECORD_VERSION) return null;
  const { pid, lockStartedAt, outcome, killed, at } = parsed;
  if (!isPositiveSafeInteger(pid) || !isFiniteNumber(lockStartedAt) || !isFiniteNumber(at)) return null;
  if (typeof outcome !== "string" || outcome.length === 0) return null;
  if (typeof killed !== "number" || !Number.isSafeInteger(killed) || killed < 0) return null;
  const known = EXIT_OUTCOMES.includes(outcome as ConsoleExitOutcome) ? outcome as ConsoleExitOutcome : "unknown";
  return { v: CONSOLE_EXIT_RECORD_VERSION, pid, lockStartedAt, outcome: known, killed, at };
}

// ---------- Lock slot ----------

/**
 * The exit status of a Console `serve` that did not take the Console lock: a running owner holds it, it has no readable
 * owner, it was refused, or its reclaim could not finish. The serve writes why, with any manual-recovery steps, to
 * stderr before exiting. A host that does not know this status sees an ordinary failed start.
 */
export const CONSOLE_SERVE_EXIT_LOCK_HELD = 73;

export type ConsoleLockContent =
  /** No participant may remove this lock: nothing in it names an owner pid whose exit could be observed. */
  | { readonly kind: "ownerless"; readonly reason: string }
  | { readonly kind: "owner"; readonly pid: number; readonly payload: Readonly<Record<string, unknown>> };

/**
 * Whether the text of a Console lock names an owner pid. Only a positive integer pid in a JSON object does; the other
 * fields decide whether the lock can be trusted, not whether it has an owner.
 */
export function classifyConsoleLockContent(text: string): ConsoleLockContent {
  if (text.length === 0) return { kind: "ownerless", reason: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "ownerless", reason: "invalid JSON" };
  }
  if (!isRecord(parsed)) return { kind: "ownerless", reason: "invalid payload" };
  const pid = parsed.pid;
  if (!isPositiveSafeInteger(pid)) return { kind: "ownerless", reason: "invalid pid" };
  return { kind: "owner", pid, payload: parsed };
}

/**
 * The shared manual-recovery check. Every message that suggests deleting a lock file or a reclaim marker by hand puts
 * this first: the command finishing a reclaim may be a `stop` or `start`, not only a `serve`.
 */
export function describeConsoleLockSlotQuiescenceCheck(lockFile: string): string {
  return [
    `Before deleting anything, make sure nothing else is using this Console data directory (${path.dirname(lockFile)}):`,
    "  - quit the Fleet desktop app and any update in progress, and do not run fleet console start/stop/restart or serve for it meanwhile;",
    "  - list remaining Fleet processes and check each one:  ps -A -o pid,lstart,command | grep -i fleet   (Windows: Get-CimInstance Win32_Process | Where-Object CommandLine -match 'fleet')",
    "    a \"fleet console stop\" or \"start\" can be the one finishing the cleanup, not only \"serve\".",
    "If a Fleet command, a Console, or the Fleet desktop app is still running, or you cannot tell what a listed entry is, leave the files in place.",
  ].join("\n");
}

export function describeOwnerlessConsoleLock(lockFile: string, reason: string): string {
  return [
    `Fleet Console lock ${lockFile} has no readable owner (${reason}), so it was left in place.`,
    describeConsoleLockSlotQuiescenceCheck(lockFile),
    `Then delete ${lockFile} and start again.`,
  ].join("\n");
}

export function describeRefusedConsoleLock(lockFile: string, reason: string): string {
  return `Refusing Fleet Console lock ${lockFile}: ${reason}. It was not removed; inspect it (ls -l ${lockFile}) before starting Fleet Console.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
