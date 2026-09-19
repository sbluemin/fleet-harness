import * as fs from "node:fs";
import * as path from "node:path";

import type { DirectoryIdentity } from "./types.js";

// 파일 권한 상수
const SECURE_DIR_MODE = 0o700;
export const SECURE_FILE_MODE = 0o600;
// [LOW #11] O_NOFOLLOW: POSIX(darwin/linux)에서만 유효. Windows는 이 상수가 없어 0으로 폴백.
// 이 코드의 대상 플랫폼은 darwin/posix이며 Windows symlink 방어는 보장되지 않는다.
export const NOFOLLOW_FLAG: number = fs.constants.O_NOFOLLOW ?? 0;

/**
 * lstatSync wrapper — ENOENT는 null 반환, 그 외 에러는 throw
 */
export function safeLstat(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * dirPath가 안전한 디렉터리(심볼릭링크 아님, 0o700)임을 보장한다.
 * 존재하지 않으면 생성, 심볼릭링크/비디렉터리면 throw.
 */
export function ensureSafeDirectory(dirPath: string): void {
  const stat = safeLstat(dirPath);
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe Fleet directory: ${dirPath}`);
    }
    fs.chmodSync(dirPath, SECURE_DIR_MODE);
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true, mode: SECURE_DIR_MODE });
  const created = safeLstat(dirPath);
  if (!created?.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`Unsafe Fleet directory: ${dirPath}`);
  }
  fs.chmodSync(dirPath, SECURE_DIR_MODE);
}

/**
 * candidatePath가 root 하위에 있는지 검증한다 (traversal 가드).
 * root 외부라면 throw.
 */
export function assertWithinRoot(root: string, candidatePath: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidatePath);
  if (!resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`) && resolvedCandidate !== resolvedRoot) {
    throw new Error(`Path escapes root: ${candidatePath}`);
  }
}

/**
 * 디렉터리의 dev/ino identity를 읽는다. 없거나 심볼릭링크면 null 반환.
 */
export function readDirectoryIdentity(dirPath: string): DirectoryIdentity | null {
  try {
    const stats = fs.lstatSync(dirPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return null;
    }
    return { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
