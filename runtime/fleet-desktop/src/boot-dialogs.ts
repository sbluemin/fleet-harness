// Fatal startup conditions the user has to see: the sidecar would not come up, or a
// console this Desktop cannot adopt already owns the lock. Both end in a dialog and
// then an exit, so they share this file rather than each owning one.

import {
  describeConsoleOwnerOutlivedKill,
  describeUnprovenConsoleLockOwner,
  type ConsoleLockOwnerRecovery,
  type UnprovenConsoleLockOwnerState,
} from "@fleet-console/protocol/lifecycle";

import type { SidecarLockConflictCode, SidecarLockDiagnostic } from "./sidecar-supervisor.js";

// ─── boot failure ──────────────────────────────────────────────────────────────

/**
 * 부팅이 끝내 실패했을 때 사용자에게 남기는 말.
 *
 * Finder나 트레이로 실행하면 stderr는 어디에도 보이지 않는다 — 창도, 설명도 없이 앱이 사라지면
 * 사용자에게 남는 정보가 없다. 실패 코드를 무슨 일 · 왜 · 지금 할 일 세 조각으로 옮겨,
 * 종료하기 전에 한 번은 말하고 끝낸다.
 */
export interface BootFailureNotice {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}

export interface BootFailureDialogDependencies {
  readonly showErrorBox: (title: string, content: string) => void;
  readonly exit: (code: number) => void;
  /** 자세한 원인이 적힌 로그 파일의 디렉터리. 사용자가 열어 볼 수 있는 자리다. */
  readonly logDirectory?: string | null;
}

export function describeBootFailure(error: unknown, logDirectory?: string | null): BootFailureNotice {
  const code = error instanceof Error ? error.message : String(error);
  const where = logDirectory ? `\n\nDiagnostic log: ${logDirectory}` : "";
  const reported = readFailureDetail(error);
  if (code === "managed_node_engine_unsupported") {
    return {
      title: "Fleet Console Desktop could not start",
      message: "The managed Node runtime does not match what this Console build requires.",
      detail: `Install the latest Fleet Console Desktop release, which ships a matching runtime.${where}`,
    };
  }
  if (CONSOLE_LOCK_ERRORS.has(code)) {
    // The lock is left as it was. What holds it, or how to clear it by hand, is the Console's own lock text.
    return {
      title: "Fleet Console Desktop could not start",
      message: "Fleet Console's lock file is in the way, so no Console was started. The lock file was left untouched.",
      detail: `${reported ?? `Reported cause: ${code}`}${where}`,
    };
  }
  return {
    title: "Fleet Console Desktop could not start",
    message: "Startup stopped before the Console window opened.",
    detail: `Try opening it again. If it keeps failing, reinstall from the latest release.${where}\n\nReported cause: ${code}${reported ? `\n${reported}` : ""}`,
  };
}

const CONSOLE_LOCK_ERRORS = new Set(["console_lock_held", "console_lock_ownerless", "console_lock_refused"]);

/** The explanation a startup failure carries for the user (SidecarStartError.detail), when there is one. */
function readFailureDetail(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const detail = (error as { detail?: unknown }).detail;
  return typeof detail === "string" && detail.length > 0 ? detail : null;
}

export function showBootFailureAndExit(error: unknown, dependencies: BootFailureDialogDependencies): void {
  const notice = describeBootFailure(error, dependencies.logDirectory ?? null);
  try {
    dependencies.showErrorBox(notice.title, `${notice.message}\n\n${notice.detail}`);
  } catch {
    // 다이얼로그를 띄우지 못하는 상황이라도 종료 처리는 그대로 진행한다.
  } finally {
    dependencies.exit(1);
  }
}

// ─── console already owned ─────────────────────────────────────────────────────

export interface ConsoleConflictDialogOptions {
  readonly buttons: string[];
  readonly cancelId: number;
  readonly defaultId: number;
  readonly detail: string;
  readonly message: string;
  readonly title: string;
  readonly type: "warning";
}

export interface ConsoleConflictHandlerDependencies {
  readonly quit: () => void;
  readonly showMessageBox: (options: ConsoleConflictDialogOptions) => Promise<unknown>;
  /** 자세한 원인이 적힌 로그 파일의 디렉터리. 사용자가 열어 볼 수 있는 자리다. */
  readonly logDirectory?: string | null;
}

const CONSOLE_CONFLICT_ERRORS: ReadonlySet<string> = new Set<SidecarLockConflictCode>([
  "cli_daemon_requires_confirmation",
  "console_lock_foreign_process_unhealthy",
  "console_lock_process_unverified",
  "console_lock_process_unhealthy",
]);

/** The next steps the shared lock-owner explanations name, in Desktop's words. */
const DESKTOP_LOCK_OWNER_RECOVERY: ConsoleLockOwnerRecovery = {
  restart: "open Fleet Console Desktop again",
  retryWhenStarted: "Open Fleet Console Desktop again once it has finished starting.",
};

type ConflictKind = "running" | "not-responding" | UnprovenConsoleLockOwnerState | "outlived-kill";

/** Only the headline is Desktop's own; what was observed and what to do about it come from the lifecycle contract. */
const CONFLICT_HEADLINES: Readonly<Record<ConflictKind, { readonly title: string; readonly message: string }>> = {
  "running": { title: "Fleet Console is already running", message: "Another Fleet Console is already running." },
  "not-responding": { title: "Fleet Console is not responding", message: "Another Fleet Console holds the lock but is not responding." },
  "untrusted": { title: "Fleet Console's lock can't be trusted", message: "A running process holds a Fleet Console lock that failed its safety checks." },
  "unverified": { title: "Fleet Console's lock is in use", message: "A running process holds the Fleet Console lock but could not be confirmed as Fleet Console." },
  "starting": { title: "Fleet Console is taking too long to start", message: "The Fleet Console holding the lock did not finish starting." },
  "stopping": { title: "Fleet Console is still shutting down", message: "The previous Fleet Console has not finished shutting down." },
  "outlived-kill": { title: "Fleet Console could not be stopped", message: "The previous Fleet Console kept running even after it was force-quit." },
};

const RUNNING_GUIDANCE = "It was not started by this copy of Fleet Console Desktop, so Desktop will not take it over or stop it. Quit that Console (in a terminal: fleet console stop), then open Fleet Console Desktop again.";
const NO_DIAGNOSTIC_GUIDANCE = "Quit any running Fleet Console (in a terminal: fleet console stop), then open Fleet Console Desktop again.";

export function isConsoleConflict(error: unknown): boolean {
  return error instanceof Error && CONSOLE_CONFLICT_ERRORS.has(error.message);
}

/**
 * The acknowledgement for a Console this Desktop would not adopt, start beside, or could not stop. It is keyed on the
 * error code and the observed state only; the reason is shown as written, never parsed. A conflict without a readable
 * diagnostic still gets a dialog, with general guidance in place of the facts.
 */
export function describeConsoleConflict(error: unknown, logDirectory?: string | null): ConsoleConflictDialogOptions {
  const code = error instanceof Error ? error.message : "";
  const diagnostic = readConflictDiagnostic(error);
  const kind = conflictKind(code, diagnostic?.observed);
  const where = logDirectory ? `\nDiagnostic log: ${logDirectory}` : "";
  const detail = diagnostic
    ? [
      conflictGuidance(kind, diagnostic),
      "",
      `Process: pid ${diagnostic.pid} (observed: ${diagnostic.observed})`,
      `Reason: ${diagnostic.reason}`,
      `Lock file: ${diagnostic.lockFile}`,
      `The lock file was left untouched.${where}`,
    ].join("\n")
    : `${kind === "running" ? "Stop or quit the running Fleet Console before opening Fleet Console Desktop again." : NO_DIAGNOSTIC_GUIDANCE}\n\nThe lock file was left untouched.${where}`;
  const { title, message } = CONFLICT_HEADLINES[kind];
  return { type: "warning", title, message, detail, buttons: ["OK"], defaultId: 0, cancelId: 0 };
}

export async function showConsoleConflictAndQuit(error: unknown, dependencies: ConsoleConflictHandlerDependencies): Promise<void> {
  try {
    await dependencies.showMessageBox(describeConsoleConflict(error, dependencies.logDirectory ?? null));
  } catch {
    // The Desktop must still quit if Electron cannot display the acknowledgement dialog.
  } finally {
    dependencies.quit();
  }
}

function conflictKind(code: string, observed: string | undefined): ConflictKind {
  if (code === "cli_daemon_requires_confirmation") return "running";
  if (code === "console_lock_process_unhealthy") return "outlived-kill";
  if (code === "console_lock_foreign_process_unhealthy") return "not-responding";
  return unprovenState(observed);
}

/** The contract's own state for the explanation; anything it does not name reads as the most cautious one. */
function unprovenState(observed: string | undefined): UnprovenConsoleLockOwnerState {
  return observed === "untrusted" || observed === "starting" || observed === "stopping" ? observed : "unverified";
}

function conflictGuidance(kind: ConflictKind, diagnostic: ConflictDiagnostic): string {
  if (kind === "running") return RUNNING_GUIDANCE;
  if (kind === "outlived-kill") return describeConsoleOwnerOutlivedKill(diagnostic.lockFile, diagnostic.pid, DESKTOP_LOCK_OWNER_RECOVERY.restart);
  const state = kind === "not-responding" ? unprovenState(diagnostic.observed) : kind;
  return describeUnprovenConsoleLockOwner(diagnostic.lockFile, diagnostic.pid, state, DESKTOP_LOCK_OWNER_RECOVERY);
}

type ConflictDiagnostic = Pick<SidecarLockDiagnostic, "pid" | "lockFile" | "observed" | "reason">;

/**
 * The four diagnostic fields, each read on its own and type-checked. Nothing else on the error is read: the supervisor
 * holds lock payloads (and their tokens) nearby, and a copied object could carry one into the dialog.
 */
function readConflictDiagnostic(error: unknown): ConflictDiagnostic | null {
  if (!(error instanceof Error)) return null;
  const source = (error as { diagnostic?: unknown }).diagnostic;
  if (typeof source !== "object" || source === null) return null;
  const { pid, lockFile, observed, reason } = source as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof lockFile !== "string" || lockFile.length === 0) return null;
  if (typeof observed !== "string" || typeof reason !== "string") return null;
  return { pid, lockFile, observed, reason };
}
