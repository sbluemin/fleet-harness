import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LEGACY_PI_DATA_DIR_NAME = ".pi";
const LEGACY_FLEET_DATA_DIR_NAME = "fleet";
const MIGRATION_LOCK_DIRNAME = ".fleet.migration.lock";
const MIGRATION_LOCK_OWNER_FILENAME = "owner.json";
const MIGRATION_LOCK_RETRY_MS = 25;
const MIGRATION_LOCK_TIMEOUT_MS = 5000;
const MIGRATION_STALE_LOCK_MS = 30000;
const MIGRATION_LOCK_UNAVAILABLE = "FLEET_MIGRATION_LOCK_UNAVAILABLE";
const NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK_FLAG = fs.constants.O_NONBLOCK ?? 0;
const SECURE_DIR_MODE = 0o700;

export function migrateLegacyFleetDataDir(dataDir: string): void {
  try {
    const legacyDataDir = path.join(os.homedir(), LEGACY_PI_DATA_DIR_NAME, LEGACY_FLEET_DATA_DIR_NAME);
    if (!isSafeDirectory(legacyDataDir)) return;

    withMigrationLock(() => {
      if (!isSafeDirectory(legacyDataDir)) return;
      if (isSymlink(dataDir)) return;

      if (!pathExists(dataDir)) {
        fs.renameSync(legacyDataDir, dataDir);
        fs.chmodSync(dataDir, SECURE_DIR_MODE);
        return;
      }

      if (!isSafeDirectory(dataDir)) return;
      fs.chmodSync(dataDir, SECURE_DIR_MODE);
      moveLegacyChildren(legacyDataDir, dataDir);
    });
  } catch (error) {
    if (isMigrationLockUnavailable(error)) throw error;
    // 마이그레이션 실패는 Fleet 구동을 막지 않는다
  }
}

function moveLegacyChildren(legacyDir: string, dataDir: string): void {
  try {
    for (const entry of fs.readdirSync(legacyDir)) {
      const legacyPath = path.join(legacyDir, entry);
      const dataPath = path.join(dataDir, entry);
      moveLegacyEntry(legacyPath, dataPath);
    }

    if (fs.readdirSync(legacyDir).length === 0) {
      fs.rmdirSync(legacyDir);
    }
  } catch {
    // 충돌 또는 권한 문제는 런타임 초기화를 방해하지 않는다
  }
}

function moveLegacyEntry(legacyPath: string, dataPath: string): void {
  try {
    const legacyStat = safeLstat(legacyPath);
    if (!legacyStat || legacyStat.isSymbolicLink()) return;

    const dataStat = safeLstat(dataPath);
    if (!dataStat) {
      fs.renameSync(legacyPath, dataPath);
      return;
    }
    if (dataStat.isSymbolicLink()) return;

    // 디렉토리-디렉토리만 재귀 이동; 그 외 모든 충돌은 backup
    if (legacyStat.isDirectory() && dataStat.isDirectory()) {
      moveLegacyChildren(legacyPath, dataPath);
      return;
    }

    backupLegacyEntry(legacyPath, dataPath);
  } catch {
    // 항목별 이동 실패는 나머지 마이그레이션을 계속 진행한다
  }
}

function backupLegacyEntry(legacyPath: string, dataPath: string): void {
  try {
    const backupPath = nextBackupPath(dataPath);
    fs.renameSync(legacyPath, backupPath);
  } catch {
    // 백업 실패는 마이그레이션 전체를 중단하지 않는다
  }
}

function nextBackupPath(dataPath: string): string {
  const timestamp = new Date().toISOString().replace(/[^0-9A-Za-z]/g, "");
  for (let index = 0; index < 1000; index++) {
    const suffix = index === 0 ? "" : `-${index}`;
    const backupPath = `${dataPath}.legacy-backup-${timestamp}${suffix}`;
    if (!pathExists(backupPath)) return backupPath;
  }
  return `${dataPath}.legacy-backup-${timestamp}-${process.pid}`;
}

function withMigrationLock<T>(operation: () => T): T | undefined {
  const lockDir = path.join(os.homedir(), MIGRATION_LOCK_DIRNAME);
  const startedAt = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      writeMigrationLockOwner(lockDir);
      try {
        return operation();
      } finally {
        releaseMigrationLock(lockDir);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (isSymlink(lockDir)) throw migrationLockUnavailable(`Unsafe Fleet migration lock path: ${lockDir}`);
      recoverStaleMigrationLock(lockDir);
      if (Date.now() - startedAt >= MIGRATION_LOCK_TIMEOUT_MS) {
        throw migrationLockUnavailable(`Timed out waiting for Fleet migration lock: ${lockDir}`);
      }
      sleepSync(MIGRATION_LOCK_RETRY_MS);
    }
  }
}

function releaseMigrationLock(lockDir: string): void {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // 다른 프로세스와 경합할 수 있으므로 lock 해제 실패는 무시한다
  }
}

function recoverStaleMigrationLock(lockDir: string): void {
  try {
    if (!isSafeDirectory(lockDir)) return;
    const owner = readMigrationLockOwner(lockDir);
    if (!owner || owner.hostname !== os.hostname()) return;
    if (Date.now() - owner.startedAt < MIGRATION_STALE_LOCK_MS) return;
    if (isProcessAlive(owner.pid)) return;
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

function writeMigrationLockOwner(lockDir: string): void {
  const owner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
  };
  const ownerPath = path.join(lockDir, MIGRATION_LOCK_OWNER_FILENAME);
  try {
    const flags =
      fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      NOFOLLOW_FLAG |
      NONBLOCK_FLAG;
    const fd = fs.openSync(ownerPath, flags, 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) throw migrationLockUnavailable(`Unsafe Fleet migration lock owner: ${ownerPath}`);
      fs.writeSync(fd, JSON.stringify(owner), undefined, "utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    releaseMigrationLock(lockDir);
    throw error;
  }
}

function readMigrationLockOwner(lockDir: string): { pid: number; hostname: string; startedAt: number } | null {
  const ownerPath = path.join(lockDir, MIGRATION_LOCK_OWNER_FILENAME);
  try {
    const stat = safeLstat(ownerPath);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG);
    let raw = "";
    try {
      if (!fs.fstatSync(fd).isFile()) return null;
      raw = fs.readFileSync(fd, "utf-8");
    } finally {
      fs.closeSync(fd);
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    if (typeof parsed.pid !== "number") return null;
    if (typeof parsed.hostname !== "string") return null;
    if (typeof parsed.startedAt !== "number") return null;
    return { pid: parsed.pid, hostname: parsed.hostname, startedAt: parsed.startedAt };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function migrationLockUnavailable(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = MIGRATION_LOCK_UNAVAILABLE;
  return error;
}

function isMigrationLockUnavailable(error: unknown): boolean {
  return (error as { code?: unknown })?.code === MIGRATION_LOCK_UNAVAILABLE;
}

function isSafeDirectory(dirPath: string): boolean {
  const stat = safeLstat(dirPath);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

function isSymlink(targetPath: string): boolean {
  return Boolean(safeLstat(targetPath)?.isSymbolicLink());
}

function pathExists(targetPath: string): boolean {
  return safeLstat(targetPath) !== null;
}

function safeLstat(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
