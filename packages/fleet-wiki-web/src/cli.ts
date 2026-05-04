import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openBrowser } from "./browser.js";
import { acquireLockFile, isProcessAlive, LockExistsError, lockFilePath, readLockFile, removeLockFile } from "./lock.js";
import type { FleetWikiLock } from "./lock.js";
import { resolveWorkspaceMemoryPaths } from "./paths.js";
import { isLockTrustworthyForRestart, isStaleLock } from "./stale.js";

const DEFAULT_PORT = 3737;
const HEALTH_TIMEOUT_MS = 5000;
const HEALTH_INTERVAL_MS = 150;
const HOST = "127.0.0.1";

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

  const lockPath = lockFilePath(cwd);
  const lock = await ensureServer(cwd, lockPath);
  await openBrowser(serverUrl(lock.port));
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function ensureServer(cwd: string, lockPath: string): Promise<FleetWikiLock> {
  const distMtime = getDistMtime();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await acquireLockFile(lockPath, {
        pid: process.pid,
        port: 0,
        cwd,
        startedAt: new Date().toISOString(),
      });
      spawnDetachedServer(cwd, lockPath, configuredPort());
      return waitForHealthyLock(lockPath);
    } catch (error) {
      if (!(error instanceof LockExistsError)) throw error;
      const existing = await readLockFile(lockPath);
      if (existing && isProcessAlive(existing.pid)) {
        if (existing.port > 0) {
          const health = await healthCheck(existing);
          if (health.ok) {
            if (!process.env.FLEET_WIKI_NO_AUTO_RESTART && isStaleLock(existing, distMtime)) {
              const trust = isLockTrustworthyForRestart(existing, cwd, health.cwd);
              if (!trust.trusted) {
                process.stderr.write(
                  `기존 lock의 신뢰 검증 실패(${trust.reason}) — 자동 재기동을 중단합니다. ` +
                  `FLEET_WIKI_NO_AUTO_RESTART=1로 우회하거나 lock 파일을 직접 정리하세요.\n`,
                );
              } else {
                process.stderr.write(`기존 서버(pid=${existing.pid})는 새 빌드 이전 시점이라 종료 후 재기동합니다.\n`);
                await killServer(existing.pid);
                await removeLockFile(lockPath);
                continue;
              }
            }
            return existing;
          }
        }
        return waitForHealthyLock(lockPath);
      }
      await removeLockFile(lockPath);
    }
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

async function waitForHealthyLock(lockPath: string): Promise<FleetWikiLock> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
    const lock = await readLockFile(lockPath);
    if (lock && isProcessAlive(lock.pid) && (await healthCheck(lock)).ok) {
      return lock;
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  throw new Error("Fleet Wiki 서버 헬스체크가 5초 안에 통과하지 못했습니다.");
}

async function healthCheck(lock: FleetWikiLock): Promise<{ ok: boolean; cwd: string | null }> {
  try {
    const response = await fetch(`${serverUrl(lock.port)}/api/health`);
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

function serverUrl(port: number): string {
  return `http://${HOST}:${port}`;
}

function getDistMtime(): number {
  try {
    return statSync(fileURLToPath(new URL("./server.mjs", import.meta.url))).mtimeMs;
  } catch {
    return 0;
  }
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

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
