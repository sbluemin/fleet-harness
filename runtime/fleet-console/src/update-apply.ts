import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createGlobalPackageUpdater } from "@dotobokuri/core-agent";
import type { GlobalPackageManagerCommand } from "@dotobokuri/core-agent";

export interface ConsoleUpdateApplyService {
  start(request: ConsoleUpdateApplyRequest): Promise<ConsoleUpdateApplyStartResult>;
}

export interface ConsoleUpdateApplyRequest {
  readonly currentPid: number;
  readonly dataDir: string;
  readonly currentEndpoint: string;
  readonly currentPackageRoot: string;
  readonly lockFile: string;
  readonly targetVersion: string;
}

export interface ConsoleUpdateApplyStartResult {
  readonly accepted: true;
}

export interface CreateConsoleUpdateApplyServiceDeps {
  readonly env?: NodeJS.ProcessEnv;
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
  readonly currentPackageRoot: string;
  readonly currentPid: number;
  readonly lockFile: string;
  readonly logFile: string;
  readonly packageManager: ConsoleUpdatePackageManagerSpec;
  readonly packageNames: readonly [string, string];
  readonly serverModulePath: string;
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

const PACKAGE_NAMES = ["@dotobokuri/fleet-cli", "@dotobokuri/fleet-console"] as const;
const WORKER_FILE_PREFIX = "fleet-console-update-";
const WORKER_FILE_SUFFIX = ".mjs";
const STATUS_FILE_SUFFIX = ".status.json";
const LOG_FILE_SUFFIX = ".log";
const TEMP_FILE_MODE = 0o600;

export function createConsoleUpdateApplyService(deps: CreateConsoleUpdateApplyServiceDeps = {}): ConsoleUpdateApplyService {
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const makeDir = deps.makeDir ?? ((dirPath, options) => {
    fs.mkdirSync(dirPath, options);
  });
  const now = deps.now ?? Date.now;
  const processPid = deps.processPid ?? process.pid;
  const preflightInstall = deps.preflightInstall ?? ((currentPackageRoot: string) => preflightPackageManager(currentPackageRoot, env));
  const serverModulePath = deps.serverModulePath ?? resolveDefaultServerModulePath();
  const spawnWorker = deps.spawnWorker ?? defaultSpawnWorker;
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  const writeFile = deps.writeFile ?? ((filePath, content, options) => {
    fs.writeFileSync(filePath, content, { mode: options.mode });
  });

  async function start(request: ConsoleUpdateApplyRequest): Promise<ConsoleUpdateApplyStartResult> {
    const packageManager = await preflightInstall(request.currentPackageRoot);
    const stamp = `${now()}-${processPid}`;
    const workerPath = path.join(tmpDir, `${WORKER_FILE_PREFIX}${stamp}${WORKER_FILE_SUFFIX}`);
    makeDir(request.dataDir, { recursive: true, mode: 0o700 });
    const statusFile = path.join(request.dataDir, `${WORKER_FILE_PREFIX}${stamp}${STATUS_FILE_SUFFIX}`);
    const logFile = path.join(request.dataDir, `${WORKER_FILE_PREFIX}${stamp}${LOG_FILE_SUFFIX}`);
    const script = emitConsoleUpdateWorkerScript({
      currentEndpoint: request.currentEndpoint,
      currentPackageRoot: request.currentPackageRoot,
      currentPid: request.currentPid,
      lockFile: request.lockFile,
      logFile,
      packageManager,
      packageNames: PACKAGE_NAMES,
      serverModulePath,
      statusFile,
      targetVersion: request.targetVersion,
      workerPath,
    });
    writeFile(workerPath, script, { mode: TEMP_FILE_MODE });
    await spawnDetachedWorker(spawnWorker, execPath, [workerPath], env);
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
const stopTimeoutMs = 60000;
const startTimeoutMs = 60000;
const sleepMs = 250;

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
  openBrowser(new URL("console/", lock.endpoint).toString());
  writeStatus("completed");
}

main()
  .catch((error) => {
    writeStatus("failed", { error: sanitizeError(error) });
    log("failed: " + sanitizeError(error));
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
  const payload = {
    phase,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  fs.writeFileSync(config.statusFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
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
  try {
    process.kill(config.currentPid, "SIGTERM");
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }
}

async function waitForOldConsoleExit() {
  const deadline = Date.now() + stopTimeoutMs;
  let escalated = false;
  while (Date.now() < deadline) {
    const pidGone = !isProcessAlive(config.currentPid);
    const lockGone = !fs.existsSync(config.lockFile);
    const healthGone = await isHealthGone(config.currentEndpoint);
    if (pidGone && lockGone && healthGone) return;
    if (!escalated && Date.now() > deadline - 10000 && isProcessAlive(config.currentPid)) {
      escalated = true;
      try {
        process.kill(config.currentPid, "SIGKILL");
      } catch (error) {
        if (!isNoSuchProcess(error)) throw error;
      }
    }
    await sleep(sleepMs);
  }
  throw new Error("old console did not stop before timeout");
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
  const packages = config.packageNames.map((name) => name + "@" + config.targetVersion);
  const code = await spawnExit(manager.bin, [...manager.prefixArgs, "i", "-g", "--force", ...packages]);
  if (code !== 0) throw new Error("global package install failed with exit code " + code);
}

async function startNewDaemon() {
  const child = spawn(process.execPath, [config.serverModulePath, "serve"], {
    detached: true,
    env: process.env,
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

function openBrowser(url) {
  const platform = os.platform();
  if (platform === "darwin") {
    spawnBrowser("open", [url]);
    return;
  }
  if (platform === "win32") {
    spawnBrowser("cmd", ["/c", "start", "", url]);
    return;
  }
  spawnBrowser("xdg-open", [url]);
}

function spawnBrowser(command, args) {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => {});
  child.unref();
}

function spawnExit(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
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
    const response = await fetch(new URL("health", lock.endpoint), {
      headers: { authorization: "Bearer " + lock.token },
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

async function readHealthVersion(response) {
  try {
    const payload = await response.json();
    return typeof payload.version === "string" ? payload.version : null;
  } catch {
    return null;
  }
}

async function isHealthGone(endpoint) {
  try {
    await fetch(new URL("health", endpoint));
    return false;
  } catch {
    return true;
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
    .replaceAll(config.workerPath, "[path]");
}
`;
}

async function preflightPackageManager(packageRoot: string, env: NodeJS.ProcessEnv): Promise<ConsoleUpdatePackageManagerSpec> {
  const updater = createGlobalPackageUpdater({
    env,
    packageNames: PACKAGE_NAMES,
    resolveCurrentPackageRoot: () => packageRoot,
    resolveCurrentVersion: () => undefined,
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
    const child = spawnWorker(execPath, args, { detached: true, env, stdio: "ignore", windowsHide: true });
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
