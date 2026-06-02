// fs-store 공개 배럴 — durable-I/O primitive

export type {
  AtomicWriteOptions,
  CreateDurableJsonStoreDeps,
  DirectoryLock,
  DirectoryLockDeps,
  DirectoryLockOwner,
  DurableJsonStore,
  SecureFsOptions,
  Sensitivity,
} from "./types.js";

export { createDurableJsonStore } from "./json-store.js";
export { withDirectoryLock } from "./directory-lock.js";
export {
  SECURE_DIR_MODE,
  SECURE_FILE_MODE,
  NOFOLLOW_FLAG,
  safeLstat,
  ensureSafeDirectory,
  assertWithinRoot,
  readDirectoryIdentity,
  assertDirectoryIdentity,
  type DirectoryIdentity,
} from "./secure-fs.js";
export { cleanupOrphanTempFiles, DEFAULT_TEMP_FILE_MIN_AGE_MS } from "./temp-cleanup.js";
// [MEDIUM #8] atomic-write.js에서 직접 export — json-store.js 통과 re-export 제거
export { writeAtomicSync, writeAtomicAsync, buildTempPath, cleanupTempFiles } from "./atomic-write.js";
