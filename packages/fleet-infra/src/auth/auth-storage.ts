import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { writeAtomicSync } from "../fs-store/atomic-write.js";
import { ensureSafeDirectory, NOFOLLOW_FLAG, SECURE_FILE_MODE } from "../fs-store/secure-fs.js";
import { withDirectoryLock } from "../fs-store/directory-lock.js";
import type { AuthService, AuthStorageData, CreateAuthServiceDeps } from "./types.js";

export const DEFAULT_AUTH_PATH = path.join(os.homedir(), ".fleet", "auth.json");

const AUTH_LOCK_OWNER_FILE_NAME = "owner.json";
const AUTH_LOCK_TIMEOUT_MS = 5_000;

/**
 * DI factory — authPath는 인자 기본값으로 처리되며 모듈 가변 상태 없음.
 * 쓰기 경로는 fs-store sync 원자쓰기(0600)+withDirectoryLock(auth.json.lock)+secure-fs(0700 부모).
 * 읽기 경로는 fd 기반 O_RDONLY|O_NOFOLLOW+fstatSync isFile 검증.
 */
export function createAuthService(deps: CreateAuthServiceDeps = {}): AuthService {
  const authPath = deps.authPath ?? DEFAULT_AUTH_PATH;
  const lockDir = `${authPath}.lock`;

  return {
    // [HIGH #1] TOCTOU 수정: existsSync/read/check/delete/write 전체를 락 블록 안으로 이동
    async deleteApiKey(providerId: string): Promise<boolean> {
      let deleted = false;
      withAuthLock(authPath, lockDir, () => {
        if (!fs.existsSync(authPath)) return;
        const data = readAuthDataFd(authPath);
        if (!Object.prototype.hasOwnProperty.call(data, providerId)) return;
        delete data[providerId];
        writeAuthData(authPath, data);
        deleted = true;
      });
      return deleted;
    },

    // [HIGH #2] 읽기 경로: fd 기반 O_RDONLY|O_NOFOLLOW+fstatSync isFile
    async getApiKey(providerId: string): Promise<string | undefined> {
      let fd: number | undefined;
      try {
        if (!fs.existsSync(authPath)) {
          return undefined;
        }
        fd = fs.openSync(authPath, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
        if (!fs.fstatSync(fd).isFile()) {
          return undefined;
        }
        const data = JSON.parse(fs.readFileSync(fd, "utf-8")) as AuthStorageData;
        return typeof data[providerId]?.key === "string" ? data[providerId].key : undefined;
      } catch {
        return undefined;
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* ignore */ }
        }
      }
    },

    // [HIGH #2] 읽기 경로: fd 기반 O_RDONLY|O_NOFOLLOW 통일
    async listProviderIds(): Promise<string[]> {
      if (!fs.existsSync(authPath)) {
        return [];
      }
      try {
        return Object.keys(readAuthDataFd(authPath)).sort();
      } catch {
        return [];
      }
    },

    async setApiKey(providerId: string, key: string): Promise<void> {
      const dir = path.dirname(authPath);
      ensureSafeDirectory(dir);
      withAuthLock(authPath, lockDir, () => {
        // [HIGH #2] 락 내부 read도 fd 기반으로 통일
        const data: AuthStorageData = fs.existsSync(authPath) ? readAuthDataFd(authPath) : {};
        data[providerId] = {
          ...(data[providerId] ?? {}),
          key,
        };
        writeAuthData(authPath, data);
      });
    },
  };
}

function withAuthLock<T>(authPath: string, lockDir: string, operation: () => T): T {
  return withDirectoryLock(
    {
      lockDir,
      ownerFileName: AUTH_LOCK_OWNER_FILE_NAME,
      timeoutMs: AUTH_LOCK_TIMEOUT_MS,
    },
    operation,
  );
}

function writeAuthData(authPath: string, data: AuthStorageData): void {
  writeAtomicSync(authPath, `${JSON.stringify(data, null, 2)}\n`, {
    mode: SECURE_FILE_MODE,
    fsync: true,
  });
}

/**
 * fd 기반 안전 읽기: O_RDONLY|O_NOFOLLOW + fstatSync isFile 검증.
 * 심볼릭링크·비파일이면 빈 객체 반환.
 */
function readAuthDataFd(authPath: string): AuthStorageData {
  let fd: number | undefined;
  try {
    fd = fs.openSync(authPath, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
    if (!fs.fstatSync(fd).isFile()) {
      return {};
    }
    return JSON.parse(fs.readFileSync(fd, "utf-8")) as AuthStorageData;
  } catch {
    return {};
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}
