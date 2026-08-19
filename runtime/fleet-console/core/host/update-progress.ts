import fs from "node:fs";
import path from "node:path";

/**
 * 업데이트는 이 콘솔이 잠시 사라졌다 돌아오는 일이다. 그 사이 서버는 살아 있지 않으므로,
 * 진행 상태를 들고 있을 수 있는 것은 메모리가 아니라 디스크뿐이다 — 그리고 그것을 읽어
 * 사용자에게 결과를 말해 주는 것은 **다음 세대의 데몬**이다.
 *
 * 그래서 파일 이름은 고정이다. 타임스탬프가 붙은 이름은 쓴 쪽만 찾을 수 있고, 재기동한
 * 데몬은 "방금 무슨 일이 있었는가"를 되물을 수 없다.
 */
export const CONSOLE_UPDATE_PROGRESS_FILE = "update-progress.json";

/** 워커가 지나가는 국면. 순서 그대로이며, 종착은 completed 또는 failed 하나다. */
export type ConsoleUpdatePhase =
  | "starting"
  | "preflight-ok"
  | "stopping-console"
  | "installing"
  | "starting-daemon"
  | "completed"
  | "failed";

export interface ConsoleUpdateProgressRecord {
  readonly phase: ConsoleUpdatePhase;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly targetVersion: string;
  readonly fromVersion: string;
  /** 같은 주소로 돌아오지 못했을 때만 true. 그때만 워커가 새 창을 연다. */
  readonly endpointChanged?: boolean;
  readonly error?: string;
}

export type ConsoleUpdateProgressState = "idle" | "running" | "completed" | "failed";

export interface ConsoleUpdateProgressStatus {
  readonly state: ConsoleUpdateProgressState;
  readonly phase?: ConsoleUpdatePhase;
  readonly startedAt?: string;
  readonly targetVersion?: string;
  readonly fromVersion?: string;
  readonly endpointChanged?: boolean;
  readonly error?: string;
}

export const IDLE_CONSOLE_UPDATE_PROGRESS: ConsoleUpdateProgressStatus = { state: "idle" };

/**
 * 워커가 죽으면 마지막 국면이 영원히 남는다. 그 기록을 "진행 중"으로 계속 읽으면 화면의
 * 커튼도 영원히 걷히지 않으므로, 갱신이 끊긴 기록은 진행이 아니라 실패로 판정한다.
 */
export const CONSOLE_UPDATE_PROGRESS_STALE_MS = 10 * 60 * 1000;

/**
 * 결과는 겪은 사람에게 한 번 말하면 끝나는 소식이다. 기록은 디스크에 남으므로, 시효가
 * 없으면 다른 기기·다른 브라우저·시크릿 창이 몇 주 뒤에도 "업데이트되었습니다"를 본다.
 * 확인 여부는 브라우저마다 다르지만 사실의 신선도는 서버가 안다.
 */
export const CONSOLE_UPDATE_OUTCOME_TTL_MS = 6 * 60 * 60 * 1000;

const RUNNING_PHASES = new Set<ConsoleUpdatePhase>(["starting", "preflight-ok", "stopping-console", "installing", "starting-daemon"]);
const PROGRESS_FILE_MODE = 0o600;

export function consoleUpdateProgressPath(dataDir: string): string {
  return path.join(dataDir, CONSOLE_UPDATE_PROGRESS_FILE);
}

export interface ReadConsoleUpdateProgressDeps {
  readonly readFile?: (filePath: string) => string;
  readonly now?: () => number;
}

export function readConsoleUpdateProgress(dataDir: string, deps: ReadConsoleUpdateProgressDeps = {}): ConsoleUpdateProgressStatus {
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const now = deps.now ?? Date.now;
  let raw: string;
  try {
    raw = readFile(consoleUpdateProgressPath(dataDir));
  } catch {
    return IDLE_CONSOLE_UPDATE_PROGRESS;
  }
  const record = parseConsoleUpdateProgressRecord(raw);
  if (!record) return IDLE_CONSOLE_UPDATE_PROGRESS;
  return toConsoleUpdateProgressStatus(record, now());
}

export function toConsoleUpdateProgressStatus(record: ConsoleUpdateProgressRecord, nowMs: number): ConsoleUpdateProgressStatus {
  const shared = {
    phase: record.phase,
    startedAt: record.startedAt,
    targetVersion: record.targetVersion,
    fromVersion: record.fromVersion,
    ...(record.endpointChanged === true ? { endpointChanged: true } : {}),
  };
  if (record.phase === "completed" || record.phase === "failed") {
    const finishedAtMs = Date.parse(record.updatedAt);
    if (Number.isFinite(finishedAtMs) && nowMs - finishedAtMs > CONSOLE_UPDATE_OUTCOME_TTL_MS) return IDLE_CONSOLE_UPDATE_PROGRESS;
    if (record.phase === "completed") return { state: "completed", ...shared };
    return { state: "failed", ...shared, ...(record.error ? { error: record.error } : {}) };
  }
  if (!RUNNING_PHASES.has(record.phase)) return IDLE_CONSOLE_UPDATE_PROGRESS;
  const updatedAtMs = Date.parse(record.updatedAt);
  if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs > CONSOLE_UPDATE_PROGRESS_STALE_MS) {
    return { state: "failed", ...shared, error: "update_worker_lost" };
  }
  return { state: "running", ...shared };
}

export function parseConsoleUpdateProgressRecord(raw: string): ConsoleUpdateProgressRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (!isConsoleUpdatePhase(entry.phase)) return null;
  if (typeof entry.startedAt !== "string" || typeof entry.updatedAt !== "string") return null;
  if (typeof entry.targetVersion !== "string" || typeof entry.fromVersion !== "string") return null;
  return {
    phase: entry.phase,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    targetVersion: entry.targetVersion,
    fromVersion: entry.fromVersion,
    ...(entry.endpointChanged === true ? { endpointChanged: true } : {}),
    ...(typeof entry.error === "string" ? { error: entry.error } : {}),
  };
}

function isConsoleUpdatePhase(value: unknown): value is ConsoleUpdatePhase {
  return typeof value === "string"
    && (RUNNING_PHASES.has(value as ConsoleUpdatePhase) || value === "completed" || value === "failed");
}

export interface WriteConsoleUpdateProgressDeps {
  readonly makeDir?: (dirPath: string, options: { readonly mode: number; readonly recursive: true }) => void;
  readonly writeFile?: (filePath: string, content: string, options: { readonly mode: number }) => void;
}

/**
 * 수락 시점의 첫 기록은 서버가 남긴다. 워커가 첫 줄을 쓰기까지의 찰나에 화면이 새로고침되면,
 * 그 사이에는 "아무 일도 없다"고 답하게 되기 때문이다.
 */
export function writeConsoleUpdateProgress(
  dataDir: string,
  record: ConsoleUpdateProgressRecord,
  deps: WriteConsoleUpdateProgressDeps = {},
): void {
  const makeDir = deps.makeDir ?? ((dirPath, options) => {
    fs.mkdirSync(dirPath, options);
  });
  const writeFile = deps.writeFile ?? ((filePath, content, options) => {
    fs.writeFileSync(filePath, content, { mode: options.mode });
  });
  makeDir(dataDir, { recursive: true, mode: 0o700 });
  writeFile(consoleUpdateProgressPath(dataDir), JSON.stringify(record, null, 2), { mode: PROGRESS_FILE_MODE });
}
