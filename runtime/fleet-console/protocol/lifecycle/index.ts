import path from "node:path";

import { EXTERNAL_ESCALATION_MS } from "./budgets.js";

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
export type ConsoleStopReason = "signal" | "update" | "api" | "request";

/**
 * The token-authenticated stop request route. A Console that serves it answers 202 and stops itself after the
 * response, through the same single shutdown a signal starts.
 */
export const CONSOLE_STOP_REQUEST_PATH = "/api/v1/lifecycle/stop";
/**
 * The revision of the token-authenticated stop request a Console advertises as `stopRequest` in its authenticated
 * health answer (both the ready 200 and the starting 503). Additive: a Console that omits it predates the route.
 */
export const CONSOLE_STOP_REQUEST_REVISION = 1;

/**
 * The lifecycle wire revision a Console reports as `lifecycleWire` in its authenticated health answer. A Console that
 * omits it is wire 0 (before this contract). Raised only for an incompatible change; an observer that meets a revision
 * newer than its own treats that instance as unverified and never signals it or removes its lock on that basis.
 */
export const CONSOLE_LIFECYCLE_WIRE = 1;

/**
 * The revision of the update worker's lifecycle runtime (the bundle an accepted update copies beside its worker). The
 * worker loads a copy only when its bytes and this revision match what the Console that wrote the worker expected.
 */
export const CONSOLE_LIFECYCLE_CONTRACT_VERSION = 2;

// ---------- Time budgets ----------
// Every wait and escalation in Console, CLI, Desktop, and the update worker is derived from these (./budgets.ts, kept
// import-free so a browser can read them too). Never restate a value.
export * from "./budgets.js";
export * from "./update.js";

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

/**
 * A Console instance as an outside actor observes it (docs/console-lifecycle-contract.md, "Observing an instance").
 * `exited` means the lock pid is gone (ESRCH). `replaced` means the lock pid is alive but started after the lock was
 * written, so another program reused the pid of a Console that ended: no actor signals it, removes the lock, or starts a
 * new serve beside it, because only ESRCH grants those (a start-time comparison may block an action, never allow one).
 */
export type ConsoleObservedState = "exited" | "replaced" | "starting" | "ready" | "stopping" | "releasing" | "unverified";

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
  if (!input.pidAlive) return { state: "exited", identity: "absent" };
  if (input.authorReplaced) return { state: "replaced", identity: "unverified" };
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

/** How long the local Console list waits for one unauthenticated status answer, or one TCP connect to a WSL Console. */
export const PUBLIC_STATUS_TIMEOUT_MS = 700;

/** What one unauthenticated `/api/v1/status` request showed. It carries no identity: the list reads no lock token. */
export type ConsolePublicStatus = "answered" | "starting" | "refused" | "unanswered";

/**
 * A Console as the local Console list observes it without credentials (docs/console-lifecycle-contract.md, "Observing an
 * instance"): the same liveness and author-replaced rules as every actor, and a public status in place of authenticated
 * health. Which states the list shows is the list's policy.
 */
export type ConsolePublicState = "ready" | "starting" | "stopping" | "unresponsive" | "exited" | "unreachable" | "replaced";

export interface ConsolePublicEvidence {
  /** False only on ESRCH; null when the pid cannot be checked from here (a Console inside WSL). */
  readonly pidAlive: boolean | null;
  /** For a Console whose pid cannot be checked: whether its port accepted a TCP connection. Null otherwise. */
  readonly portOpen: boolean | null;
  /** The lock pid started well after the lock was written (see LOCK_AUTHOR_REPLACED_MARGIN_MS). */
  readonly authorReplaced: boolean;
  readonly status: ConsolePublicStatus;
}

export function classifyConsolePublic(input: ConsolePublicEvidence): ConsolePublicState {
  if (input.pidAlive === false) return "exited";
  // A refused port is not ESRCH: it says nothing reachable listens there, never that the pid is gone.
  if (input.portOpen === false) return "unreachable";
  if (input.status === "starting") return "starting";
  if (input.status === "refused") return input.authorReplaced ? "replaced" : "stopping";
  return input.status === "answered" ? "ready" : "unresponsive";
}

// ---------- Token-authenticated stop request route ----------

/**
 * What one token-authenticated stop request attempt showed.
 * - accepted: the Console answered 202 with `accepted: true` and its own pid.
 * - rejected: the Console definitely did not take the request (401/403/404/405, or a 202 body that did not confirm).
 * - uncertain: the attempt never got an answer (timeout, reset, refused) — the request may or may not have landed,
 *   so `observed` carries a fresh observation of the same lock instance to decide on.
 */
export type ConsoleStopAttemptResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected" }
  | { readonly kind: "uncertain"; readonly observed: ConsoleObservedState };

/**
 * Where a stop request goes: `signal` sends SIGTERM now (on Windows that is TerminateProcess), `delivered` sends
 * nothing — the request already reached the Console another way — and the stop ladder still escalates past B_ext only
 * with identity proven again.
 */
export type ConsoleStopClientRoute = "signal" | "delivered";

/**
 * The one rule every actor uses to choose its stop path (docs/console-lifecycle-contract.md, "Stop ladder"): from the
 * Console's advertisement, the actor's platform, and the request attempt's result. POSIX always signals; so does an
 * unadvertised Console and a definite rejection. An inconclusive attempt signals only a Console that still serves under
 * the same lock (the request never landed); a Console that is gone, going, or unprovable is waited on without a
 * signal. Fail closed: anything unrecognized waits.
 */
export function decideConsoleStopRoute(input: {
  readonly platform: string;
  readonly advertised: boolean;
  readonly result: ConsoleStopAttemptResult;
}): ConsoleStopClientRoute {
  if (input.platform !== "win32") return "signal";
  if (!input.advertised) return "signal";
  switch (input.result.kind) {
    case "accepted":
      return "delivered";
    case "rejected":
      return "signal";
    case "uncertain":
      switch (input.result.observed) {
        case "ready":
          return "signal";
        case "stopping":
        case "releasing":
        case "exited":
        case "unverified":
        case "replaced":
        case "starting":
          return "delivered";
        default: {
          const exhaustive: never = input.result.observed;
          void exhaustive;
          return "delivered";
        }
      }
    default: {
      const exhaustive: never = input.result;
      void exhaustive;
      return "delivered";
    }
  }
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
  /**
   * Why the shutdown ran. Optional and additive: a previous reader ignores it, and the wire revision stays. It tells
   * a token-authenticated stop request apart from an OS signal in the record.
   */
  readonly stopReason?: ConsoleStopReason;
}

/** How many of the newest exit records a lock owner keeps when it prunes the slot right after taking the lock. */
export const CONSOLE_EXIT_RECORD_RETAIN = 16;

const EXIT_RECORD_NAME = /^console\.exit\.([1-9]\d*)-(\d+)\.json$/;
const EXIT_OUTCOMES: readonly ConsoleExitOutcome[] = ["clean", "deadline", "crash", "failed", "external", "forced-external"];
/** Every stop reason, with exhaustiveness checked against the union: adding a reason without an entry fails to compile. */
const STOP_REASON_SET = { signal: true, update: true, api: true, request: true } satisfies Record<ConsoleStopReason, true>;
const STOP_REASONS: readonly ConsoleStopReason[] = Object.keys(STOP_REASON_SET) as ConsoleStopReason[];

/** A recorded stop reason as a reader sees it: the reason when it names one this contract knows, else absent. */
export function parseConsoleStopReason(value: unknown): ConsoleStopReason | undefined {
  return STOP_REASONS.includes(value as ConsoleStopReason) ? (value as ConsoleStopReason) : undefined;
}

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
  const stopReason = parseConsoleStopReason(parsed.stopReason);
  return { v: CONSOLE_EXIT_RECORD_VERSION, pid, lockStartedAt, outcome: known, killed, at, ...(stopReason === undefined ? {} : { stopReason }) };
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

/** The lock pid is alive but started after the lock was written: another program reused an ended Console's pid. */
export function describeReplacedLockAuthor(lockFile: string, pid: number): string {
  return [
    `Fleet Console lock ${lockFile} names pid ${pid}, which is running but started after the lock was written: it is another program that reused the pid of a Console that has ended. The lock was left in place, and no Console starts beside it while that pid runs.`,
    describeConsoleLockSlotQuiescenceCheck(lockFile),
    `If pid ${pid} is not a Fleet process, delete ${lockFile} and start again; otherwise wait until it exits.`,
  ].join("\n");
}

export function describeRefusedConsoleLock(lockFile: string, reason: string): string {
  return `Refusing Fleet Console lock ${lockFile}: ${reason}. It was not removed; inspect it (ls -l ${lockFile}) before starting Fleet Console.`;
}

/**
 * How a live process holding the Console lock was observed when no actor could prove it is that Console, so it was
 * neither signalled nor had its lock removed: `untrusted` (the lock failed the trust checks), `unverified` (no
 * authenticated health answer named the pid), `starting` (it was still starting), `stopping` (it closed its listener and
 * kept the lock past the stop budget).
 */
export type UnprovenConsoleLockOwnerState = "untrusted" | "unverified" | "starting" | "stopping";

/** The caller's own next step, so the CLI and Desktop share one explanation with their own commands. */
export interface ConsoleLockOwnerRecovery {
  /** What starts a Console once the lock owner is gone, as a clause: "run fleet console start". */
  readonly restart: string;
  /** For a Console still starting: the full sentence that tries the interrupted action again once it is ready. */
  readonly retryWhenStarted: string;
}

/**
 * Why a live lock pid was left alone, and how a person frees the slot by hand. It takes no lock payload: a lock token
 * must never reach text a person reads or copies.
 */
export function describeUnprovenConsoleLockOwner(lockFile: string, pid: number, observed: UnprovenConsoleLockOwnerState, recovery: ConsoleLockOwnerRecovery): string {
  const headline = {
    untrusted: `Fleet Console lock ${lockFile} names running pid ${pid}, but the lock cannot be trusted, so that process was not signalled.`,
    unverified: `Fleet Console lock pid ${pid} is alive but did not prove it owns ${lockFile}, so it was not signalled.`,
    starting: `Fleet Console pid ${pid} holds ${lockFile} and is still starting, so it was not signalled. ${recovery.retryWhenStarted}`,
    stopping: `Fleet Console lock pid ${pid} no longer answers at the lock's address but still held ${lockFile} ${Math.round(EXTERNAL_ESCALATION_MS / 1_000)}s later (a Console still shutting down, or another process), so it was not signalled.`,
  }[observed];
  return [
    headline,
    `${observed === "starting" ? "If it never finishes starting and is a stuck Fleet Console" : "If that process is a stuck Fleet Console"}, stop it (kill -TERM ${pid}; Windows: Stop-Process -Id ${pid}), then ${recovery.restart}. A suspended process (state T in ps) ignores TERM until resumed: kill -CONT ${pid} lets it finish shutting down, or kill -KILL ${pid} ends it.`,
    `If it is not a Fleet Console, follow the check below and then delete ${lockFile}.`,
    describeConsoleLockSlotQuiescenceCheck(lockFile),
  ].join("\n");
}

/** A proven Console that outlived SIGKILL. Its lock stays: only the pid's exit lets the next Console reclaim it. */
export function describeConsoleOwnerOutlivedKill(lockFile: string, pid: number, restart: string): string {
  return [
    `Fleet Console pid ${pid} did not exit after SIGKILL; ${lockFile} was left in place.`,
    `A process that survives SIGKILL is usually waiting on the operating system (for example a disk or network drive that stopped responding) and ends when that wait does. Check it with: ps -o pid,stat,command -p ${pid}   (Windows: Get-Process -Id ${pid})`,
    `Once pid ${pid} is gone, ${restart}; the next Console reclaims the lock itself. If it never exits, restart the computer. Do not delete ${lockFile} while pid ${pid} is running.`,
  ].join("\n");
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
