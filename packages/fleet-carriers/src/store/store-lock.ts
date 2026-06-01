import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isRecord } from "./sanitize.js";
import type { StoreLockOwner } from "./types.js";

const LOCK_DIRNAME = "states.json.lock";
const LOCK_OWNER_FILENAME = "owner.json";
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;

export function withStoreDirectoryLock<T>(storeDir: string | null, operation: () => T): T {
  if (!storeDir) return operation();
  fs.mkdirSync(storeDir, { recursive: true });
  const lockDir = path.join(storeDir, LOCK_DIRNAME);
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      writeLockOwner(lockDir);
      try {
        return operation();
      } finally {
        releaseStoreLock(lockDir);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      recoverStaleStoreLock(lockDir);
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for fleet store lock: ${lockDir}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function releaseStoreLock(lockDir: string): void {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // 다른 프로세스의 stale-lock 복구와 경합할 수 있으므로 해제 실패는 무시합니다.
  }
}

function recoverStaleStoreLock(lockDir: string): void {
  try {
    const owner = readLockOwner(lockDir);
    if (!owner || !isRecoverableLockOwner(owner)) return;
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

function writeLockOwner(lockDir: string): void {
  const owner: StoreLockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
  };
  const ownerPath = path.join(lockDir, LOCK_OWNER_FILENAME);
  try {
    fs.writeFileSync(ownerPath, JSON.stringify(owner), "utf-8");
  } catch (error) {
    releaseStoreLock(lockDir);
    throw error;
  }
}

function readLockOwner(lockDir: string): StoreLockOwner | null {
  const ownerPath = path.join(lockDir, LOCK_OWNER_FILENAME);
  try {
    return sanitizeLockOwner(JSON.parse(fs.readFileSync(ownerPath, "utf-8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function isRecoverableLockOwner(owner: StoreLockOwner): boolean {
  if (owner.hostname !== os.hostname()) return false;
  if (Date.now() - owner.startedAt < STALE_LOCK_MS) return false;
  return !isProcessAlive(owner.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

function sanitizeLockOwner(value: unknown): StoreLockOwner | null {
  if (!isRecord(value)) return null;
  const pid = value.pid;
  const hostname = value.hostname;
  const startedAt = value.startedAt;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
  if (typeof hostname !== "string" || !hostname) return null;
  if (!Number.isFinite(startedAt) || (startedAt as number) <= 0) return null;
  return {
    pid: pid as number,
    hostname,
    startedAt: startedAt as number,
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
