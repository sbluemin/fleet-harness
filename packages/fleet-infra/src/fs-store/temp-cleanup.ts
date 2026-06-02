import { cleanupTempFiles } from "./atomic-write.js";

export const DEFAULT_TEMP_FILE_MIN_AGE_MS = 60_000;

/**
 * preset `cleanupPresetTempFiles`를 일반화한 함수.
 * dir 내의 prefix를 가진 고아 temp 파일들을 정리한다.
 */
export function cleanupOrphanTempFiles(
  dir: string,
  prefix: string,
  now: number,
  minAgeMs: number = DEFAULT_TEMP_FILE_MIN_AGE_MS,
): void {
  cleanupTempFiles(dir, prefix, minAgeMs, now);
}
