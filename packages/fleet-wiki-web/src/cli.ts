import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openBrowser } from "./browser.js";
import { acquireLockFile, isProcessAlive, LockExistsError, lockFilePath, readLockFile, removeLockFile } from "./lock.js";
import type { FleetWikiLock } from "./lock.js";
import { resolveWorkspaceMemoryPaths } from "./paths.js";
import { isLockTrustworthyForRestart } from "./stale.js";

export type RestartMode = "restart" | "reuse" | "abort";

export interface RestartDecision {
  mode: RestartMode;
  reason?: string;
}

export type HealthyLockWaitOptions =
  | { trust: "owned" }
  | { trust: "existing"; cwd: string };

export interface HealthyLockTrustDecision {
  trusted: boolean;
  reason?: string;
}

const DEFAULT_PORT = 3737;
const DEFAULT_HOST = "127.0.0.1";
const HEALTH_TIMEOUT_MS = 5000;
const HEALTH_INTERVAL_MS = 150;

const INVALID_HOST_PATTERN = /[\x00-\x1f\x7f\s]/;

interface CliArgs {
  host?: string;
  port?: number;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const result: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        process.stderr.write("--host requires a value\n");
        process.exit(1);
        return result;
      }
      i += 1;
      if (INVALID_HOST_PATTERN.test(value) || value.length === 0) {
        process.stderr.write(`--host 값이 올바르지 않습니다: ${JSON.stringify(value)}\n`);
        process.exit(1);
        return result;
      }
      result.host = value;
    } else if (arg.startsWith("--host=")) {
      const value = arg.slice("--host=".length);
      if (INVALID_HOST_PATTERN.test(value) || value.length === 0) {
        process.stderr.write(`--host 값이 올바르지 않습니다: ${JSON.stringify(value)}\n`);
        process.exit(1);
        return result;
      }
      result.host = value;
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
): RestartDecision {
  const trust = isLockTrustworthyForRestart(existing, cwd, health.cwd, host);
  if (!trust.trusted) {
    return { mode: "abort", reason: trust.reason };
  }
  if (noAutoRestart) {
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
  const trust = isLockTrustworthyForRestart(lock, options.cwd, health.cwd, host);
  return trust.trusted ? { trusted: true } : { trusted: false, reason: trust.reason };
}

export async function main(): Promise<void> {
  const isTTY = process.stdout.isTTY;
  const yellow = isTTY ? "\x1b[33m" : "";
  const bold = isTTY ? "\x1b[1m" : "";
  const reset = isTTY ? "\x1b[0m" : "";
  console.log(
    `${bold}${yellow}⚠ Fleet Wiki는 실험적(Experimental) 기능입니다.${reset} ` +
    `지식 적재가 필요하다면 ${bold}fleet-exp${reset} 명령어로 fleet을 실행하세요. (fleet-wiki-web은 웹사이트입니다.)`,
  );

  const cwd = path.resolve(process.cwd());
  const paths = resolveWorkspaceMemoryPaths(cwd);
  if (!(await directoryExists(paths.root))) {
    console.error("`.fleet/knowledge` 디렉토리를 찾을 수 없습니다. 워크스페이스 루트에서 실행하세요.");
    process.exitCode = 1;
    return;
  }

  const cliArgs = parseCliArgs(process.argv.slice(2));
  const host = cliArgs.host ?? configuredHost();
  const port = cliArgs.port ?? configuredPort();
  const lockPath = lockFilePath(cwd);
  const lock = await ensureServer(cwd, lockPath, host, port);
  await openBrowser(serverUrl(resolveClientHost(lock.host ?? DEFAULT_HOST), lock.port));
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function ensureServer(cwd: string, lockPath: string, host: string, port: number): Promise<FleetWikiLock> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await acquireLockFile(lockPath, {
        pid: process.pid,
        port: 0,
        cwd,
        startedAt: new Date().toISOString(),
        host,
      });
      spawnDetachedServer(cwd, lockPath, port, host);
      return waitForHealthyLock(lockPath, { trust: "owned" }, host);
    } catch (error) {
      if (!(error instanceof LockExistsError)) throw error;
      const existing = await readLockFile(lockPath);
      if (existing && isProcessAlive(existing.pid)) {
        if (existing.port > 0) {
          const health = await healthCheck(existing);
          if (health.ok) {
            const decision = evaluateRestartDecision(
              existing, cwd, health,
              Boolean(process.env.FLEET_WIKI_NO_AUTO_RESTART),
              host,
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
        return waitForHealthyLock(lockPath, { trust: "existing", cwd }, host);
      }
      await removeLockFile(lockPath);
    }
  }
  throw new Error("Fleet Wiki 서버 락을 획득하지 못했습니다.");
}

function spawnDetachedServer(cwd: string, lockPath: string, port: number, host: string): void {
  const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
  const child = spawn(process.execPath, [serverPath, "--cwd", cwd, "--lock", lockPath, "--port", String(port), "--host", host], {
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
    const response = await fetch(`${serverUrl(resolveClientHost(lock.host ?? DEFAULT_HOST), lock.port)}/api/health`);
    if (response.status !== 200) return { ok: false, cwd: null };
    const body = await response.json() as { ok?: boolean; cwd?: string };
    return { ok: body.ok === true, cwd: typeof body.cwd === "string" ? body.cwd : null };
  } catch {
    return { ok: false, cwd: null };
  }
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

export function configuredHost(): string {
  const rawHost = process.env.FLEET_WIKI_HOST;
  if (!rawHost) return DEFAULT_HOST;
  if (INVALID_HOST_PATTERN.test(rawHost) || rawHost.length === 0) {
    process.stderr.write(`FLEET_WIKI_HOST 값이 올바르지 않습니다: ${JSON.stringify(rawHost)}\n`);
    process.exit(1);
  }
  return rawHost;
}

const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

export function resolveClientHost(bindHost: string): string {
  if (bindHost === "0.0.0.0") return "127.0.0.1";
  if (bindHost === "::" || bindHost === "0:0:0:0:0:0:0:0") return "::1";
  return bindHost;
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

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
