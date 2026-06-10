import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GatewayLockPayload } from "./api-types.js";

export interface GatewayLockDeps {
  readonly fs?: typeof fs;
  readonly now?: () => number;
  readonly randomToken?: () => string;
  readonly hostname?: () => string;
}

export interface GatewayLockCreateInput {
  readonly dir: string;
  readonly lockFile: string;
  readonly pid: number;
  readonly port: number;
  readonly endpoint: string;
  readonly version: string;
}

export interface GatewayLockHandle {
  readonly payload: GatewayLockPayload;
  release(): void;
}

const LOCK_DIR_MODE = 0o700;
const LOCK_FILE_MODE = 0o600;

export function createGatewayLock(deps: GatewayLockDeps = {}) {
  const fsImpl = deps.fs ?? fs;
  const now = deps.now ?? Date.now;
  const randomToken = deps.randomToken ?? (() => crypto.randomBytes(32).toString("base64url"));
  const hostname = deps.hostname ?? os.hostname;

  function ensureLockDir(dir: string): void {
    fsImpl.mkdirSync(dir, { recursive: true, mode: LOCK_DIR_MODE });
    fsImpl.chmodSync(dir, LOCK_DIR_MODE);
  }

  function readLock(lockFile: string): GatewayLockPayload | null {
    try {
      const stat = fsImpl.lstatSync(lockFile);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic gateway lock: ${lockFile}`);
      }
      return JSON.parse(fsImpl.readFileSync(lockFile, "utf8")) as GatewayLockPayload;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  function writeLock(input: GatewayLockCreateInput): GatewayLockHandle {
    ensureLockDir(input.dir);
    const payload: GatewayLockPayload = {
      pid: input.pid,
      host: hostname(),
      port: input.port,
      endpoint: input.endpoint,
      startedAt: now(),
      token: randomToken(),
      version: input.version,
    };
    const fd = fsImpl.openSync(input.lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, LOCK_FILE_MODE);
    try {
      fsImpl.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fsImpl.fchmodSync(fd, LOCK_FILE_MODE);
    } finally {
      fsImpl.closeSync(fd);
    }
    return { payload, release: () => removeLock(input.lockFile, payload.pid) };
  }

  function removeLock(lockFile: string, pid?: number): void {
    const current = readLock(lockFile);
    if (pid != null && current && current.pid !== pid) return;
    try {
      fsImpl.rmSync(lockFile, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  function assertLockModes(lockFile: string): void {
    const dir = path.dirname(lockFile);
    const dirMode = fsImpl.statSync(dir).mode & 0o777;
    const fileMode = fsImpl.statSync(lockFile).mode & 0o777;
    if (dirMode !== LOCK_DIR_MODE) {
      throw new Error(`Gateway lock directory mode must be 0700, got ${dirMode.toString(8)}`);
    }
    if (fileMode !== LOCK_FILE_MODE) {
      throw new Error(`Gateway lock file mode must be 0600, got ${fileMode.toString(8)}`);
    }
  }

  return { ensureLockDir, readLock, writeLock, removeLock, assertLockModes };
}
