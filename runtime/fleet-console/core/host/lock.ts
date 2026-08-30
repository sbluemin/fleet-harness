import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ConsoleLockPayload } from "./console-contract-types.js";
import type { ConsoleOwnerMetadata } from "./desktop-protocol.js";

export interface ConsoleLockDeps {
  readonly fs?: typeof fs;
  readonly now?: () => number;
  readonly randomToken?: () => string;
  readonly hostname?: () => string;
}

export interface ConsoleLockCreateInput {
  readonly dir: string;
  readonly lockFile: string;
  readonly pid: number;
  readonly port: number;
  readonly endpoint: string;
  readonly version: string;
  readonly owner?: ConsoleOwnerMetadata;
}

export interface ConsoleLockHandle {
  readonly payload: ConsoleLockPayload;
  release(): void;
}

export interface ConsoleLockTrustInput {
  readonly dir: string;
  readonly lockFile: string;
  readonly payload: ConsoleLockPayload;
  readonly host: string;
}

const LOCK_DIR_MODE = 0o700;
const LOCK_FILE_MODE = 0o600;

export function createConsoleLock(deps: ConsoleLockDeps = {}) {
  const fsImpl = deps.fs ?? fs;
  const now = deps.now ?? Date.now;
  const randomToken = deps.randomToken ?? (() => crypto.randomBytes(32).toString("base64url"));
  const hostname = deps.hostname ?? (() => "127.0.0.1");

  function ensureLockDir(dir: string): void {
    fsImpl.mkdirSync(dir, { recursive: true, mode: LOCK_DIR_MODE });
    fsImpl.chmodSync(dir, LOCK_DIR_MODE);
  }

  function readLock(lockFile: string): ConsoleLockPayload | null {
    try {
      const stat = fsImpl.lstatSync(lockFile);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic console lock: ${lockFile}`);
      }
      return JSON.parse(fsImpl.readFileSync(lockFile, "utf8")) as ConsoleLockPayload;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  function writeLock(input: ConsoleLockCreateInput): ConsoleLockHandle {
    ensureLockDir(input.dir);
    const payload: ConsoleLockPayload = {
      pid: input.pid,
      host: hostname(),
      port: input.port,
      endpoint: input.endpoint,
      startedAt: now(),
      token: randomToken(),
      version: input.version,
      ...(input.owner ? { owner: input.owner } : {}),
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
    let current: ConsoleLockPayload | null = null;
    try {
      current = readLock(lockFile);
    } catch (err) {
      if (pid != null) throw err;
    }
    // pid guard는 "다른 pid"뿐 아니라 "아직 lock 없음"도 삭제 금지로 취급한다.
    // read와 unlink 사이에 concurrent owner가 O_EXCL lock을 쓰는 경쟁에서 새 lock을 지우면 안 된다.
    if (pid != null && (!current || current.pid !== pid)) return;
    try {
      fsImpl.rmSync(lockFile, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  function assertLockModes(lockFile: string): void {
    // POSIX 권한 비트(0700/0600)는 POSIX 플랫폼에서만 의미가 있다. Windows는 chmod로
    // 이 모드를 강제할 수 없어 mode가 항상 0666으로 보고되므로, 같은 환경에서 uid 검사를
    // 건너뛰는 것과 동일한 기준(getuid 부재)으로 POSIX 권한 검증도 건너뛴다.
    // Windows에서는 사용자 프로필 하위 임시 디렉터리 ACL이 보호를 대신한다.
    if (typeof process.getuid !== "function") return;
    const dir = path.dirname(lockFile);
    const dirMode = fsImpl.statSync(dir).mode & 0o777;
    const fileMode = fsImpl.statSync(lockFile).mode & 0o777;
    if (dirMode !== LOCK_DIR_MODE) {
      throw new Error(`Console lock directory mode must be 0700, got ${dirMode.toString(8)}`);
    }
    if (fileMode !== LOCK_FILE_MODE) {
      throw new Error(`Console lock file mode must be 0600, got ${fileMode.toString(8)}`);
    }
  }

  function assertTrustedLock(input: ConsoleLockTrustInput): void {
    const dirStat = fsImpl.statSync(input.dir);
    const fileStat = fsImpl.lstatSync(input.lockFile);
    if (fileStat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic console lock: ${input.lockFile}`);
    }
    assertLockModes(input.lockFile);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (currentUid != null && (dirStat.uid !== currentUid || fileStat.uid !== currentUid)) {
      throw new Error("Console lock owner does not match current user");
    }
    if (input.payload.host !== input.host) {
      throw new Error(`Console lock host must match ${input.host}: ${input.payload.host}`);
    }
    // 포트는 OS가 할당하는 랜덤 포트이므로 고정값을 강제하지 않는다.
    // 대신 유효한 TCP 포트인지와 endpoint가 host:port와 내부적으로 일관되는지만 검증한다.
    if (!Number.isInteger(input.payload.port) || input.payload.port < 1 || input.payload.port > 65535) {
      throw new Error(`Console lock port must be a valid TCP port, got ${input.payload.port}`);
    }
    const endpoint = new URL(input.payload.endpoint);
    if (endpoint.protocol !== "http:" || endpoint.pathname !== "/") {
      throw new Error("Console lock endpoint must be the loopback server root");
    }
    if (endpoint.hostname !== input.host || Number(endpoint.port) !== input.payload.port) {
      throw new Error("Console lock endpoint must use the loopback host and the lock port");
    }
    if (input.payload.endpoint !== `http://${input.host}:${input.payload.port}/`) {
      throw new Error("Console lock endpoint must match the lock host and port");
    }
  }

  return { ensureLockDir, readLock, writeLock, removeLock, assertLockModes, assertTrustedLock };
}
