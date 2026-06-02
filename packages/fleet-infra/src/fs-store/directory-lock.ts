import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { DirectoryLockDeps, DirectoryLockOwner } from "./types.js";

// carriers store-lock.ts의 quarantine 식별-복구를 정본으로 승격

interface LockSnapshot {
  owner: DirectoryLockOwner | null;
  mtimeMs: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_RETRY_MS = 25;
const DEFAULT_OWNER_FILE_NAME = "owner.json";

/**
 * advisory directory lock을 획득하고 operation을 실행한다.
 * quarantine 식별-복구 방식으로 stale lock을 처리한다.
 *
 * known-limitation: recovery-mutex가 없어 다중 복구자 경합 시 lockDir이
 * 잠깐 비는 창이 잔존한다. 로컬 단일 사용자 dev 도구의 저위험 영역으로 의도적 수용.
 */
export function withDirectoryLock<T>(deps: DirectoryLockDeps, operation: () => T): T {
  const ownerFileName = deps.ownerFileName ?? DEFAULT_OWNER_FILE_NAME;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = deps.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const now = deps.now ?? (() => Date.now());

  const startedAt = now();
  while (true) {
    try {
      // [LOW #9] lock dir 0o700, owner 파일은 writeLockOwner 내부에서 0o600
      fs.mkdirSync(deps.lockDir, { mode: 0o700 });
      writeLockOwner(deps.lockDir, ownerFileName, now());
      try {
        return operation();
      } finally {
        releaseLock(deps.lockDir);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      recoverStaleLock(deps.lockDir, ownerFileName, now, staleLockMs);
      if (now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for Fleet directory lock: ${deps.lockDir}`);
      }
      sleepSync(retryMs);
    }
  }
}

function releaseLock(lockDir: string): void {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // 다른 프로세스의 stale-lock 복구와 경합할 수 있으므로 해제 실패는 무시한다.
  }
}

function recoverStaleLock(
  lockDir: string,
  ownerFileName: string,
  now: () => number,
  staleLockMs: number,
): void {
  try {
    const initialSnapshot = readLockSnapshot(lockDir, ownerFileName);
    if (!isRecoverableSnapshot(initialSnapshot, now, staleLockMs)) return;

    const quarantineDir = buildQuarantinePath(lockDir);
    try {
      fs.renameSync(lockDir, quarantineDir);
    } catch {
      return;
    }
    try {
      const quarantinedSnapshot = readLockSnapshot(quarantineDir, ownerFileName);
      if (sameLockSnapshot(initialSnapshot, quarantinedSnapshot) && isRecoverableSnapshot(quarantinedSnapshot, now, staleLockMs)) {
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

function readLockSnapshot(lockDir: string, ownerFileName: string): LockSnapshot {
  // [MEDIUM #4] statSync → lstatSync: lockDir이 심볼릭링크면 stale로 간주
  const stat = fs.lstatSync(lockDir);
  if (stat.isSymbolicLink()) {
    // 심볼릭링크 lock dir은 즉시 stale 취급 (mtimeMs=0 → now()-0 >= staleLockMs 보장)
    return { owner: null, mtimeMs: 0 };
  }
  return {
    owner: readLockOwner(lockDir, ownerFileName),
    mtimeMs: stat.mtimeMs,
  };
}

function buildQuarantinePath(lockDir: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return `${lockDir}.stale.${suffix}`;
}

function writeLockOwner(lockDir: string, ownerFileName: string, startedAt: number): void {
  const owner: DirectoryLockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt,
  };
  const ownerPath = path.join(lockDir, ownerFileName);
  try {
    // [LOW #9] owner 파일 0o600
    fs.writeFileSync(ownerPath, JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
  } catch (error) {
    releaseLock(lockDir);
    throw error;
  }
}

function readLockOwner(lockDir: string, ownerFileName: string): DirectoryLockOwner | null {
  const ownerPath = path.join(lockDir, ownerFileName);
  try {
    return sanitizeLockOwner(JSON.parse(fs.readFileSync(ownerPath, "utf-8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function isRecoverableOwner(owner: DirectoryLockOwner, now: () => number, staleLockMs: number): boolean {
  if (owner.hostname !== os.hostname()) return false;
  if (now() - owner.startedAt < staleLockMs) return false;
  return !isProcessAlive(owner.pid);
}

function isRecoverableSnapshot(snapshot: LockSnapshot, now: () => number, staleLockMs: number): boolean {
  if (snapshot.owner) return isRecoverableOwner(snapshot.owner, now, staleLockMs);
  return now() - snapshot.mtimeMs >= staleLockMs;
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
    // identity 불일치 lock은 fresh일 수 있으므로 삭제하지 않는다.
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

function sanitizeLockOwner(value: unknown): DirectoryLockOwner | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pid = record.pid;
  const hostname = record.hostname;
  const startedAt = record.startedAt;
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
