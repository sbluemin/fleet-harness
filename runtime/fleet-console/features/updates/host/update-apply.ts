import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { consoleReleaseTarballDir, createGlobalPackageUpdater, downloadVerifiedConsoleTarball } from "@fleet-console/updates";
import type { ConsoleTarballDownload, GlobalPackageManagerCommand } from "@fleet-console/updates";
import { getFleetDataDir } from "@fleet-console/infra/data-dir";
import { withHidden, withNodeSystemCa } from "@fleet-console/process";
import { DESKTOP_RESOURCE_ROOT_MARKER, isDesktopResourceRootMarkerValid } from "@fleet-console/protocol/desktop";
import {
  CONSOLE_LIFECYCLE_CONTRACT_VERSION, CONSOLE_SERVE_EXIT_LOCK_HELD,
  UPDATE_WORKER_HANDSHAKE_VERSION, UPDATE_WORKER_PREFLIGHT_MS, UPDATE_WORKER_COMMIT_MS,
  describeConsoleUpdateFailure, isConsoleUpdateWorkerMessage,
  type ConsoleUpdateApplyFailureProgress, type ConsoleUpdateFailureStage, type ConsoleUpdateFailureReason,
} from "@fleet-console/protocol/lifecycle";
import type { ConsoleReleaseManifest } from "@fleet-console/protocol/release";

import { CONSOLE_UPDATE_PROGRESS_FILE, CONSOLE_UPDATE_OUTCOME_TTL_MS, writeConsoleUpdateProgress } from "./update-progress.js";
import { prepareUpdateWorker, type PreparedUpdateWorker, type UpdateWorkerChild } from "./update-worker-handoff.js";

export interface ConsoleUpdateApplyService {
  start(request: ConsoleUpdateApplyRequest): Promise<ConsoleUpdateApplyStartResult>;
  /** 디스크 기록 실패에도 살아 있는 host는 자신이 확정한 거절을 읽어 준다. */
  getFailure?(): ConsoleUpdateApplyFailureProgress | null;
}

export class ConsoleUpdateApplyPreflightError extends Error {
  constructor(readonly progress: ConsoleUpdateApplyFailureProgress) {
    super("update_worker_unavailable");
    this.name = "ConsoleUpdateApplyPreflightError";
  }
}

export interface ConsoleUpdateApplyRequest {
  readonly currentPid: number;
  readonly dataDir: string;
  readonly currentEndpoint: string;
  /** The token of the lock this Console holds; the worker proves the pid it signals with it. */
  readonly currentLockToken: string;
  /** The `startedAt` of that lock: with the pid, the key of this Console's exit record. */
  readonly currentLockStartedAt: number;
  readonly currentPackageRoot: string;
  readonly lockFile: string;
  /** The release the update check verified; its version is the target and its sha256 guards the bytes. */
  readonly release: ConsoleReleaseManifest;
  readonly fromVersion: string;
}

export type ConsoleUpdateApplyStartResult = PreparedUpdateWorker;

export interface CreateConsoleUpdateApplyServiceDeps {
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Name of the Console failure log in the data directory. A serve that does not take the lock records why there, and a
   * failed update points to it. Composition supplies it; without it the update only names the lock refusal.
   */
  readonly failureLogName?: string;
  /** Fleet data root; verified release tarballs are kept beneath it for as long as they stay installed. */
  readonly fleetDataDir?: string;
  readonly downloadTarball?: (release: ConsoleReleaseManifest, releasesDir: string) => Promise<ConsoleTarballDownload>;
  readonly removeFile?: (filePath: string) => void;
  readonly execPath?: string;
  readonly makeDir?: (dirPath: string, options: { readonly mode: number; readonly recursive: true }) => void;
  readonly now?: () => number;
  readonly processPid?: number;
  readonly preflightInstall?: (currentPackageRoot: string) => Promise<ConsoleUpdatePackageManagerSpec> | ConsoleUpdatePackageManagerSpec;
  readonly serverModulePath?: string;
  readonly spawnWorker?: ConsoleUpdateWorkerSpawner;
  readonly tmpDir?: string;
  /** The built lifecycle runtime the worker imports (dist/lifecycle-worker-runtime.mjs beside the Console bundle). */
  readonly workerRuntimePath?: string;
  readonly writeFile?: (filePath: string, content: string, options: { readonly mode: number }) => void;
}

export interface ConsoleUpdateWorkerScriptConfig {
  readonly runId: string;
  readonly currentEndpoint: string;
  readonly currentLockToken: string;
  readonly currentLockStartedAt: number;
  /** The copy of the lifecycle runtime beside the worker, the sha256 of its bytes, and the revision it must report. */
  readonly lifecycleRuntimePath: string;
  readonly lifecycleRuntimeSha256: string;
  readonly lifecycleContractVersion: number;
  readonly fromVersion: string;
  readonly progressFile: string;
  /**
   * 새 데몬이 되찾아야 할 포트. 주소가 유지되면 열려 있던 화면이 스스로 다시 붙으므로,
   * 이 값이 곧 "같은 자리로 돌아온다"는 약속의 전부다.
   */
  readonly resumePort: number | null;
  readonly currentPackageRoot: string;
  readonly currentPid: number;
  readonly lockFile: string;
  readonly logFile: string;
  /** Where a serve that did not take the lock recorded why, or null when composition did not say. */
  readonly failureLogFile: string | null;
  readonly packageManager: ConsoleUpdatePackageManagerSpec;
  readonly packageNames: readonly [string, ...string[]];
  /** Already downloaded and sha256-verified before this Console was asked to stop. */
  readonly tarballPath: string;
  readonly releasesDir: string;
  readonly serverModulePath: string;
  readonly startedAt: string;
  readonly statusFile: string;
  readonly targetVersion: string;
  readonly workerPath: string;
}

export interface ConsoleUpdatePackageManagerSpec {
  readonly bin: string;
  readonly command: GlobalPackageManagerCommand;
  readonly globalRoot: string;
  readonly prefixArgs: readonly string[];
}

export type ConsoleUpdateWorkerProcess = UpdateWorkerChild;

export type ConsoleUpdateWorkerSpawner = (
  execPath: string,
  args: readonly string[],
  options: { readonly detached: true; readonly env: NodeJS.ProcessEnv; readonly stdio: ["ignore", "ignore", "ignore", "ipc"]; readonly windowsHide: true },
) => ConsoleUpdateWorkerProcess;

const PACKAGE_NAMES = ["@dotobokuri/fleet-console"] as const;
/** The worker could not prove the pid it would signal is still the Console that started it, so it sent no signal. */
export const CONSOLE_UPDATE_OLD_CONSOLE_UNVERIFIED = "old_console_unverified";
/** The reasons the worker records, by the step that failed (`reason` on the progress record; the contract names them). */
const WORKER_FAILURE_REASONS = {
  preflightFailed: "preflight-failed",
  preflightTimeout: "preflight-timeout",
  handoffAborted: "handoff-aborted",
  runtimeMismatch: "lifecycle-runtime-mismatch",
  oldUnverified: "old-console-unverified",
  oldReplaced: "old-console-replaced",
  oldStillRunning: "old-console-still-running",
  oldKillFailed: "old-console-kill-failed",
  installFailed: "install-failed",
  newNotStarted: "new-console-not-started",
  newUnhealthy: "new-console-unhealthy",
} as const satisfies Record<string, ConsoleUpdateFailureReason>;
const WORKER_FILE_PREFIX = "fleet-console-update-";
const WORKER_FILE_SUFFIX = ".mjs";
const RUNTIME_FILE_SUFFIX = ".lifecycle.mjs";
const STATUS_FILE_SUFFIX = ".status.json";
const LOG_FILE_SUFFIX = ".log";
const TEMP_FILE_MODE = 0o600;

export function createConsoleUpdateApplyService(deps: CreateConsoleUpdateApplyServiceDeps = {}): ConsoleUpdateApplyService {
  const env = deps.env ?? process.env;
  // TLS 검사 프록시 환경 대응(issue #531): OS 신뢰 저장소를 기본 신뢰한다. opt-out은 FLEET_CONSOLE_NO_SYSTEM_CA=1.
  const childEnv = env.FLEET_CONSOLE_NO_SYSTEM_CA === "1" ? env : withNodeSystemCa(env);
  const execPath = deps.execPath ?? process.execPath;
  const makeDir = deps.makeDir ?? ((dirPath, options) => {
    fs.mkdirSync(dirPath, options);
  });
  const now = deps.now ?? Date.now;
  const processPid = deps.processPid ?? process.pid;
  const preflightInstall = deps.preflightInstall ?? ((currentPackageRoot: string) => preflightPackageManager(currentPackageRoot, env));
  const downloadTarball = deps.downloadTarball ?? ((release: ConsoleReleaseManifest, dir: string) => downloadVerifiedConsoleTarball(release, { releasesDir: dir }));
  const removeFile = deps.removeFile ?? ((filePath: string) => fs.rmSync(filePath, { force: true }));
  const serverModulePath = deps.serverModulePath ?? resolveDefaultServerModulePath();
  const spawnWorker = deps.spawnWorker ?? defaultSpawnWorker;
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  const workerRuntimePath = deps.workerRuntimePath ?? resolveDefaultWorkerRuntimePath();
  const writeFile = deps.writeFile ?? ((filePath, content, options) => {
    fs.writeFileSync(filePath, content, { mode: options.mode });
  });

  let lastStartedAt = 0;
  let lastFailure: ConsoleUpdateApplyFailureProgress | null = null;
  let failedAt = 0;
  function recordFailure(request: ConsoleUpdateApplyRequest, startedAt: string, reason: ConsoleUpdateFailureReason | "unknown", failureStage: ConsoleUpdateFailureStage): ConsoleUpdateApplyPreflightError {
    lastFailure = {
      state: "failed", phase: "failed", startedAt, fromVersion: request.fromVersion,
      targetVersion: request.release.version, reason, failureStage,
      description: describeConsoleUpdateFailure(reason, { failureStage }),
    };
    failedAt = now();
    try {
      writeConsoleUpdateProgress(request.dataDir, { ...lastFailure, updatedAt: new Date(failedAt).toISOString() });
    } catch {
      // 살아 있는 host의 응답과 GET fallback은 기록 실패와 무관하게 같은 결론을 준다.
    }
    return new ConsoleUpdateApplyPreflightError(lastFailure);
  }

  async function start(request: ConsoleUpdateApplyRequest): Promise<ConsoleUpdateApplyStartResult> {
    // This is an installation-layout boundary, not Desktop provenance or a Console
    // release channel. The managed runtime is updated only by Desktop's hardened
    // entry-flow transaction until a recoverable same-window handoff exists.
    if (isManagedRuntimePackageRoot(request.currentPackageRoot)) throw new Error("managed_runtime_update_requires_relaunch");
    lastFailure = null;
    lastStartedAt = Math.max(now(), lastStartedAt + 1);
    const startedAt = new Date(lastStartedAt).toISOString();
    let packageManager: ConsoleUpdatePackageManagerSpec;
    try {
      packageManager = await preflightInstall(request.currentPackageRoot);
    } catch {
      throw recordFailure(request, startedAt, "preflight-failed", "preflight");
    }
    // Every byte is fetched and checked while this Console still serves. A failed download or a
    // hash mismatch is reported here, and nothing has been stopped or installed.
    const releasesDir = consoleReleaseTarballDir(deps.fleetDataDir ?? getFleetDataDir(env));
    const download = await downloadTarball(request.release, releasesDir);
    if (!download.ok) throw new Error(download.reason);
    const targetVersion = request.release.version;
    try {
      return await launchWorker(request, packageManager, { releasesDir, tarballPath: download.tarballPath, targetVersion }, startedAt);
    } catch (error) {
      try { removeFile(download.tarballPath); } catch { /* 실패 결론을 정리 오류로 덮지 않는다. */ }
      if (error instanceof ConsoleUpdateApplyPreflightError) throw error;
      throw recordFailure(request, startedAt, "preflight-failed", "preflight");
    }
  }

  async function launchWorker(
    request: ConsoleUpdateApplyRequest,
    packageManager: ConsoleUpdatePackageManagerSpec,
    target: { readonly releasesDir: string; readonly tarballPath: string; readonly targetVersion: string },
    startedAt: string,
  ): Promise<ConsoleUpdateApplyStartResult> {
    const { releasesDir, tarballPath, targetVersion } = target;
    const runId = crypto.randomUUID();
    const stamp = `${now()}-${processPid}-${runId}`;
    const workerPath = path.join(tmpDir, `${WORKER_FILE_PREFIX}${stamp}${WORKER_FILE_SUFFIX}`);
    makeDir(request.dataDir, { recursive: true, mode: 0o700 });
    const statusFile = path.join(request.dataDir, `${WORKER_FILE_PREFIX}${stamp}${STATUS_FILE_SUFFIX}`);
    const logFile = path.join(request.dataDir, `${WORKER_FILE_PREFIX}${stamp}${LOG_FILE_SUFFIX}`);
    const progressFile = path.join(request.dataDir, CONSOLE_UPDATE_PROGRESS_FILE);
    // The worker judges the old Console with this Console's lifecycle runtime. It is copied now, while the installed
    // package is still intact, and before anything stops: a missing or unreadable runtime fails the update here.
    let runtime: string;
    try {
      runtime = fs.readFileSync(workerRuntimePath, "utf8");
    } catch {
      throw recordFailure(request, startedAt, "lifecycle-runtime-mismatch", "preflight");
    }
    const lifecycleRuntimePath = path.join(tmpDir, `${WORKER_FILE_PREFIX}${stamp}${RUNTIME_FILE_SUFFIX}`);
    writeFile(lifecycleRuntimePath, runtime, { mode: TEMP_FILE_MODE });
    const script = emitConsoleUpdateWorkerScript({
      runId,
      currentEndpoint: request.currentEndpoint,
      currentLockToken: request.currentLockToken,
      currentLockStartedAt: request.currentLockStartedAt,
      lifecycleRuntimePath,
      lifecycleRuntimeSha256: crypto.createHash("sha256").update(runtime, "utf8").digest("hex"),
      lifecycleContractVersion: CONSOLE_LIFECYCLE_CONTRACT_VERSION,
      currentPackageRoot: request.currentPackageRoot,
      currentPid: request.currentPid,
      fromVersion: request.fromVersion,
      lockFile: request.lockFile,
      logFile,
      failureLogFile: deps.failureLogName ? path.join(request.dataDir, deps.failureLogName) : null,
      packageManager,
      packageNames: PACKAGE_NAMES,
      progressFile,
      releasesDir,
      resumePort: readEndpointPort(request.currentEndpoint),
      serverModulePath,
      statusFile,
      startedAt,
      tarballPath,
      targetVersion,
      workerPath,
    });
    writeFile(workerPath, script, { mode: TEMP_FILE_MODE });
    const child = spawnWorker(execPath, [workerPath], withHidden({ detached: true, env: childEnv, stdio: ["ignore", "ignore", "ignore", "ipc"] }));
    return prepareUpdateWorker(child, runId, () => {
      // worker는 prepare를 받기 전에는 쓰지 않는다. host의 starting이 실패 결론을 덮지 않는다.
      writeConsoleUpdateProgress(request.dataDir, {
        phase: "starting", startedAt, updatedAt: startedAt, targetVersion,
        fromVersion: request.fromVersion, workerPid: child.pid,
      });
    }, (reason, stage) => {
      for (const file of [workerPath, lifecycleRuntimePath, tarballPath]) {
        try { removeFile(file); } catch { /* 자신의 실행 파일만 최선 노력으로 정리한다. */ }
      }
      return recordFailure(request, startedAt, reason, stage);
    });
  }

  return { start, getFailure: () => now() - failedAt <= CONSOLE_UPDATE_OUTCOME_TTL_MS ? lastFailure : null };
}

export function emitConsoleUpdateWorkerScript(config: ConsoleUpdateWorkerScriptConfig): string {
  return `import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const config = ${JSON.stringify(config)};
const unverifiedError = ${JSON.stringify(CONSOLE_UPDATE_OLD_CONSOLE_UNVERIFIED)};
const reasons = ${JSON.stringify(WORKER_FAILURE_REASONS)};
const lockHeldExitCode = ${JSON.stringify(CONSOLE_SERVE_EXIT_LOCK_HELD)};
const UPDATE_WORKER_HANDSHAKE_VERSION = ${JSON.stringify(UPDATE_WORKER_HANDSHAKE_VERSION)};
const preflightMs = ${JSON.stringify(UPDATE_WORKER_PREFLIGHT_MS)};
const commitMs = ${JSON.stringify(UPDATE_WORKER_COMMIT_MS)};
const isConsoleUpdateWorkerMessage = ${String(isConsoleUpdateWorkerMessage)};
// Read before anything can wait, including the import of the lifecycle runtime: the Console that spawned this worker is its parent. While the parent is
// alive its pid cannot be handed to another process, and once it exits the OS reparents this worker at once,
// even while the exited parent is still an unreaped zombie. Windows keeps the original parent pid after it
// exits, so there the parent link proves nothing and only the lock-token health answer counts.
const startedAsChild = os.platform() !== "win32" && process.ppid === config.currentPid;

let consoleStopped = false;
// The Console's lifecycle runtime (docs/console-lifecycle-contract.md, "Update worker"): every judgment about the old and
// the new Console comes from it. Null until loaded, and never loaded from bytes the Console did not hand over.
let lifecycle = null;
// How the old Console ended, once known; carried on every later progress record.
let oldConsoleOutcome = null;
let failureStage = "preflight";
let controlState = "waiting";
const probeAbort = new AbortController();
let resolvePrepare;
let resolveCommit;
let rejectCancelled;
const prepareGate = new Promise((resolve) => { resolvePrepare = resolve; });
const commitGate = new Promise((resolve) => { resolveCommit = resolve; });
const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
cancelled.catch(() => {});
let controlTimer = setTimeout(() => abortControl(reasons.preflightTimeout), preflightMs);
process.on("message", onControlMessage);
process.on("disconnect", () => {
  if (controlState !== "committed") abortControl(reasons.handoffAborted);
});

function abortControl(reason) {
  if (controlState === "aborted" || controlState === "committed") return;
  controlState = "aborted";
  clearTimeout(controlTimer);
  probeAbort.abort();
  rejectCancelled(updateFailure(reason, reason));
}

function onControlMessage(message) {
  if (!isConsoleUpdateWorkerMessage(message, config.runId, UPDATE_WORKER_HANDSHAKE_VERSION)) return;
  if (message.kind === "abort") abortControl(reasons.handoffAborted);
  else if (message.kind === "prepare" && controlState === "waiting") {
    controlState = "preflight";
    resolvePrepare();
  } else if (message.kind === "commit" && controlState === "ready") {
    controlState = "committed";
    clearTimeout(controlTimer);
    resolveCommit();
  }
}

function notifyHost(kind, extra = {}) {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) { reject(updateFailure(reasons.handoffAborted, "update host disconnected")); return; }
    process.send({ v: UPDATE_WORKER_HANDSHAKE_VERSION, runId: config.runId, kind, ...extra }, (error) => error ? reject(error) : resolve());
  });
}

async function preflight() {
  lifecycle = await loadLifecycleRuntime();
  if (!lifecycle) throw updateFailure(reasons.runtimeMismatch, "lifecycle_runtime_mismatch");
  probeAbort.signal.throwIfAborted();
  const manager = await detectPackageManager();
  probeAbort.signal.throwIfAborted();
  ensureGlobalRootWritable(manager);
  return manager;
}

async function main() {
  await Promise.race([prepareGate, cancelled]);
  writeStatus("starting");
  const manager = await Promise.race([preflight(), cancelled]);
  writeStatus("preflight-ok", { manager: manager.command });
  failureStage = "handoff";
  controlState = "ready";
  clearTimeout(controlTimer);
  controlTimer = setTimeout(() => abortControl(reasons.handoffAborted), commitMs);
  await notifyHost("ready");
  await Promise.race([commitGate, cancelled]);
  await notifyHost("committed");
  // commit 확인이 유실된 host는 정지하지 않는다. 실제 정지 관측 전에는 ladder도 신호도 없다.
  const target = { lockFile: config.lockFile, pid: config.currentPid, endpoint: config.currentEndpoint, token: config.currentLockToken, startedAt: config.currentLockStartedAt };
  if (!await lifecycle.waitForUpdatedConsoleStop(target)) throw updateFailure(reasons.handoffAborted, "the update host did not begin stopping");
  failureStage = null;
  await stopCurrentConsole();
  writeStatus("installing", { manager: manager.command });
  await installPackages(manager);
  writeStatus("starting-daemon");
  const lock = await startNewDaemon();
  // 같은 주소로 돌아왔으면 열려 있던 화면이 스스로 다시 붙는다. 주소를 되찾지 못한 경우는
  // 기록으로만 남긴다 — Fleet은 사용자의 브라우저를 대신 열지 않는다.
  const endpointChanged = !isSameEndpoint(lock.endpoint, config.currentEndpoint);
  writeStatus("completed", endpointChanged ? { endpointChanged: true } : {});
}

main()
  .catch(async (error) => {
    const reason = sanitizeError(error);
    log("failed: " + reason + (error && error.updateReason ? " (" + error.updateReason + ")" : ""));
    // 실패는 복구를 시도하기 전에 기록한다. 복구가 끝나기를 기다리는 동안이나 복구가 실패해도
    // 다음에 뜨는 Console이 읽을 결론은 이미 디스크에 있다. 다만 기록이 실패해도 복구는 반드시
    // 간다 — 실패를 말할 화면을 다시 세우는 일이 그 기록보다 먼저다.
    const failure = {
      ...(failureStage ? { reason: error?.updateReason ?? reasons.preflightFailed, failureStage } : { error: reason, ...(error?.updateReason ? { reason: error.updateReason } : {}) }),
    };
    const progressRecorded = writeProgress("failed", failure);
    if (failureStage) await notifyHost("failed", failure).catch(() => {});
    try {
      writeStatusFile("failed", failure);
    } catch {
      // 진단 파일을 쓰지 못해도 복구는 간다.
    }
    log("phase: failed");
    // 콘솔을 이미 내린 뒤에 실패했다면, 실패를 말할 화면조차 없다. 옛 버전이라도
    // 다시 세워야 사용자가 무엇이 잘못됐는지 읽을 수 있다.
    if (consoleStopped && lifecycle) await recoverConsoleBestEffort();
    // 사용자가 읽을 기록을 남기지 못했을 때만 복구 뒤에 다시 쓴다. 복구된 Console은 새 업데이트를
    // 받을 수 있으므로, 그 사이 다른 실행이 쓴 기록(startedAt이 다름)은 덮어쓰지 않는다.
    if (!progressRecorded) {
      const current = readProgressStartedAt();
      if (current === "missing" || current === config.startedAt) writeProgress("failed", failure);
      else log("left the progress record alone: it belongs to another update run");
    }
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(controlTimer);
    probeAbort.abort();
    process.off("message", onControlMessage);
    if (process.connected) process.disconnect();
    if (failureStage) removeFileBestEffort(config.tarballPath);
    for (const file of [config.workerPath, config.lifecycleRuntimePath]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 자가 정리는 실패해도 업데이트 결과를 막지 않는다.
      }
    }
  });

/**
 * Imports the lifecycle runtime the Console copied beside this worker, only when its bytes and revision are the ones
 * that Console expected. Anything else returns null: the copy may be damaged or replaced, so nothing it says is trusted.
 */
async function loadLifecycleRuntime() {
  let bytes;
  try {
    bytes = fs.readFileSync(config.lifecycleRuntimePath);
  } catch (error) {
    log("lifecycle runtime unreadable: " + sanitizeError(error));
    return null;
  }
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== config.lifecycleRuntimeSha256) {
    log("lifecycle runtime mismatch: its sha256 is not the one the console recorded");
    return null;
  }
  try {
    const runtime = await import(pathToFileURL(config.lifecycleRuntimePath).href);
    if (runtime.CONSOLE_LIFECYCLE_CONTRACT_VERSION !== config.lifecycleContractVersion) {
      log("lifecycle runtime mismatch: revision " + String(runtime.CONSOLE_LIFECYCLE_CONTRACT_VERSION) + " is not " + config.lifecycleContractVersion);
      return null;
    }
    return runtime;
  } catch (error) {
    log("lifecycle runtime failed to load: " + sanitizeError(error));
    return null;
  }
}

/** An error that names the contract's reason for this failure (ConsoleUpdateFailureReason). */
function updateFailure(reason, message) {
  const error = new Error(message);
  error.updateReason = reason;
  return error;
}

function writeStatus(phase, extra = {}) {
  // 재기동한 데몬이 읽는 것은 고정 이름의 progress 기록이다. 타임스탬프가 붙은 status 파일은
  // 이 실행의 진단 흔적이고, progress가 "방금 무슨 일이 있었는가"에 답한다. 그래서 먼저 쓴다 —
  // 진단 파일 쓰기가 실패해도 사용자가 읽을 기록은 이미 남아 있다.
  writeProgress(phase, extra);
  writeStatusFile(phase, extra);
  log("phase: " + phase);
}

/** 사용자가 읽을 progress 기록. 쓰지 못해도 던지지 않고, 썼는지만 돌려준다. */
function writeProgress(phase, extra = {}) {
  const record = {
    phase,
    startedAt: config.startedAt,
    updatedAt: new Date().toISOString(),
    targetVersion: config.targetVersion,
    fromVersion: config.fromVersion,
  };
  if (extra.endpointChanged === true) record.endpointChanged = true;
  if (typeof oldConsoleOutcome === "string") record.oldConsoleOutcome = oldConsoleOutcome;
  if (typeof extra.error === "string") record.error = extra.error;
  if (typeof extra.reason === "string") record.reason = extra.reason;
  if (typeof extra.failureStage === "string") record.failureStage = extra.failureStage;
  if (phase === "failed") record.oldConsolePid = config.currentPid;
  // The next Console reads this worker as lost the moment its pid is gone (ESRCH) with no outcome recorded.
  record.workerPid = process.pid;
  try {
    const staging = config.progressFile + "." + config.runId + ".tmp";
    fs.writeFileSync(staging, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(staging, config.progressFile);
    return true;
  } catch {
    // 진단 기록이 없다고 업데이트를 멈추지는 않는다.
    return false;
  }
}

function writeStatusFile(phase, extra = {}) {
  fs.writeFileSync(config.statusFile, JSON.stringify({ phase, updatedAt: new Date().toISOString(), ...extra }, null, 2), { mode: 0o600 });
}

/** progress 기록이 어느 실행의 것인지(startedAt). 파일이 없으면 "missing", 읽지 못하면 null. */
function readProgressStartedAt() {
  let raw;
  try {
    raw = fs.readFileSync(config.progressFile, "utf8");
  } catch (error) {
    return error && error.code === "ENOENT" ? "missing" : null;
  }
  try {
    const record = JSON.parse(raw);
    return record && typeof record.startedAt === "string" ? record.startedAt : null;
  } catch {
    return null;
  }
}

/** 진단 흔적일 뿐이다 — 쓰지 못해도 업데이트·복구의 흐름을 바꾸지 않는다. */
function log(message) {
  try {
    fs.appendFileSync(config.logFile, new Date().toISOString() + " " + message + "\\n", { mode: 0o600 });
  } catch {
    // 로그 파일을 쓸 수 없어도 계속한다.
  }
}

async function stopCurrentConsole() {
  writeStatus("stopping-console");
  // 수락한 Console은 응답 뒤 스스로 정지를 시작한다. 이 worker의 요청은 이미 전달됐으므로 SIGTERM을 보내지 않고(Windows에서는
  // 곧 TerminateProcess다), 정지 예산 뒤에도 정체를 다시 증명한 같은 Console이 lock을 쥐고 있을 때만 SIGKILL한다.
  consoleStopped = true;
  const stopped = await lifecycle.stopUpdatedConsole({
    console: { lockFile: config.lockFile, pid: config.currentPid, endpoint: config.currentEndpoint, token: config.currentLockToken, startedAt: config.currentLockStartedAt },
    isParent: () => startedAsChild && process.ppid === config.currentPid,
    log,
  });
  if (stopped.ending !== null) oldConsoleOutcome = stopped.ending;
  if (stopped.result === "unverified") {
    // 신호도 lock 삭제도 하지 않았다. 그 pid가 멈춘 Console이면 사용자가 직접 끝내야 한다.
    log("no signal sent: pid " + config.currentPid + " never proved it is the console being updated");
    throw updateFailure(reasons.oldUnverified, unverifiedError);
  }
  if (stopped.result === "kill-failed") throw updateFailure(reasons.oldKillFailed, "old console did not stop before timeout");
  if (stopped.result === "replaced") {
    // 옛 pid를 다른 프로그램이 물려받았고 lock은 그대로다. 그 pid가 끝나기 전에는 어떤 Console도 시작할 수 없으므로 설치하지
    // 않는다. 신호도, lock 삭제도, spawn도 없다.
    log("not installed: " + stopped.detail);
    throw updateFailure(reasons.oldReplaced, String(stopped.detail).split("\\n")[0]);
  }
  if (stopped.result === "still-running") {
    // lock은 놓았지만 옛 프로세스가 자식을 거두며 아직 살아 있다. 그 프로세스가 올린 파일을 그 아래에서 바꾸지 않는다.
    log("not installed: pid " + config.currentPid + " released its lock but was still running after the stop budget");
    throw updateFailure(reasons.oldStillRunning, "the old console released its lock but was still running, so the update was not installed");
  }
  // 이전 Console이 끝났거나 lock을 놓았다. 남긴 lock은 지우지 않는다 — 새 Console의 serve가 그 pid의 ESRCH를 확인하고
  // 회수 프로토콜로 치운다.
  log("old console stopped" + (oldConsoleOutcome ? " (" + oldConsoleOutcome + ")" : "") + "; its lock is left for the new console to reclaim");
}

async function detectPackageManager() {
  const configured = config.packageManager;
  try {
    const root = (await new Promise((resolve, reject) => {
      execFile(configured.bin, [...configured.prefixArgs, "root", "-g"], {
        encoding: "utf8", signal: probeAbort.signal, killSignal: "SIGKILL", windowsHide: true,
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    })).trim();
    if (!root) throw new Error("global package manager root is empty");
    const rootReal = safeRealpath(root);
    const packageReal = normalizeExistingPath(config.currentPackageRoot);
    if (!rootReal || !packageReal) throw new Error("global package manager root could not be resolved");
    if (isPathInside(packageReal, rootReal)) {
      return { ...configured, root: rootReal };
    }
    for (const packageName of config.packageNames) {
      if (packageReal === safeRealpath(path.join(root, packageName))) {
        return { ...configured, root: rootReal };
      }
    }
  } catch (error) {
    throw updateFailure(reasons.preflightFailed, "no supported global package manager found: " + sanitizeError(error));
  }
  throw updateFailure(reasons.preflightFailed, "no supported global package manager found");
}

function ensureGlobalRootWritable(manager) {
  try {
    fs.accessSync(manager.root, fs.constants.W_OK);
  } catch {
    throw updateFailure(reasons.preflightFailed, "global package manager root is not writable");
  }
}

async function installPackages(manager) {
  // The package's postinstall would otherwise start a Console of its own and race startNewDaemon.
  const env = { ...process.env, FLEET_CONSOLE_NO_AUTO_START: "1" };
  const code = await spawnExit(manager.bin, [...manager.prefixArgs, "i", "-g", "--force", config.tarballPath], env);
  if (code !== 0) {
    removeFileBestEffort(config.tarballPath);
    throw updateFailure(reasons.installFailed, "global package install failed with exit code " + code);
  }
  // pnpm records a tarball install as a file: dependency, so the installed tarball has to stay.
  // Everything older is no longer referenced once this install has succeeded.
  pruneReleaseTarballs();
}

function pruneReleaseTarballs() {
  let entries;
  try {
    entries = fs.readdirSync(config.releasesDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(config.releasesDir, entry);
    if (entryPath === config.tarballPath) continue;
    if (!/^fleet-console-.+\.tgz$/.test(entry)) continue;
    removeFileBestEffort(entryPath);
  }
}

function removeFileBestEffort(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // 남은 tarball은 다음 업데이트가 정리한다.
  }
}

function daemonEnv() {
  if (config.resumePort === null) return process.env;
  return { ...process.env, FLEET_CONSOLE_RESUME_PORT: String(config.resumePort) };
}

/**
 * Starts a detached Console serve with no stdio, like every detached Console: it outlives this worker, so nothing here
 * could keep reading its output or bound it. The returned record shows the serve's exit while this worker still waits
 * on it; a serve that does not take the lock records why in the Console failure log (config.failureLogFile).
 */
function spawnServe() {
  const serve = { exited: false, code: null, signal: null };
  const child = spawn(process.execPath, [config.serverModulePath, "serve"], {
    detached: true,
    env: daemonEnv(),
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", () => {});
  child.once("exit", (code, signal) => {
    serve.exited = true;
    serve.code = code;
    serve.signal = signal;
  });
  child.unref();
  return serve;
}

/** The failure text stays free of paths: it reaches the browser through the progress record. The run log names the file. */
function describeServeExit(serve) {
  if (serve.code === lockHeldExitCode) {
    log("the new console did not take the Console lock; the slot is " + describeSlot(judgeSlot()) + (config.failureLogFile ? "; the reason is recorded in " + config.failureLogFile : ""));
    return "the new console did not take the Console lock" + (config.failureLogFile ? "; the reason is recorded in " + path.basename(config.failureLogFile) + " in the Console data folder" : "");
  }
  return "the new console exited before it became healthy (code=" + serve.code + " signal=" + serve.signal + ")";
}

/** Whether a new serve may start: only when the lock is gone or its pid is ESRCH (the runtime's judgment). */
function judgeSlot() {
  return lifecycle.judgeSlotForStart(config.lockFile, { pid: config.currentPid, token: config.currentLockToken });
}

function describeSlot(slot) {
  return slot.kind === "held" || slot.kind === "blocked" ? slot.kind + " (" + slot.detail + ")" : slot.kind;
}

/** The Console now in the slot. With requireTargetVersion, only a Console other than the old one at the target version counts. */
function probeSlot(requireTargetVersion, deadline) {
  return lifecycle.probeSlotConsole(config.lockFile, requireTargetVersion
    ? { deadline, targetVersion: config.targetVersion, oldPid: config.currentPid }
    : { deadline });
}

async function startNewDaemon() {
  // 다른 호스트가 lock을 얻고 초기화 중이면 ready까지 기다린다. 503을 보고 경쟁자를 더 띄우지 않는다.
  const deadline = Date.now() + lifecycle.CONSOLE_START_TIMEOUT_MS;
  const existing = await waitForExistingConsole(true, deadline);
  if (existing) return existing;
  if (Date.now() >= deadline) throw updateFailure(reasons.newUnhealthy, "new console daemon did not become healthy");
  // 살아 있는 pid가 쥔 lock 옆에는 띄우지 않는다. 그 pid가 무관한 프로그램이어도 ESRCH만 slot을 비운다.
  const slot = judgeSlot();
  if (slot.kind === "held" || slot.kind === "blocked") {
    log("new console not started: the slot is " + describeSlot(slot));
    throw updateFailure(reasons.newNotStarted, "the new console could not start: the Console lock is still held");
  }
  const serve = spawnServe();
  while (Date.now() < deadline) {
    const probe = await probeSlot(true, deadline);
    if (probe.state === "healthy") return probe;
    // 선판정 뒤 경쟁에서 졌어도 새 소유자가 초기화 중이면 같은 deadline 안에서 계속 기다린다.
    if (serve.exited && (serve.code !== lockHeldExitCode || probe.state !== "starting")) {
      throw updateFailure(serve.code === lockHeldExitCode ? reasons.newNotStarted : reasons.newUnhealthy, describeServeExit(serve));
    }
    await sleep(Math.min(lifecycle.CONSOLE_START_POLL_MS, Math.max(0, deadline - Date.now())));
  }
  throw updateFailure(reasons.newUnhealthy, "new console daemon did not become healthy");
}

/**
 * 설치가 실패한 뒤의 마지막 의무: 어떤 버전이든 콘솔을 다시 세운다. 여기서는 목표 버전을
 * 요구하지 않는다 — 옛 버전으로라도 살아 있어야 실패를 읽을 화면이 생긴다.
 */
async function recoverConsoleBestEffort() {
  try {
    // 복구할 화면이 이미 살아 있으면 버전과 무관하게 그 Console을 남긴다.
    const deadline = Date.now() + lifecycle.CONSOLE_START_TIMEOUT_MS;
    const existing = await waitForExistingConsole(false, deadline);
    if (existing) {
      log("recovery skipped: a healthy console is already running");
      return;
    }
    if (Date.now() >= deadline) {
      log("recovery did not become healthy before timeout");
      return;
    }
    // A live pid holds the lock (the old Console, or another program that reused its pid), or the lock cannot be read:
    // serve would refuse it, so a spawn here could only wait out the timeout. The user has to free the slot first.
    const slot = judgeSlot();
    if (slot.kind === "held" || slot.kind === "blocked") {
      log("recovery skipped: the slot is " + describeSlot(slot) + ", so no Console can start until it is freed");
      return;
    }
    const serve = spawnServe();
    while (Date.now() < deadline) {
      const probe = await probeSlot(false, deadline);
      if (probe.state === "healthy") {
        log("recovered console after failure");
        return;
      }
      // lock을 얻은 다른 Console의 초기화만 기다린다. 그 외 child 실패는 숨기지 않는다.
      if (serve.exited && (serve.code !== lockHeldExitCode || probe.state !== "starting")) {
        log("recovery failed: " + describeServeExit(serve));
        return;
      }
      await sleep(Math.min(lifecycle.CONSOLE_START_POLL_MS, Math.max(0, deadline - Date.now())));
    }
    log("recovery did not become healthy before timeout");
  } catch (error) {
    log("recovery failed: " + sanitizeError(error));
  }
}

function isSameEndpoint(left, right) {
  try {
    return new URL(left).host === new URL(right).host;
  } catch {
    return false;
  }
}

function spawnExit(command, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function waitForExistingConsole(requireTargetVersion, deadline) {
  while (Date.now() < deadline) {
    const probe = await probeSlot(requireTargetVersion, deadline);
    if (probe.state === "healthy") return probe;
    if (probe.state !== "starting") return null;
    await sleep(Math.min(lifecycle.CONSOLE_START_POLL_MS, Math.max(0, deadline - Date.now())));
  }
  return null;
}

function safeRealpath(targetPath) {
  try {
    return normalizePath(fs.realpathSync(targetPath));
  } catch {
    return "";
  }
}

function normalizeExistingPath(targetPath) {
  return safeRealpath(targetPath) || normalizePath(targetPath);
}

function normalizePath(targetPath) {
  const resolved = path.resolve(targetPath);
  return os.platform() === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replaceAll(config.currentPackageRoot, "[path]")
    .replaceAll(config.lockFile, "[path]")
    .replaceAll(config.logFile, "[path]")
    .replaceAll(config.statusFile, "[path]")
    .replaceAll(config.tarballPath, "[path]")
    .replaceAll(config.workerPath, "[path]")
    .replaceAll(config.lifecycleRuntimePath, "[path]");
}
`;
}

/** 되찾아야 할 포트는 지금 열려 있는 주소가 알고 있다. 읽히지 않으면 약속하지 않는다. */
function readEndpointPort(endpoint: string): number | null {
  try {
    const port = Number.parseInt(new URL(endpoint).port, 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/**
 * 이 설치 트리를 이 프로세스가 제자리에서 갈아 끼워도 되는가. 셸의 강화된 진입-흐름
 * 트랜잭션이 만들어 소유하는 레이아웃이면 안 된다 — Desktop provenance나 릴리스 채널이
 * 아니라 **설치 레이아웃**의 경계다.
 */
export function isManagedRuntimePackageRoot(packageRoot: string): boolean {
  if (path.basename(packageRoot) !== "latest" || path.basename(path.dirname(packageRoot)) !== "console") return false;
  try {
    return isDesktopResourceRootMarkerValid(fs.readFileSync(path.join(packageRoot, DESKTOP_RESOURCE_ROOT_MARKER), "utf8"));
  } catch {
    return false;
  }
}

async function preflightPackageManager(packageRoot: string, env: NodeJS.ProcessEnv): Promise<ConsoleUpdatePackageManagerSpec> {
  const updater = createGlobalPackageUpdater({
    env,
    packageNames: PACKAGE_NAMES,
    resolveCurrentPackageRoot: () => packageRoot,
  });
  const detection = await updater.detectPackageManager();
  if (detection.manager === undefined) {
    if (detection.reason === "permission") {
      throw new Error("global package manager root is not writable");
    }
    throw new Error("no supported global package manager found");
  }
  return {
    bin: detection.manager.resolved.bin,
    command: detection.manager.command,
    globalRoot: detection.manager.globalRoot,
    prefixArgs: detection.manager.resolved.prefixArgs,
  };
}

function defaultSpawnWorker(
  execPath: string,
  args: readonly string[],
  options: { readonly detached: true; readonly env: NodeJS.ProcessEnv; readonly stdio: ["ignore", "ignore", "ignore", "ipc"]; readonly windowsHide: true },
): ConsoleUpdateWorkerProcess {
  const child = spawn(execPath, [...args], options);
  child.once("error", () => {});
  return child;
}

/** The lifecycle runtime ships beside the Console bundle (dist/lifecycle-worker-runtime.mjs). */
function resolveDefaultWorkerRuntimePath(): string {
  return fileURLToPath(new URL("./lifecycle-worker-runtime.mjs", import.meta.url));
}

function resolveDefaultServerModulePath(): string {
  const builtPath = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  if (fs.existsSync(builtPath)) return builtPath;
  const sourcePath = fileURLToPath(import.meta.url);
  if (sourcePath.endsWith(".ts")) {
    return sourcePath.replace(/update-apply\.ts$/, "cli.ts");
  }
  return path.join(path.dirname(sourcePath), "cli.mjs");
}
