import * as fs from "node:fs";
import * as path from "node:path";

import type { CreateDurableJsonStoreDeps, DurableJsonStore } from "./types.js";
import { cleanupTempFiles, writeAtomicSync } from "./atomic-write.js";
import { withDirectoryLock } from "./directory-lock.js";
import { ensureSafeDirectory, NOFOLLOW_FLAG, SECURE_FILE_MODE } from "./secure-fs.js";

/** temp 파일 최소 수명 기본값 — 이보다 새로운 temp 파일은 정리하지 않는다 */
const DEFAULT_TEMP_FILE_MIN_AGE_MS = 60_000;

/**
 * durable JSON 저장소 factory.
 * preset의 read-lock-mutate-write 패턴을 일반화한다.
 * sanitize/serialize는 deps 주입, 도메인 로직은 소비처에 잔류.
 */
export function createDurableJsonStore<T>(deps: CreateDurableJsonStoreDeps<T>): DurableJsonStore<T> {
  const now = deps.now ?? (() => Date.now());
  // [MEDIUM #5] sensitivity 필수 인자 — 기본값 제거
  const sensitivity = deps.sensitivity;
  const mode = sensitivity === "sensitive" ? SECURE_FILE_MODE : 0o644;
  const minAgeMs = deps.tempCleanupMinAgeMs ?? DEFAULT_TEMP_FILE_MIN_AGE_MS;
  const dir = path.dirname(deps.filePath);

  return {
    path: deps.filePath,

    load(): T {
      return readJsonFile(deps.filePath, deps.sanitize);
    },

    save(data: T): void {
      withLock(() => {
        // [MEDIUM #8] writeAtomicSync 직접 위임 — EEXIST 재시도 일관성
        writeAtomicSync(deps.filePath, `${JSON.stringify(data, null, 2)}\n`, { mode });
      });
    },

    update(mutate: (current: T) => T | undefined): T {
      let result: T | undefined;
      withLock(() => {
        const current = readJsonFile(deps.filePath, deps.sanitize);
        const next = mutate(current);
        // undefined는 "쓸 것이 없다"는 판정이다. 파일이 없던 경우 빈 문서를 새로 만들지 않는다.
        if (next === undefined) {
          result = current;
          return;
        }
        writeAtomicSync(deps.filePath, `${JSON.stringify(next, null, 2)}\n`, { mode });
        result = next;
      });
      return result!;
    },
  };

  function withLock<R>(operation: () => R): R {
    if (!deps.lockDir) {
      ensureSafeDirectoryIfSensitive(dir, sensitivity);
      return operation();
    }
    ensureSafeDirectoryIfSensitive(dir, sensitivity);
    return withDirectoryLock(
      {
        lockDir: deps.lockDir,
        ownerFileName: deps.lockOwnerFileName,
        timeoutMs: deps.timeoutMs,
        staleLockMs: deps.staleLockMs,
        now,
      },
      () => {
        if (deps.tempCleanupPrefix) {
          cleanupTempFiles(dir, deps.tempCleanupPrefix, minAgeMs, now());
        }
        return operation();
      },
    );
  }
}

function readJsonFile<T>(filePath: string, sanitize: (value: unknown) => T): T {
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      return sanitize(undefined);
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
    if (!fs.fstatSync(fd).isFile()) {
      return sanitize(undefined);
    }
    return sanitize(JSON.parse(fs.readFileSync(fd, "utf-8")));
  } catch {
    return sanitize(undefined);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function ensureSafeDirectoryIfSensitive(dir: string, sensitivity: string): void {
  if (sensitivity === "sensitive") {
    ensureSafeDirectory(dir);
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
}
