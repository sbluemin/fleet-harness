import { CONSOLE_START_TIMEOUT_MS, CONSOLE_STOP_DEADLINE_MS, EXTERNAL_ESCALATION_MS, HEALTH_PROBE_TIMEOUT_MS, KILL_CONFIRM_MS } from "./budgets.js";
import type { ConsoleExitOutcome } from "./index.js";

/**
 * What an accepted in-place update reports to the Console that comes back and to the screen that waited for it
 * (docs/console-lifecycle-contract.md, "Update worker"). Import-free apart from the budgets, so the browser reads the same
 * reasons, budgets, and shared text the worker and the Console use.
 */

/**
 * The longest the update worker takes to conclude the old Console's stop: one health observation, B_ext, one re-proof,
 * and the kill confirmation. By then it is installing, or it has recorded why it did not.
 */
export const UPDATE_OLD_CONSOLE_STOP_CONCLUSION_MS = HEALTH_PROBE_TIMEOUT_MS + EXTERNAL_ESCALATION_MS + HEALTH_PROBE_TIMEOUT_MS + KILL_CONFIRM_MS;

/**
 * Measured from the moment the old Console stopped answering (a stopping Console closes its listeners first): an update
 * that failed before its install has brought a Console back by then if it can bring one back at all. The install has no
 * budget, so a Console still silent after this is either still installing or gone with nothing to come back to; only
 * the progress record of a Console that answers again says which.
 */
export const UPDATE_FAILED_CONSOLE_RETURN_MS = UPDATE_OLD_CONSOLE_STOP_CONCLUSION_MS + CONSOLE_START_TIMEOUT_MS;

/** 실제 worker의 준비와 응답 이후 인계를 각각 제한한다. 다운로드 시간은 포함하지 않는다. */
export const UPDATE_WORKER_PREFLIGHT_MS = 15_000;
export const UPDATE_WORKER_COMMIT_MS = 5_000;
/** 취소된 worker를 거둔 뒤에만 다음 실행이 progress를 쓸 수 있다. */
export const UPDATE_WORKER_ABORT_MS = KILL_CONFIRM_MS;
export const UPDATE_WORKER_HANDSHAKE_VERSION = 1;

export type ConsoleUpdateFailureStage = "preflight" | "handoff";

/** commit 전 거절의 공용 DTO. 설명은 host가 계약의 describe*로 만든다. */
export interface ConsoleUpdateApplyFailureProgress {
  readonly state: "failed";
  readonly phase: "failed";
  readonly startedAt: string;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly reason: ConsoleUpdateFailureReason | "unknown";
  readonly failureStage: ConsoleUpdateFailureStage;
  readonly description: string;
}

export interface ConsoleUpdateApplyFailureResponse {
  readonly error: "update_worker_unavailable";
  readonly progress: ConsoleUpdateApplyFailureProgress;
}

/** 익명 parent-child IPC 채널에서만 읽는다. runId 자체는 권한 증명이 아니다. */
export interface ConsoleUpdateWorkerMessage {
  readonly v: number;
  readonly runId: string;
  readonly kind: "prepare" | "ready" | "commit" | "committed" | "abort" | "failed";
  readonly reason?: ConsoleUpdateFailureReason;
  readonly failureStage?: ConsoleUpdateFailureStage;
}

export function isConsoleUpdateWorkerMessage(value: unknown, runId: string, version: number): value is ConsoleUpdateWorkerMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return entry.v === version && entry.runId === runId
    && ["prepare", "ready", "commit", "committed", "abort", "failed"].includes(entry.kind as string);
}

/** The command that starts the Console for this data directory, or explains what keeps it from starting. */
export const CONSOLE_START_COMMAND = "fleet console start";

/**
 * 준비 또는 수락 이후 업데이트의 실패 사유(`reason`).
 * - preflight-failed: 실제 worker의 설치 준비에 실패했다.
 * - preflight-timeout: 실제 worker의 준비 예산이 소진됐다.
 * - handoff-aborted: commit 또는 host의 실제 정지로 인계가 이어지지 않았다.
 * - lifecycle-runtime-mismatch: the worker's copy of the lifecycle runtime did not match what the Console recorded.
 * - old-console-unverified: the old Console still held its lock after B_ext and its identity could not be proven again.
 * - old-console-replaced: the old Console's lock names a live pid that started after the lock was written.
 * - old-console-still-running: the old Console released its lock but was still running after B_ext.
 * - old-console-kill-failed: the old Console outlived SIGKILL.
 * - install-failed: the package manager could not be used, or the install exited with an error.
 * - new-console-not-started: the new Console could not take the Console lock.
 * - new-console-unhealthy: the new Console did not become healthy within CONSOLE_START_TIMEOUT_MS.
 * - worker-lost: the worker is gone (ESRCH) without having recorded an outcome.
 * Additive: a reader that meets a reason it does not know reads `unknown`, never a success.
 */
export type ConsoleUpdateFailureReason =
  | "preflight-failed"
  | "preflight-timeout"
  | "handoff-aborted"
  | "lifecycle-runtime-mismatch"
  | "old-console-unverified"
  | "old-console-replaced"
  | "old-console-still-running"
  | "old-console-kill-failed"
  | "install-failed"
  | "new-console-not-started"
  | "new-console-unhealthy"
  | "worker-lost";

const UPDATE_FAILURE_REASONS: readonly ConsoleUpdateFailureReason[] = [
  "preflight-failed",
  "preflight-timeout",
  "handoff-aborted",
  "lifecycle-runtime-mismatch",
  "old-console-unverified",
  "old-console-replaced",
  "old-console-still-running",
  "old-console-kill-failed",
  "install-failed",
  "new-console-not-started",
  "new-console-unhealthy",
  "worker-lost",
];

/** A recorded reason as a reader sees it; null when nothing was recorded. */
export function parseConsoleUpdateFailureReason(value: unknown): ConsoleUpdateFailureReason | "unknown" | null {
  if (value === undefined || value === null) return null;
  return UPDATE_FAILURE_REASONS.includes(value as ConsoleUpdateFailureReason) ? value as ConsoleUpdateFailureReason : "unknown";
}

/**
 * How the old Console ended, as the update's progress record carries it (`oldConsoleOutcome`): its exit record's outcome,
 * `unrecorded` when it cannot be blamed, or `unknown` for an outcome this reader does not name.
 */
export type ConsoleUpdateOldConsoleEnding = ConsoleExitOutcome | "unrecorded" | "unknown";

const OLD_CONSOLE_ENDINGS: readonly ConsoleUpdateOldConsoleEnding[] = ["clean", "deadline", "crash", "failed", "external", "forced-external", "unrecorded"];

/** A recorded ending as a reader sees it; null when nothing was recorded. */
export function parseConsoleUpdateOldConsoleEnding(value: unknown): ConsoleUpdateOldConsoleEnding | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return OLD_CONSOLE_ENDINGS.includes(value as ConsoleUpdateOldConsoleEnding) ? value as ConsoleUpdateOldConsoleEnding : "unknown";
}

/** Facts a failure text may name. Never a path: this text reaches the browser. */
export interface ConsoleUpdateFailureFacts {
  /** The pid of the Console the update replaced. */
  readonly oldConsolePid?: number;
  readonly failureStage?: ConsoleUpdateFailureStage;
}

const seconds = (ms: number): string => `${Math.round(ms / 1_000)}s`;

/**
 * The shared, path-free explanation of an update failure: what happened and what was not done. The Console serves it
 * with the update's progress; the lock file and the full manual steps are printed by `fleet console start` on the machine
 * itself, where paths may be shown.
 */
export function describeConsoleUpdateFailure(reason: ConsoleUpdateFailureReason | "unknown", facts: ConsoleUpdateFailureFacts = {}): string {
  const pid = facts.oldConsolePid === undefined ? "" : ` (pid ${facts.oldConsolePid})`;
  const lockPid = facts.oldConsolePid === undefined ? "the previous Console's pid" : `pid ${facts.oldConsolePid}`;
  switch (reason) {
    case "preflight-failed":
      return "The update worker could not prepare the package manager or installation directory. The update did not ask the Console to stop and installed nothing.";
    case "preflight-timeout":
      return `The update worker did not finish its checks within ${seconds(UPDATE_WORKER_PREFLIGHT_MS)}. The update did not ask the Console to stop and installed nothing.`;
    case "handoff-aborted":
      return "The update handoff did not complete. Its worker sent no stop signal, installed nothing, and started no other Console.";
    case "lifecycle-runtime-mismatch":
      if (facts.failureStage === "preflight") return "The update worker could not verify its copy of the Console lifecycle runtime. The update did not ask the Console to stop, install anything, or start another Console.";
      return "The update worker's copy of the Console lifecycle runtime did not match what the Console recorded, so it judged, signalled, and installed nothing. It started the previous version once the old Console had ended, and started nothing if the old Console was still running.";
    case "old-console-unverified":
      return `The previous Console${pid} still held its lock ${seconds(EXTERNAL_ESCALATION_MS)} after it was asked to stop, and the update could not prove again that the process was that Console, so it sent no signal and installed nothing. If that process is a stuck Fleet Console, end it, then start Fleet Console again.`;
    case "old-console-replaced":
      return `The Console lock names ${lockPid}, which is now another program that reused the pid of a Console that has ended. The lock was left in place and nothing was installed; no Console starts beside it while that pid runs.`;
    case "old-console-still-running":
      return `The previous Console${pid} released its lock but was still running ${seconds(EXTERNAL_ESCALATION_MS)} later, still ending its own child processes, so nothing was installed under it. The update then started the previous version again.`;
    case "old-console-kill-failed":
      return `The previous Console${pid} was force-quit after ${seconds(EXTERNAL_ESCALATION_MS)} but was still running ${seconds(KILL_CONFIRM_MS)} later, so nothing was installed.`;
    case "install-failed":
      return "The new release could not be installed: the package manager could not be used or its install failed. The previous version stays installed.";
    case "new-console-not-started":
      return "The new release was installed, but its Console could not take the Console lock because something still holds it.";
    case "new-console-unhealthy":
      return `The new release was installed, but its Console did not become healthy within ${seconds(CONSOLE_START_TIMEOUT_MS)}.`;
    case "worker-lost":
      return "The update worker ended before it recorded how the update finished.";
    default:
      return "The update failed for a reason this Console does not recognize.";
  }
}

/** The shared explanation of how the Console an update replaced ended (`oldConsoleOutcome`). */
export function describeConsoleUpdateOldConsoleEnding(ending: ConsoleUpdateOldConsoleEnding): string {
  switch (ending) {
    case "clean":
      return "The previous Console shut down normally.";
    case "deadline":
      return `The previous Console reached its ${seconds(CONSOLE_STOP_DEADLINE_MS)} stop deadline and ended its leftover child processes.`;
    case "crash":
      return "The previous Console crashed.";
    case "failed":
      return "The previous Console ended with an error.";
    case "external":
      return "The previous Console was ended from outside before it could record how it ended.";
    case "forced-external":
      return `The previous Console was force-quit after it was still holding its lock ${seconds(EXTERNAL_ESCALATION_MS)} after it was asked to stop.`;
    case "unrecorded":
      return "The previous Console ended without a record of how.";
    default:
      return "The previous Console ended in a way this Console does not recognize.";
  }
}

/**
 * What a screen that waited for an update can say once the Console has been silent for UPDATE_FAILED_CONSOLE_RETURN_MS:
 * not a failure, only the two things that silence can mean.
 */
export function describeConsoleUpdateSilence(): string {
  const budget = seconds(UPDATE_FAILED_CONSOLE_RETURN_MS);
  return `Fleet Console has not answered for ${budget} since it stopped for the update. An update that fails before installing brings a Console back within ${budget}, so this one may still be installing, or it may have ended with no Console to come back to. This screen keeps checking.`;
}

/**
 * The shared manual recovery for an update that left no Console answering. It names no path: `fleet console start`
 * prints the lock file and the steps for whatever holds it (describeReplacedLockAuthor, the quiescence check, and so on).
 */
export function describeConsoleUpdateRecovery(): string {
  return `If it still does not come back, run ${CONSOLE_START_COMMAND} in a terminal on the machine that runs Fleet Console. It starts the Console again, or, if something still holds the Console lock, starts none beside it and prints what holds the lock, where the lock file is, and how to free it.`;
}
