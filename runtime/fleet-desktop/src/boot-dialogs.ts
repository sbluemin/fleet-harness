// Fatal startup conditions the user has to see: the sidecar would not come up, or a
// console this Desktop cannot adopt already owns the lock. Both end in a dialog and
// then an exit, so they share this file rather than each owning one.

import type { ConsoleLockRecoverRefusalCode } from "@fleet-console/lifecycle";
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

/**
 * Lock failures a person can clear from the dialog. A refused lock (symlink, another user) is never offered.
 * A Console that is starting, stopping, or that outlived SIGKILL is not offered either: it may still be that Console.
 */
export function consoleLockRecoverOffered(error: unknown): boolean {
  const code = error instanceof Error ? error.message : "";
  if (code === "console_lock_ownerless" || code === "console_lock_held") return true;
  if (code !== "console_lock_process_unverified") return false;
  const observed = readConflictDiagnostic(error)?.observed;
  return observed === "unverified" || observed === "untrusted";
}

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

export type ConsoleLockRecoverLanguage = "ko" | "en";

const RECOVER_BUTTON_LABELS: Readonly<Record<ConsoleLockRecoverLanguage, { readonly recover: string; readonly cancel: string }>> = {
  ko: { recover: "잠금 정리 후 다시 시작", cancel: "취소" },
  en: { recover: "Clear the lock and start again", cancel: "Cancel" },
};

/** The recover dialog, or null when this failure must not offer to delete the lock. */
export function describeConsoleLockRecoverDialog(error: unknown, logDirectory?: string | null, lang: ConsoleLockRecoverLanguage = "en"): ConsoleConflictDialogOptions | null {
  if (!consoleLockRecoverOffered(error)) return null;
  const labels = RECOVER_BUTTON_LABELS[lang];
  const code = error instanceof Error ? error.message : "";
  const diagnostic = readConflictDiagnostic(error);
  const { title, message, detail } = describeRecoverBody(code, diagnostic, logDirectory ?? null, lang, labels.recover);
  return {
    type: "warning",
    title,
    message,
    detail,
    buttons: [labels.recover, labels.cancel],
    defaultId: 1,
    cancelId: 1,
  };
}

function describeRecoverBody(
  code: string,
  diagnostic: ConflictDiagnostic | null,
  logDirectory: string | null,
  lang: ConsoleLockRecoverLanguage,
  recoverLabel: string,
): { readonly title: string; readonly message: string; readonly detail: string } {
  const korean = lang === "ko";
  const where = logDirectory ? (korean ? `\n\n진단 로그: ${logDirectory}` : `\n\nDiagnostic log: ${logDirectory}`) : "";
  const actionNote = korean
    ? `「${recoverLabel}」을 누르면 실행 중인 Console과 진행 중인 업데이트가 없는지 확인한 뒤 잠금을 정리하고 다시 시작합니다.`
    : `Choose "${recoverLabel}" to verify that no Fleet Console or update is active, clear the lock, and restart.`;
  if (code === "console_lock_process_unverified") {
    const untrusted = diagnostic?.observed === "untrusted";
    const title = korean
      ? (untrusted ? "Fleet Console 잠금을 신뢰할 수 없습니다" : "Fleet Console 잠금이 사용 중입니다")
      : (untrusted ? CONFLICT_HEADLINES.untrusted.title : CONFLICT_HEADLINES.unverified.title);
    const message = korean
      ? (untrusted
        ? "안전 검사를 통과하지 못한 잠금 파일을 실행 중인 프로세스가 잡고 있어 시작하지 못했습니다."
        : "실행 중인 프로세스가 잠금 파일을 잡고 있지만 Fleet Console인지 확인되지 않아 시작하지 못했습니다.")
      : (untrusted ? CONFLICT_HEADLINES.untrusted.message : CONFLICT_HEADLINES.unverified.message);
    const safetyLead = korean
      ? `실행 중인 Fleet Console이 없을 때만 잠금을 정리하세요. ${actionNote}`
      : `Clear the lock only if no Fleet Console is running. ${actionNote}`;
    const facts = diagnostic
      ? korean
        ? `\n\n프로세스: pid ${diagnostic.pid} (${untrusted ? "신뢰할 수 없음" : "미확인"})\n잠금 파일: ${diagnostic.lockFile}`
        : `\n\nProcess: pid ${diagnostic.pid} (observed: ${diagnostic.observed})\nReason: ${diagnostic.reason}\nLock file: ${diagnostic.lockFile}`
      : "";
    return { title, message, detail: `${safetyLead}${facts}${where}` };
  }
  const ownerless = code === "console_lock_ownerless";
  const title = korean ? "Fleet Console을 시작할 수 없습니다" : "Fleet Console Desktop could not start";
  const message = korean
    ? (ownerless
      ? "읽을 수 없는 잠금 파일이 남아 있어 Console을 시작하지 못했습니다."
      : "기존 잠금 파일이 남아 있어 Console을 시작하지 못했습니다.")
    : (ownerless
      ? "An unreadable Console lock file is blocking startup."
      : "An existing Console lock file is blocking startup.");
  const stateNote = korean
    ? (ownerless
      ? "잠금 파일이 비어 있거나 형식이 올바르지 않아 그대로 두었습니다."
      : "이전 실행에서 남은 잠금 파일이 슬롯을 점유하고 있어 그대로 두었습니다.")
    : (ownerless
      ? "The lock file is empty or cannot be read, so it was left untouched."
      : "An existing lock file is occupying the slot, so it was left untouched.");
  return { title, message, detail: `${stateNote} ${actionNote}${where}` };
}

const RECOVER_REFUSAL_MESSAGES: Readonly<Record<ConsoleLockRecoverRefusalCode, Readonly<Record<ConsoleLockRecoverLanguage, string>>>> = {
  live_console: {
    ko: "실행 중인 Console 프로세스가 있어 잠금을 지우지 않았습니다.",
    en: "A Fleet Console process is still running, so the lock was left in place.",
  },
  active_update: {
    ko: "업데이트가 진행 중이어서 잠금을 지우지 않았습니다.",
    en: "A Fleet Console update is still in progress, so the lock was left in place.",
  },
  symlink: {
    ko: "잠금 경로에 심볼릭 링크가 있어 안전을 위해 지우지 않았습니다.",
    en: "The lock path contains a symbolic link, so it was left untouched.",
  },
  foreign_owner: {
    ko: "다른 사용자가 소유한 잠금 항목이 있어 지우지 않았습니다.",
    en: "The lock slot contains an entry owned by another user, so it was left untouched.",
  },
  not_regular_file: {
    ko: "잠금 경로가 일반 파일이 아니어서 지우지 않았습니다.",
    en: "The lock path is not a regular file, so it was left untouched.",
  },
  lock_changed: {
    ko: "확인하는 도중 잠금 파일 상태가 바뀌어 지우지 않았습니다.",
    en: "The lock file changed while Fleet was checking it, so it was left untouched.",
  },
  unreadable: {
    ko: "잠금 상태를 안전하게 확인하거나 정리하지 못해 그대로 두었습니다.",
    en: "Fleet could not safely verify or clear the lock, so it was left untouched.",
  },
};

const RECOVER_REFUSAL_DETAILS_KO: Readonly<Record<ConsoleLockRecoverRefusalCode, string>> = {
  live_console: "실행 중인 Fleet Console을 종료한 뒤 다시 시작하세요.",
  active_update: "진행 중인 업데이트가 끝난 뒤 다시 시작하세요.",
  symlink: "심볼릭 링크는 안전을 위해 자동으로 삭제하지 않습니다. 경로를 직접 확인하세요.",
  foreign_owner: "현재 사용자 소유가 아닌 파일·디렉터리가 있어 자동으로 삭제하지 않습니다. 소유자와 권한을 확인하세요.",
  not_regular_file: "잠금 경로에 일반 파일이 아닌 항목이 있어 자동으로 삭제하지 않습니다.",
  lock_changed: "잠금 상태를 확인하는 동안 파일이 바뀌었거나 새 잠금이 생겼습니다. 잠시 뒤 다시 시도하세요.",
  unreadable: "잠금 파일을 안전하게 읽거나 정리할 수 없어 기존 상태를 그대로 두었습니다.",
};

export function describeConsoleLockRecoverRefusedDialog(
  result: { readonly code?: ConsoleLockRecoverRefusalCode; readonly reason: string },
  lang: ConsoleLockRecoverLanguage = "en",
  lockFile?: string | null,
): ConsoleConflictDialogOptions {
  const korean = lang === "ko";
  const code = result.code ?? "unreadable";
  const messages = RECOVER_REFUSAL_MESSAGES[code];
  const detail = korean
    ? `${RECOVER_REFUSAL_DETAILS_KO[code]}${lockFile ? `\n\n잠금 파일: ${lockFile}` : ""}`
    : result.reason;
  return {
    type: "warning",
    title: korean ? "잠금을 지우지 않았습니다" : "The lock was left in place",
    message: messages[lang],
    detail,
    buttons: [korean ? "확인" : "OK"],
    defaultId: 0,
    cancelId: 0,
  };
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
