import crypto from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FleetWikiLock {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  token: string;
}

export class LockExistsError extends Error {
  constructor(public readonly lockPath: string) {
    super(`lock already exists: ${lockPath}`);
    this.name = "LockExistsError";
  }
}

const LOCK_PREFIX = "fleet-wiki";
const DAEMON_LOCK_FILENAME = "fleet-wiki-daemon.lock";
const LOCK_DIR_MODE = 0o700;
const LOCK_FILE_MODE = 0o600;

export function workspaceHash(cwd: string): string {
  return crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12);
}

export function lockDirectoryPath(): string {
  return path.join("/tmp", `${LOCK_PREFIX}-${userLockOwner()}`);
}

export function lockFilePath(): string {
  return daemonLockFilePath();
}

export function daemonLockFilePath(): string {
  return path.join(lockDirectoryPath(), DAEMON_LOCK_FILENAME);
}

export function createDaemonToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export async function ensureLockDirectory(): Promise<string> {
  const dirPath = lockDirectoryPath();
  await mkdir(dirPath, { recursive: true, mode: LOCK_DIR_MODE });
  await chmod(dirPath, LOCK_DIR_MODE);
  return dirPath;
}

export async function acquireLockFile(filePath: string, lock: FleetWikiLock): Promise<void> {
  await ensureLockDirectory();
  await removeSymbolicLock(filePath);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, LOCK_FILE_MODE);
    await handle.writeFile(JSON.stringify(lock, null, 2), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") throw new LockExistsError(filePath);
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readLockFile(filePath: string): Promise<FleetWikiLock | null> {
  try {
    if (await isSymbolicLock(filePath)) return null;
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as FleetWikiLock;
  } catch {
    return null;
  }
}

export async function writeLockFile(filePath: string, lock: FleetWikiLock): Promise<void> {
  await ensureLockDirectory();
  await removeSymbolicLock(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(lock, null, 2), { encoding: "utf8", mode: LOCK_FILE_MODE });
  await rename(tempPath, filePath);
  await chmod(filePath, LOCK_FILE_MODE);
}

export async function removeLockFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isSymbolicLock(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function removeSymbolicLock(filePath: string): Promise<boolean> {
  if (!(await isSymbolicLock(filePath))) return false;
  await unlink(filePath);
  return true;
}

function userLockOwner(): string {
  const info = os.userInfo();
  return String(info.uid ?? info.username).replace(/[^A-Za-z0-9._-]/g, "_");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
