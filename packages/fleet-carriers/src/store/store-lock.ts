import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isRecord } from "./sanitize.js";
import type { StoreLockOwner } from "./types.js";

interface LockSnapshot {
  owner: StoreLockOwner | null;
  mtimeMs: number;
}

const LOCK_DIRNAME = "carriers.json.lock";
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
    const initialSnapshot = readLockSnapshot(lockDir);
    if (!isRecoverableLockSnapshot(initialSnapshot)) return;
    // known-limitation: identity-check(S0/S1)는 잘못된 lock 삭제를 차단하지만,
    // recovery-mutex가 없어 다중 복구자 경합 시 lockDir이 잠깐 비는 창이 잔존한다.
    // 로컬 단일 사용자 dev 도구의 저위험 영역으로 의도적 수용(사용자 승인)한다.
    const quarantineDir = buildQuarantinePath(lockDir);
    try {
      fs.renameSync(lockDir, quarantineDir);
    } catch {
      return;
    }
    try {
      const quarantinedSnapshot = readLockSnapshot(quarantineDir);
      if (sameLockSnapshot(initialSnapshot, quarantinedSnapshot) && isRecoverableLockSnapshot(quarantinedSnapshot)) {
        fs.rmSync(quarantineDir, { recursive: true, force: true });
      } else {
        restoreQuarantinedLock(quarantineDir, lockDir);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

function readLockSnapshot(lockDir: string): LockSnapshot {
  const stat = fs.statSync(lockDir);
  return {
    owner: readLockOwner(lockDir),
    mtimeMs: stat.mtimeMs,
  };
}

function buildQuarantinePath(lockDir: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return `${lockDir}.stale.${suffix}`;
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

function isRecoverableLockSnapshot(snapshot: LockSnapshot): boolean {
  if (snapshot.owner) return isRecoverableLockOwner(snapshot.owner);
  return Date.now() - snapshot.mtimeMs >= STALE_LOCK_MS;
}

function sameLockSnapshot(a: LockSnapshot, b: LockSnapshot): boolean {
  if (!a.owner || !b.owner) return !a.owner && !b.owner && a.mtimeMs === b.mtimeMs;
  return a.owner.pid === b.owner.pid
    && a.owner.hostname === b.owner.hostname
    && a.owner.startedAt === b.owner.startedAt;
}

function restoreQuarantinedLock(quarantineDir: string, lockDir: string): void {
  try {
    fs.renameSync(quarantineDir, lockDir);
  } catch {
    // identity 불일치 lock은 fresh일 수 있으므로 삭제하지 않습니다.
  }
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
