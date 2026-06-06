import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AtomicWriteOptions } from "./types.js";
import { SECURE_FILE_MODE } from "./secure-fs.js";

const DEFAULT_MAX_ATTEMPTS = 10;
const IGNORED_FSYNC_ERROR_CODES = new Set(["EPERM", "EINVAL", "ENOSYS"]);

function isIgnoredFsyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && IGNORED_FSYNC_ERROR_CODES.has(code);
}

function fsyncSyncBestEffort(fd: number): void {
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    if (!isIgnoredFsyncError(error)) {
      throw error;
    }
  }
}

async function fsyncAsyncBestEffort(fd: fs.promises.FileHandle): Promise<void> {
  try {
    await fd.sync();
  } catch (error) {
    if (!isIgnoredFsyncError(error)) {
      throw error;
    }
  }
}

/**
 * temp 파일 경로 생성기
 */
export function buildTempPath(filePath: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.${os.hostname()}`;
  return `${filePath}.${suffix}.tmp`;
}

/**
 * sync 원자쓰기: O_EXCL+mode+fsyncSync+renameSync+실패 시 temp unlink.
 * preset `writePresetFile` 알고리즘 정본화.
 */
export function writeAtomicSync(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): void {
  const mode = options.mode ?? SECURE_FILE_MODE;
  const doFsync = options.fsync !== false;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let lastExistsError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tempPath = buildTempPath(filePath);
    let tempCreated = false;
    try {
      // path 기반 writeFileSync + flag:"wx" 사용: O_EXCL 의미 동일하며 mock-hook에도 노출됨
      fs.writeFileSync(tempPath, content, { encoding: "utf-8", flag: "wx", mode });
      tempCreated = true;
      if (doFsync) {
        const fd = fs.openSync(tempPath, "r");
        try {
          fsyncSyncBestEffort(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!tempCreated && code === "EEXIST") {
        lastExistsError = error;
        continue;
      }
      if (tempCreated) {
        try { fs.unlinkSync(tempPath); } catch { /* temp 파일 정리 실패는 원래 오류를 유지한다. */ }
      }
      throw error;
    }
  }
  throw lastExistsError ?? new Error(`Failed to create temp file after ${maxAttempts} attempts: ${filePath}`);
}

/**
 * async 원자쓰기: temp+rename, 선택 fsync.
 * wiki `writeAtomic` 알고리즘(동기 표면 없는 async 경로용).
 */
export async function writeAtomicAsync(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = options.mode ?? SECURE_FILE_MODE;
  const doFsync = options.fsync !== false;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let lastExistsError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tempPath = buildTempPath(filePath);
    let tempCreated = false;
    try {
      await fs.promises.writeFile(tempPath, content, { encoding: "utf-8", flag: "wx", mode });
      tempCreated = true;
      if (doFsync) {
        const fd = await fs.promises.open(tempPath, "r");
        try {
          await fsyncAsyncBestEffort(fd);
        } finally {
          await fd.close();
        }
      }
      await fs.promises.rename(tempPath, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!tempCreated && code === "EEXIST") {
        lastExistsError = error;
        continue;
      }
      if (tempCreated) {
        try { await fs.promises.unlink(tempPath); } catch { /* temp 파일 정리 실패는 원래 오류를 유지한다. */ }
      }
      throw error;
    }
  }
  throw lastExistsError ?? new Error(`Failed to create temp file after ${maxAttempts} attempts: ${filePath}`);
}

/**
 * dir 내의 특정 prefix를 가진 고아 temp 파일들을 제거한다.
 * 단, minAgeMs보다 새로운 파일은 건드리지 않는다.
 */
export function cleanupTempFiles(
  dir: string,
  prefix: string,
  minAgeMs: number,
  now: number,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const tempPath = path.join(dir, entry);
    try {
      const stat = fs.lstatSync(tempPath);
      if (stat?.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs >= minAgeMs) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // 이미 삭제됐거나 권한 없음은 무시한다.
    }
  }
}
