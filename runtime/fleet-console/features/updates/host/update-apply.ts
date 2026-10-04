import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { consoleReleaseTarballDir, createGlobalPackageUpdater, downloadVerifiedConsoleTarball } from "@fleet-console/updates";
import type { ConsoleTarballDownload, GlobalPackageManagerCommand } from "@fleet-console/updates";
import { getFleetDataDir } from "@fleet-console/infra/data-dir";
import { withHidden, withNodeSystemCa } from "@fleet-console/process";
import { DESKTOP_RESOURCE_ROOT_MARKER, identifyConsoleLockOwner, isDesktopResourceRootMarkerValid } from "@fleet-console/protocol/desktop";
import type { ConsoleReleaseManifest } from "@fleet-console/protocol/release";

import { CONSOLE_UPDATE_PROGRESS_FILE, writeConsoleUpdateProgress } from "./update-progress.js";

export interface ConsoleUpdateApplyService {
  start(request: ConsoleUpdateApplyRequest): Promise<ConsoleUpdateApplyStartResult>;
}

export interface ConsoleUpdateApplyRequest {
  readonly currentPid: number;
  readonly dataDir: string;
  readonly currentEndpoint: string;
  /** The token of the lock this Console holds; the worker proves the pid it signals with it. */
  readonly currentLockToken: string;
  readonly currentPackageRoot: string;
  readonly lockFile: string;
  /** The release the update check verified; its version is the target and its sha256 guards the bytes. */
  readonly release: ConsoleReleaseManifest;
  readonly fromVersion: string;
}

export interface ConsoleUpdateApplyStartResult {
  readonly accepted: true;
}

export interface CreateConsoleUpdateApplyServiceDeps {
  readonly env?: NodeJS.ProcessEnv;
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
  readonly writeFile?: (filePath: string, content: string, options: { readonly mode: number }) => void;
}

export interface ConsoleUpdateWorkerScriptConfig {
  readonly currentEndpoint: string;
  readonly currentLockToken: string;
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

export interface ConsoleUpdateWorkerProcess {
  readonly pid?: number;
  once(event: "error", listener: (error: Error) => void): this;
  unref(): void;
}

export type ConsoleUpdateWorkerSpawner = (
  execPath: string,
  args: readonly string[],
  options: { readonly detached: true; readonly env: NodeJS.ProcessEnv; readonly stdio: "ignore"; readonly windowsHide: true },
) => ConsoleUpdateWorkerProcess;

const PACKAGE_NAMES = ["@dotobokuri/fleet-console"] as const;
/** The worker could not prove the pid it would signal is still the Console that started it, so it sent no signal. */
export const CONSOLE_UPDATE_OLD_CONSOLE_UNVERIFIED = "old_console_unverified";
const WORKER_FILE_PREFIX = "fleet-console-update-";
const WORKER_FILE_SUFFIX = ".mjs";
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
  const writeFile = deps.writeFile ?? ((filePath, content, options) => {
    fs.writeFileSync(filePath, content, { mode: options.mode });
  });

  async function start(request: ConsoleUpdateApplyRequest): Promise<ConsoleUpdateApplyStartResult> {
    // This is an installation-layout boundary, not Desktop provenance or a Console
    // release channel. The managed runtime is updated only by Desktop's hardened
    // entry-flow transaction until a recoverable same-window handoff exists.
    if (isManagedRuntimePackageRoot(request.currentPackageRoot)) throw new Error("managed_runtime_update_requires_relaunch");
    const packageManager = await preflightInstall(request.currentPackageRoot);
    // Every byte is fetched and checked while this Console still serves. A failed download or a
    // hash mismatch is reported here, and nothing has been stopped or installed.
    const releasesDir = consoleReleaseTarballDir(deps.fleetDataDir ?? getFleetDataDir(env));
    const download = await downloadTarball(request.release, releasesDir);
    if (!download.ok) throw new Error(download.reason);
    const targetVersion = request.release.version;
    try {
      return await launchWorker(request, packageManager, { releasesDir, tarballPath: download.tarballPath, targetVersion });
    } catch (error) {
      removeFile(download.tarballPath);
      throw error;
    }
  }

  async function launchWorker(
    request: ConsoleUpdateApplyRequest,
    packageManager: ConsoleUpdatePackageManagerSpec,
    target: { readonly releasesDir: string; readonly tarballPath: string; readonly targetVersion: string },
  ): Promise<ConsoleUpdateApplyStartResult> {
    const { releasesDir, tarballPath, targetVersion } = target;
    const stamp = `${now()}-${processPid}`;
    const workerPath = path.join(tmpDir, `${WORKER_FILE_PREFIX}${stamp}${WORKER_FILE_SUFFIX}`);
    makeDir(request.dataDir, { recursive: true, mode: 0o700 });
    const statusFile = path.join(request.dataDir, `${WORKER_FILE_PREFIX}${stamp}${STATUS_FILE_SUFFIX}`);
    const logFile = path.join(request.dataDir, `${WORKER_FILE_PREFIX}${stamp}${LOG_FILE_SUFFIX}`);
    const progressFile = path.join(request.dataDir, CONSOLE_UPDATE_PROGRESS_FILE);
    const startedAt = new Date(now()).toISOString();
    const script = emitConsoleUpdateWorkerScript({
      currentEndpoint: request.currentEndpoint,
      currentLockToken: request.currentLockToken,
      currentPackageRoot: request.currentPackageRoot,
      currentPid: request.currentPid,
      fromVersion: request.fromVersion,
      lockFile: request.lockFile,
      logFile,
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
    // 기록은 워커가 실제로 떠난 **뒤에** 남긴다. 띄우지도 못한 업데이트를 "진행 중"으로
    // 적어 두면, 그 사이 새로고침한 화면은 아무도 진행하지 않는 커튼 아래 갇힌다.
    await spawnDetachedWorker(spawnWorker, execPath, [workerPath], childEnv);
    // 그리고 워커가 첫 줄을 쓰기 전의 찰나에도 화면이 새로고침될 수 있다. 그때 "아무 일도
    // 없다"고 답하면 사용자는 업데이트가 취소된 줄 안다 — 수락은 여기서 기록한다.
    writeConsoleUpdateProgress(request.dataDir, {
      phase: "starting",
      startedAt,
      updatedAt: startedAt,
      targetVersion,
      fromVersion: request.fromVersion,
    }, { makeDir, writeFile });
    return { accepted: true };
  }

  return { start };
}

export function emitConsoleUpdateWorkerScript(config: ConsoleUpdateWorkerScriptConfig): string {
  return `import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const config = ${JSON.stringify(config)};
const stalePrefix = ${JSON.stringify(WORKER_FILE_PREFIX)};
const workerSuffix = ${JSON.stringify(WORKER_FILE_SUFFIX)};
const unverifiedError = ${JSON.stringify(CONSOLE_UPDATE_OLD_CONSOLE_UNVERIFIED)};
const stopTimeoutMs = 60000;
const startTimeoutMs = 60000;
const healthTimeoutMs = 1000;
const sleepMs = 250;
// The protocol's own verdict, emitted from the function the host imports — never a copy of bundled text.
const identifyConsoleLockOwner = ${String(identifyConsoleLockOwner)};
// Read before anything can wait: the Console that spawned this worker is its parent. While the parent is
// alive its pid cannot be handed to another process, and once it exits the OS reparents this worker at once,
// even while the exited parent is still an unreaped zombie. Windows keeps the original parent pid after it
// exits, so there the parent link proves nothing and only the lock-token health answer counts.
const startedAsChild = os.platform() !== "win32" && process.ppid === config.currentPid;

let consoleStopped = false;
let lastVerdictLine = "";

async function main() {
  writeStatus("starting");
  cleanupStaleWorkers();
  const manager = detectPackageManager();
  ensureGlobalRootWritable(manager);
  writeStatus("preflight-ok", { manager: manager.command });
  await stopCurrentConsole();
  await waitForOldConsoleExit();
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
    log("failed: " + reason);
    // 실패는 복구를 시도하기 전에 기록한다. 복구가 끝나기를 기다리는 동안이나 복구가 실패해도
    // 다음에 뜨는 Console이 읽을 결론은 이미 디스크에 있다.
    writeStatus("failed", { error: reason });
    // 콘솔을 이미 내린 뒤에 실패했다면, 실패를 말할 화면조차 없다. 옛 버전이라도
    // 다시 세워야 사용자가 무엇이 잘못됐는지 읽을 수 있다.
    if (consoleStopped) await recoverConsoleBestEffort();
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(config.workerPath, { force: true });
    } catch {
      // 자가 정리는 실패해도 업데이트 결과를 막지 않는다.
    }
  });

function writeStatus(phase, extra = {}) {
  const updatedAt = new Date().toISOString();
  fs.writeFileSync(config.statusFile, JSON.stringify({ phase, updatedAt, ...extra }, null, 2), { mode: 0o600 });
  // 재기동한 데몬이 읽는 것은 이 고정 이름의 기록이다. 타임스탬프가 붙은 위 파일은
  // 이 실행의 진단 흔적이고, 아래가 "방금 무슨 일이 있었는가"에 답하는 쪽이다.
  const record = {
    phase,
    startedAt: config.startedAt,
    updatedAt,
    targetVersion: config.targetVersion,
    fromVersion: config.fromVersion,
  };
  if (extra.endpointChanged === true) record.endpointChanged = true;
  if (typeof extra.error === "string") record.error = extra.error;
  try {
    fs.writeFileSync(config.progressFile, JSON.stringify(record, null, 2), { mode: 0o600 });
  } catch {
    // 진단 기록이 없다고 업데이트를 멈추지는 않는다.
  }
  log("phase: " + phase);
}

function log(message) {
  fs.appendFileSync(config.logFile, new Date().toISOString() + " " + message + "\\n", { mode: 0o600 });
}

function cleanupStaleWorkers() {
  const now = Date.now();
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (!entry.startsWith(stalePrefix) || !entry.endsWith(workerSuffix)) continue;
    const filePath = path.join(os.tmpdir(), entry);
    if (filePath === config.workerPath) continue;
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) fs.rmSync(filePath, { force: true });
    } catch {
      // 오래된 임시 worker 정리는 최선 노력으로만 수행한다.
    }
  }
}

async function stopCurrentConsole() {
  writeStatus("stopping-console");
  // 수락한 Console은 응답 뒤 스스로 정지를 시작한다. 신호를 보내지 못해도 이미 내려가는 중이다.
  consoleStopped = true;
  await signalOldConsoleIfVerified("SIGTERM");
}

/**
 * 이전 Console이 끝났다고 증명될 때(absent)까지 기다린다. 끝나지 않으면 마지막 10s에 한 번 SIGKILL로
 * 올리되, 그 직전의 판정이 verified일 때만 보낸다. pid가 살아 있다는 사실은 증명이 아니다 — 그 사이
 * 이전 Console이 끝나고 pid가 무관한 프로세스에 재할당될 수 있다.
 */
async function waitForOldConsoleExit() {
  const deadline = Date.now() + stopTimeoutMs;
  let escalated = false;
  let verdict = await identifyOldConsole();
  while (verdict.identity !== "absent") {
    if (Date.now() >= deadline) {
      if (verdict.identity === "verified") throw new Error("old console did not stop before timeout");
      // 신호도 lock 삭제도 하지 않는다. 그 pid가 멈춘 Console이면 사용자가 직접 끝내야 한다.
      log("no signal sent: pid " + config.currentPid + " never proved it is the console being updated");
      throw new Error(unverifiedError);
    }
    if (!escalated && Date.now() > deadline - 10000 && verdict.identity === "verified") {
      escalated = true;
      await signalOldConsoleIfVerified("SIGKILL");
    }
    await sleep(sleepMs);
    verdict = await identifyOldConsole();
  }
  // 이전 Console이 끝났다. 그것이 남긴 lock은 정의상 stale이다 — 같은 pid·token일 때만 우리가 치운다.
  removeStaleLock();
}

/** 신호 직전에 정체를 다시 판정하고, verified일 때만 보낸다. 판정 근거는 그때마다 기록한다. */
async function signalOldConsoleIfVerified(signal) {
  const verdict = await identifyOldConsole();
  if (verdict.identity !== "verified") {
    log(signal + " withheld: " + describeVerdict(verdict));
    return;
  }
  log(signal + " sent: " + describeVerdict(verdict));
  try {
    process.kill(config.currentPid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }
}

/**
 * 이전 Console의 정체. 근거는 Desktop의 sidecar 판정과 같은 둘뿐이다. 이 worker를 띄운 부모가 아직
 * 살아 있는 경우(Desktop이 수거 전 자기 child를 믿는 것과 같은 이유)와, lock token을 인증한 health가
 * 같은 pid를 답한 경우다. 나머지는 identifyConsoleLockOwner가 정한다.
 */
async function identifyOldConsole() {
  const pid = config.currentPid;
  let verdict;
  if (startedAsChild) {
    verdict = process.ppid === pid
      ? { identity: "verified", basis: "parent-alive" }
      : { identity: identifyConsoleLockOwner({ lockPid: pid, pidAlive: false, health: { kind: "unanswered" } }), basis: "parent-exited" };
  } else {
    const pidAlive = isProcessAlive(pid);
    const health = pidAlive ? await probeOldConsoleHealth() : { kind: "unanswered" };
    let identity = identifyConsoleLockOwner({ lockPid: pid, pidAlive, health });
    // 거절된 주소는 stale lock일 수도, listener를 먼저 닫고 정리 중이거나 그 도중 멈춘 Console일 수도
    // 있다(CLI stop과 같은 판단). 그 Console의 lock이 그대로면 끝났다고 보지 않는다.
    if (identity === "absent" && pidAlive && isLockStillHeldByOldConsole()) identity = "unverified";
    verdict = { identity, basis: "lock-token-health", pidAlive, health: pidAlive ? health.kind : "not-probed", ...(health.kind === "answered" ? { answeredPid: health.pid } : {}) };
  }
  const line = describeVerdict(verdict);
  if (line !== lastVerdictLine) {
    lastVerdictLine = line;
    log("identity: " + line);
  }
  return verdict;
}

function describeVerdict(verdict) {
  const detail = verdict.basis === "lock-token-health"
    ? " pidAlive=" + verdict.pidAlive + " health=" + verdict.health + (verdict.health === "answered" ? " answeredPid=" + String(verdict.answeredPid) : "")
    : verdict.basis === "parent-alive" ? " ppid=" + process.ppid : " ppid=" + process.ppid + " (was " + config.currentPid + ")";
  return verdict.identity + " for pid " + config.currentPid + " via " + verdict.basis + detail;
}

/** lock이 적은 주소와 token으로 묻는다. 정상 응답(2xx)의 pid만 정체 증거다. 연결 거절은 아무도 듣지 않는다는 뜻이다. */
async function probeOldConsoleHealth() {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(new URL("api/v1/health", config.currentEndpoint), {
        headers: { authorization: "Bearer " + config.currentLockToken },
        signal: AbortSignal.timeout(healthTimeoutMs),
      });
    } catch (error) {
      const code = error && error.cause ? error.cause.code : undefined;
      if (code === "ECONNREFUSED") return { kind: "refused" };
      if (attempt === 0 && (code === "ECONNRESET" || code === "UND_ERR_SOCKET")) continue;
      return { kind: "unanswered" };
    }
    if (!response.ok) return { kind: "unanswered" };
    const pid = await response.json().then((body) => (body && typeof body === "object" ? body.pid : undefined), () => undefined);
    return { kind: "answered", pid };
  }
}

function isLockStillHeldByOldConsole() {
  const lock = readLock();
  return !!lock && lock.pid === config.currentPid && lock.token === config.currentLockToken;
}

function detectPackageManager() {
  const configured = config.packageManager;
  try {
    const root = execFileSync(configured.bin, [...configured.prefixArgs, "root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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
    throw new Error("no supported global package manager found: " + sanitizeError(error));
  }
  throw new Error("no supported global package manager found");
}

function ensureGlobalRootWritable(manager) {
  try {
    fs.accessSync(manager.root, fs.constants.W_OK);
  } catch {
    throw new Error("global package manager root is not writable");
  }
}

async function installPackages(manager) {
  // The package's postinstall would otherwise start a Console of its own and race startNewDaemon.
  const env = { ...process.env, FLEET_CONSOLE_NO_AUTO_START: "1" };
  const code = await spawnExit(manager.bin, [...manager.prefixArgs, "i", "-g", "--force", config.tarballPath], env);
  if (code !== 0) {
    removeFileBestEffort(config.tarballPath);
    throw new Error("global package install failed with exit code " + code);
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

async function startNewDaemon() {
  const child = spawn(process.execPath, [config.serverModulePath, "serve"], {
    detached: true,
    env: daemonEnv(),
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", () => {});
  child.unref();
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    const lock = readLock();
    if (lock && lock.pid !== config.currentPid && await isNewHealthOk(lock)) return lock;
    await sleep(sleepMs);
  }
  throw new Error("new console daemon did not become healthy");
}

/**
 * 설치가 실패한 뒤의 마지막 의무: 어떤 버전이든 콘솔을 다시 세운다. 여기서는 목표 버전을
 * 요구하지 않는다 — 옛 버전으로라도 살아 있어야 실패를 읽을 화면이 생긴다.
 */
async function recoverConsoleBestEffort() {
  try {
    const child = spawn(process.execPath, [config.serverModulePath, "serve"], {
      detached: true,
      env: daemonEnv(),
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => {});
    child.unref();
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      const lock = readLock();
      if (lock && isProcessAlive(lock.pid) && await isAnyHealthOk(lock)) {
        log("recovered console after failure");
        return;
      }
      await sleep(sleepMs);
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

/** 끝난 이전 Console의 락만 지운다 — 같은 pid·token이 아니면(그 사이 올라온 새 콘솔의 락) 건드리지 않는다. */
function removeStaleLock() {
  if (!isLockStillHeldByOldConsole()) return;
  try {
    fs.rmSync(config.lockFile, { force: true });
    log("removed the stale lock of the console that exited");
  } catch {
    // 지우지 못해도 새 데몬이 stale lock을 스스로 정리한다.
  }
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(config.lockFile, "utf8"));
  } catch {
    return null;
  }
}

async function isNewHealthOk(lock) {
  if (!lock || typeof lock.endpoint !== "string" || typeof lock.token !== "string") return false;
  try {
    const response = await fetch(new URL("api/v1/health", lock.endpoint), {
      headers: { authorization: "Bearer " + lock.token },
      signal: AbortSignal.timeout(healthTimeoutMs),
    });
    if (!response.ok) return false;
    const version = await readHealthVersion(response);
    if (version === null) {
      log("new health response did not expose a version; waiting for verified target");
      return false;
    }
    return version === config.targetVersion;
  } catch {
    return false;
  }
}

async function isAnyHealthOk(lock) {
  if (!lock || typeof lock.endpoint !== "string" || typeof lock.token !== "string") return false;
  try {
    const response = await fetch(new URL("api/v1/health", lock.endpoint), {
      headers: { authorization: "Bearer " + lock.token },
      signal: AbortSignal.timeout(healthTimeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function readHealthVersion(response) {
  try {
    const payload = await response.json();
    return typeof payload.version === "string" ? payload.version : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function isNoSuchProcess(error) {
  return error && typeof error === "object" && error.code === "ESRCH";
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
    .replaceAll(config.workerPath, "[path]");
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

function spawnDetachedWorker(
  spawnWorker: ConsoleUpdateWorkerSpawner,
  execPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnWorker(execPath, args, withHidden({ detached: true, env, stdio: "ignore" as const }));
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.unref();
    queueMicrotask(() => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
}

function defaultSpawnWorker(
  execPath: string,
  args: readonly string[],
  options: { readonly detached: true; readonly env: NodeJS.ProcessEnv; readonly stdio: "ignore"; readonly windowsHide: true },
): ConsoleUpdateWorkerProcess {
  const child = spawn(execPath, [...args], options);
  child.once("error", () => {});
  return child;
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
