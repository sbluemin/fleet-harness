// fs-store 공개 배럴 — durable-I/O primitive

export type {
  AtomicWriteOptions,
  CreateDurableJsonStoreDeps,
  DirectoryIdentity,
  DirectoryLockDeps,
  DurableJsonStore,
  Sensitivity,
} from "./types.js";

export { createDurableJsonStore } from "./json-store.js";
export { isProcessAlive, withDirectoryLock } from "./directory-lock.js";
export {
  NOFOLLOW_FLAG,
  safeLstat,
  ensureSafeDirectory,
  assertWithinRoot,
  readDirectoryIdentity,
} from "./secure-fs.js";
// [MEDIUM #8] atomic-write.js에서 직접 export — json-store.js 통과 re-export 제거
export { writeAtomicSync, writeAtomicAsync } from "./atomic-write.js";
