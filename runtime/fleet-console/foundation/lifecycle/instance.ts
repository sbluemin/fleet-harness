import { performance } from "node:perf_hooks";

import {
  EXTERNAL_ESCALATION_MS,
  HEALTH_PROBE_TIMEOUT_MS,
  KILL_CONFIRM_MS,
  STOP_POLL_MS,
  classifyConsoleInstance,
  type ConsoleIdentity,
  type ConsoleObservedState,
} from "@fleet-console/protocol/lifecycle";

import { toConsoleHealthEvidence, type ConsoleHealthTarget, type ConsoleProbeOptions, type ConsoleProbeResult } from "./health.js";
import { consoleLockInstanceState } from "./lock-file.js";
import { isLockAuthorReplaced, isPidAlive, readProcessStartTime } from "./process.js";

/** The lock instance an observer read: the pid it names, when it was written, and its token. */
export interface ConsoleObservedLock extends ConsoleHealthTarget {
  readonly startedAt: unknown;
}

export interface ConsoleInstanceObservation<L extends ConsoleObservedLock> {
  readonly state: ConsoleObservedState;
  readonly identity: ConsoleIdentity;
  /** The health probe, when the endpoint was asked. */
  readonly probe: ConsoleProbeResult<L> | null;
}

export interface ObserveConsoleInstanceInput<L extends ConsoleObservedLock> {
  readonly lock: L;
  /** The lock passed the observer's trust checks (owner, host, endpoint). A tokenless lock is never trusted. */
  readonly trusted: boolean;
  /** Whether the lock file still holds this same instance (pid and token). A lock that cannot be read counts as held. */
  readonly isHeld: () => boolean;
  readonly probe: (lock: L, options: ConsoleProbeOptions) => Promise<ConsoleProbeResult<L>>;
  /** The observer's probe budget: HEALTH_PROBE_TIMEOUT_MS, or INTERACTIVE_PROBE_TIMEOUT_MS on a path a person waits on. */
  readonly probeTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** Reads one lock instance from outside and classifies it with the contract's single rule. Sends no signal. */
export async function observeConsoleInstance<L extends ConsoleObservedLock>(input: ObserveConsoleInstanceInput<L>): Promise<ConsoleInstanceObservation<L>> {
  const { lock } = input;
  const trusted = input.trusted && typeof lock.token === "string" && lock.token.length > 0;
  let probe: ConsoleProbeResult<L> | null = null;
  let authorReplaced = false;
  if (isPidAlive(lock.pid) && trusted) {
    probe = await input.probe(lock, { timeoutMs: input.probeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS });
    if (probe.refused) authorReplaced = await isLockAuthorReplaced(lock, input.env);
  }
  const health = probe ? toConsoleHealthEvidence(probe) : null;
  const classified = classifyConsoleInstance({
    lockPid: lock.pid,
    pidAlive: isPidAlive(lock.pid),
    trusted,
    authorReplaced,
    lockHeldBySameInstance: input.isHeld(),
    health,
  });
  return { ...classified, probe };
}

export interface ReproveConsoleInstanceInput<L extends ConsoleObservedLock> {
  readonly lockFile: string;
  /** The lock instance whose identity was proven before SIGTERM. */
  readonly lock: L;
  /** Its process start time captured with that proof (`captureProvenProcessStart`), or null when it could not be. */
  readonly provenStart: number | null;
  /** True while the pid is the requester's own unreaped child: its handle alone proves identity (E1). */
  readonly isOwnChild?: () => boolean;
  /** A fresh observation of the same lock instance (the actor's own `observeConsoleInstance`). */
  readonly observe: (lock: L) => Promise<ConsoleInstanceObservation<L>>;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Right before SIGKILL: is the pid still the instance proven before SIGTERM (docs/console-lifecycle-contract.md, "Stop
 * ladder" step 6)? An unreaped own child is (E1). Otherwise the same lock instance must still be held — a lock that
 * cannot be read proves nothing — and either the start time captured with the proof is unchanged (E4: a reused pid starts
 * after the proof) or a fresh authenticated health answer names the pid again (E3).
 */
export async function reproveConsoleInstance<L extends ConsoleObservedLock>(input: ReproveConsoleInstanceInput<L>): Promise<boolean> {
  if (input.isOwnChild?.() === true) return true;
  const { lock } = input;
  const instance = { pid: lock.pid, ...(typeof lock.token === "string" ? { token: lock.token } : {}) };
  const held = () => consoleLockInstanceState(input.lockFile, instance) === "held";
  if (input.provenStart !== null && await readProcessStartTime(lock.pid, input.env) === input.provenStart && held()) return true;
  if (!held()) return false;
  return (await input.observe(lock)).identity === "verified";
}

/**
 * How a stop ladder ended.
 * - exited: the pid is gone (whether or not it released the lock first).
 * - released-alive: the lock was released but the process outlived EXTERNAL_ESCALATION_MS; never killed for that.
 * - held: still holding the lock after EXTERNAL_ESCALATION_MS, and this actor did not request the stop (`request: "none"`), so it may not escalate.
 * - unproven: still holding the lock, but identity could not be proven again; nothing was signalled.
 * - forced: SIGKILLed after EXTERNAL_ESCALATION_MS and seen gone within KILL_CONFIRM_MS.
 * - kill-failed: SIGKILLed but still alive after KILL_CONFIRM_MS.
 */
export type ConsoleStopLadderResult = "exited" | "released-alive" | "held" | "unproven" | "forced" | "kill-failed";

/**
 * How this actor's stop request reaches the Console (docs/console-lifecycle-contract.md, "Stop ladder").
 * - signal: this actor requests the stop by SIGTERM now, and may escalate after EXTERNAL_ESCALATION_MS.
 * - delivered: this actor's request already reached the Console another way (an accepted update stops the Console by
 *   itself), so no SIGTERM is sent — on Windows SIGTERM is TerminateProcess — but it may still escalate.
 * - none: someone else stops it; this actor only waits and never signals.
 */
export type ConsoleStopRequest = "signal" | "delivered" | "none";

export interface ConsoleStopLadderInput {
  readonly request: ConsoleStopRequest;
  readonly isAlive: () => boolean;
  /** Whether the same lock instance is gone or replaced. A lock that cannot be read counts as held. */
  readonly isReleased: () => boolean;
  /** Proves again, right before SIGKILL, that the pid is still the instance whose identity was proven before SIGTERM. */
  readonly reprove: () => Promise<boolean>;
  readonly signal: (signal: NodeJS.Signals) => void;
  /** Called once if the wait lasts longer than a second, so a person can be told why nothing happens yet. */
  readonly onWaiting?: () => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const WAITING_NOTICE_MS = 1_000;

/**
 * The stop ladder (docs/console-lifecycle-contract.md, "Stop ladder"): one SIGTERM, a wait of EXTERNAL_ESCALATION_MS on a
 * monotonic deadline for the pid to exit or the lock to be released, and — only for an actor whose request was sent or
 * delivered, only while the same
 * lock is still held, and only after identity is proven again — SIGKILL. A released lock is never escalated: the
 * Console's own deadline bounds what remains.
 */
export async function runStopLadder(input: ConsoleStopLadderInput): Promise<ConsoleStopLadderResult> {
  const now = input.now ?? (() => performance.now());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const requestedAt = now();
  const deadline = requestedAt + EXTERNAL_ESCALATION_MS;
  let noticed = false;
  if (input.request === "signal") input.signal("SIGTERM");
  const wait = async (until: () => boolean): Promise<boolean> => {
    for (;;) {
      if (until()) return true;
      if (now() >= deadline) return false;
      if (!noticed && now() - requestedAt >= WAITING_NOTICE_MS) {
        noticed = true;
        input.onWaiting?.();
      }
      await sleep(Math.min(STOP_POLL_MS, Math.max(1, deadline - now())));
    }
  };
  await wait(() => !input.isAlive() || input.isReleased());
  if (!input.isAlive()) return "exited";
  if (input.isReleased()) return await wait(() => !input.isAlive()) ? "exited" : "released-alive";
  if (input.request === "none") return "held";
  if (!await input.reprove()) return input.isAlive() ? "unproven" : "exited";
  // Proving can take a health round trip: the Console may have finished meanwhile.
  if (!input.isAlive()) return "exited";
  if (input.isReleased()) return "released-alive";
  input.signal("SIGKILL");
  const killedAt = now();
  for (;;) {
    if (!input.isAlive()) return "forced";
    if (now() - killedAt >= KILL_CONFIRM_MS) return "kill-failed";
    await sleep(STOP_POLL_MS);
  }
}
