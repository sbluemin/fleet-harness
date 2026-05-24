import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openBrowser } from "./browser.js";
import { isProcessAlive, lockFilePath, readLockFile, removeLockFile } from "./lock.js";
import type { FleetWikiLock } from "./lock.js";
import { resolveWorkspaceMemoryPaths } from "./paths.js";
import { isLockTrustworthyForRestart, isStaleLock } from "./stale.js";

export type RestartMode = "restart" | "reuse" | "abort";
export type CliMode = "run" | "stop" | "help";

export interface RestartDecision {
  mode: RestartMode;
  reason?: string;
}

export type HealthyLockWaitOptions =
  | { trust: "owned" }
  | { trust: "existing" };

export interface HealthyLockTrustDecision {
  trusted: boolean;
  reason?: string;
}

interface CliArgs {
  mode: CliMode;
  port?: number;
}

const DEFAULT_PORT = 3737;
const DEFAULT_HOST = "127.0.0.1";
const HEALTH_TIMEOUT_MS = 5000;
const HEALTH_INTERVAL_MS = 150;
const TRAMPOLINE_ENV = "FLEET_WIKI_TRAMPOLINED";
const SIGNAL_EXIT_FALLBACK_MS = 1000;

const HELP_TEXT = [
  "Fleet Wiki 웹서버 실행/종료 도구",
  "",
  "사용법:",
  "  fleet-wiki [--port <port>]",
  "  fleet-wiki --stop",
  "  fleet-wiki --help",
  "",
  "옵션:",
  "  --port <port>   서버 포트를 지정합니다.",
  "  --stop          사용자 Fleet Wiki daemon 전체를 종료합니다.",
  "  --help          이 도움말을 출력합니다.",
  "",
  "환경변수:",
  "  FLEET_WIKI_PORT             기본 포트를 지정합니다.",
  "  FLEET_WIKI_NO_AUTO_RESTART  기존 서버 자동 재시작을 비활성화합니다.",
  "",
  "예시:",
  "  fleet-wiki",
  "  FLEET_WIKI_PORT=4040 fleet-wiki",
  "  fleet-wiki --stop",
].join("\n");

export function parseCliArgs(argv: string[]): CliArgs {
  const result: CliArgs = { mode: "run" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      result.mode = "help";
    } else if (arg === "--stop") {
      result.mode = "stop";
    } else if (arg === "--port") {
      const raw = argv[i + 1];
      if (!raw || raw.startsWith("--")) {
        process.stderr.write("--port requires a value\n");
        process.exit(1);
        return result;
      }
      i += 1;
      const port = Number(raw);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        process.stderr.write(`--port 값이 올바르지 않습니다: ${raw}\n`);
        process.exit(1);
        return result;
      }
      result.port = port;
    } else if (arg.startsWith("--port=")) {
      const raw = arg.slice("--port=".length);
      const port = Number(raw);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        process.stderr.write(`--port 값이 올바르지 않습니다: ${raw}\n`);
        process.exit(1);
        return result;
      }
      result.port = port;
    } else if (arg.startsWith("--")) {
      process.stderr.write(`알 수 없는 옵션: ${arg}\n`);
      process.exit(1);
      return result;
    }
  }
  return result;
}

export function evaluateRestartDecision(
  existing: FleetWikiLock,
  cwd: string,
  health: { ok: boolean; cwd: string | null },
  noAutoRestart: boolean,
  host?: string,
  stale = false,
): RestartDecision {
  const trust = isLockTrustworthyForRestart(existing, cwd, health.cwd, host);
  if (!trust.trusted) {
    return { mode: "abort", reason: trust.reason };
  }
  if (noAutoRestart || !stale) {
    return { mode: "reuse" };
  }
  return { mode: "restart" };
}

export function evaluateHealthyLockTrust(
  lock: FleetWikiLock,
  health: { ok: boolean; cwd: string | null },
  options: HealthyLockWaitOptions,
  host?: string,
): HealthyLockTrustDecision {
  if (!health.ok) {
    return { trusted: false, reason: "health check failed" };
  }
  if (options.trust === "owned") {
    return { trusted: true };
  }
  const trust = isLockTrustworthyForRestart(lock, "", health.cwd, host);
  return trust.trusted ? { trusted: true } : { trusted: false, reason: trust.reason };
}

export async function main(): Promise<void> {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  if (cliArgs.mode === "help") {
    printHelp();
    return;
  }

  const cwd = path.resolve(process.cwd());
  if (cliArgs.mode === "stop") {
    await stopDaemon();
    return;
  }

  const paths = resolveWorkspaceMemoryPaths(cwd);
  if (!(await directoryExists(paths.root))) {
    console.error("`.fleet/knowledge` 디렉토리를 찾을 수 없습니다. 워크스페이스 루트에서 실행하세요.");
    process.exitCode = 1;
    return;
  }

  const host = DEFAULT_HOST;
  const port = cliArgs.port ?? configuredPort();
  const lockPath = lockFilePath();
  const lock = await ensureServer(cwd, lockPath, host, port);
  const workspace = await registerWorkspace(lock, cwd);
  await openBrowser(`${serverUrl(lock.host, lock.port)}${workspace.urlPath}`);
}

export function findLocalCliMjs(cwd: string): string | null {
  let currentDir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(currentDir, "packages", "fleet-wiki-ui", "dist", "cli.mjs");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

function printHelp(): void {
  process.stdout.write(`${HELP_TEXT}\n`);
}

async function stopDaemon(): Promise<void> {
  const lockPath = lockFilePath();
  const lock = await readLockFile(lockPath);
  if (!lock) {
    process.stderr.write("실행 중인 Fleet Wiki daemon lock을 찾지 못했습니다.\n");
    return;
  }
  if (!Number.isInteger(lock.pid) || lock.pid <= 1) {
    process.stderr.write(
      `lock에 비정상 PID가 기록되어 있습니다(pid=${String(lock.pid)}). 안전을 위해 종료를 건너뜁니다.\n`,
    );
    process.exit(1);
    return;
  }
  if (!isProcessAlive(lock.pid)) {
    await removeLockFile(lockPath);
    process.stderr.write(`Fleet Wiki daemon(pid=${lock.pid})은 이미 종료되어 있습니다.\n`);
    return;
  }
  await killServer(lock.pid);
  if (isProcessAlive(lock.pid)) {
    throw new Error(`Fleet Wiki daemon(pid=${lock.pid})을 종료하지 못했습니다.`);
  }
  await removeLockFile(lockPath);
}

async function ensureServer(cwd: string, lockPath: string, host: string, port: number): Promise<FleetWikiLock> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await readLockFile(lockPath);
    if (existing && isProcessAlive(existing.pid)) {
      if (existing.port > 0) {
        const health = await healthCheck(existing);
        if (health.ok) {
          const decision = evaluateRestartDecision(
            existing, cwd, health,
            Boolean(process.env.FLEET_WIKI_NO_AUTO_RESTART),
            host,
            await isExistingDaemonStale(existing),
          );
          if (decision.mode === "reuse") {
            return existing;
          }
          if (decision.mode === "abort") {
            throw new Error(
              `기존 lock의 신뢰 검증 실패(${decision.reason}) — 재기동할 수 없습니다. ` +
              `lock 파일을 수동으로 삭제한 후 다시 실행하세요.`,
            );
          }
          process.stderr.write(`기존 서버(pid=${existing.pid})를 종료 후 재기동합니다.\n`);
          await killServer(existing.pid);
          await removeLockFile(lockPath);
          continue;
        }
      }
      return waitForHealthyLock(lockPath, { trust: "existing" }, host);
    }
    if (existing) {
      await removeLockFile(lockPath);
    }
    spawnDetachedServer(cwd, lockPath, port);
    return waitForHealthyLock(lockPath, { trust: "existing" }, host);
  }
  throw new Error("Fleet Wiki 서버 락을 획득하지 못했습니다.");
}

function spawnDetachedServer(cwd: string, lockPath: string, port: number): void {
  const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
  const child = spawn(process.execPath, [serverPath, "--cwd", cwd, "--lock", lockPath, "--port", String(port)], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
}

async function waitForHealthyLock(lockPath: string, options: HealthyLockWaitOptions, host?: string): Promise<FleetWikiLock> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
    const lock = await readLockFile(lockPath);
    if (lock && isProcessAlive(lock.pid)) {
      const health = await healthCheck(lock);
      if (health.ok) {
        const trust = evaluateHealthyLockTrust(lock, health, options, host);
        if (!trust.trusted) {
          throw new Error(
            `기존 lock의 신뢰 검증 실패(${trust.reason}) — 재사용할 수 없습니다. ` +
            `lock 파일을 수동으로 삭제한 후 다시 실행하세요.`,
          );
        }
        return lock;
      }
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  throw new Error("Fleet Wiki 서버 헬스체크가 5초 안에 통과하지 못했습니다.");
}

async function healthCheck(lock: FleetWikiLock): Promise<{ ok: boolean; cwd: string | null }> {
  try {
    const response = await fetch(`${serverUrl(lock.host, lock.port)}/api/health`);
    if (response.status !== 200) return { ok: false, cwd: null };
    const body = await response.json() as { ok?: boolean; cwd?: string };
    return { ok: body.ok === true, cwd: typeof body.cwd === "string" ? body.cwd : null };
  } catch {
    return { ok: false, cwd: null };
  }
}

async function isExistingDaemonStale(lock: FleetWikiLock): Promise<boolean> {
  try {
    const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
    const serverStat = await stat(serverPath);
    return isStaleLock(lock, serverStat.mtimeMs);
  } catch {
    return false;
  }
}

async function registerWorkspace(lock: FleetWikiLock, cwd: string): Promise<{ id: string; urlPath: string }> {
  const response = await fetch(`${serverUrl(lock.host, lock.port)}/api/admin/workspaces`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${lock.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cwd }),
  });
  if (!response.ok) {
    throw new Error(`Fleet Wiki workspace 등록 실패: HTTP ${response.status}`);
  }
  const body = await response.json() as { workspace?: { id?: string; urlPath?: string } };
  if (!body.workspace?.id || !body.workspace.urlPath) {
    throw new Error("Fleet Wiki workspace 등록 응답이 올바르지 않습니다.");
  }
  return { id: body.workspace.id, urlPath: body.workspace.urlPath };
}

function configuredPort(): number {
  const rawPort = process.env.FLEET_WIKI_PORT;
  if (!rawPort) return DEFAULT_PORT;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`FLEET_WIKI_PORT 값이 올바르지 않습니다: ${rawPort}`);
  }
  return port;
}

export function formatHostForUrl(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}

export function serverUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}`;
}

async function killServer(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  await sleep(200);
  if (isProcessAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* 이미 종료됨 */ }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeTrampolineToLocalCli(): void {
  if (process.env[TRAMPOLINE_ENV] === "1") return;
  const localCli = findLocalCliMjs(process.cwd());
  if (!localCli) return;

  const currentCli = fileURLToPath(import.meta.url);
  if (path.resolve(localCli) === path.resolve(currentCli)) return;
  if (!isSameGitCommonDir(localCli, currentCli)) return;

  const cyan = process.stderr.isTTY ? "\x1b[36m" : "";
  const reset = process.stderr.isTTY ? "\x1b[0m" : "";
  process.stderr.write(`${cyan}fleet-wiki: redirecting to ${localCli}${reset}\n`);

  const result = spawnSync(process.execPath, [localCli, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [TRAMPOLINE_ENV]: "1" },
  });
  if (result.error) {
    process.stderr.write(`fleet-wiki: trampoline failed: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    setTimeout(() => process.exit(1), SIGNAL_EXIT_FALLBACK_MS);
    return;
  }
  process.exit(result.status ?? 1);
}

function isSameGitCommonDir(candidateCli: string, currentCli: string): boolean {
  const candidateCommonDir = gitCommonDir(path.dirname(candidateCli));
  const currentCommonDir = gitCommonDir(path.dirname(currentCli));
  return candidateCommonDir !== null && currentCommonDir !== null && candidateCommonDir === currentCommonDir;
}

function gitCommonDir(cwd: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  const rawCommonDir = result.stdout.trim();
  if (!rawCommonDir) {
    return null;
  }
  return path.resolve(cwd, rawCommonDir);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  maybeTrampolineToLocalCli();
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
