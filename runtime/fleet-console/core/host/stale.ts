import fs from "node:fs";

import type { ConsoleLockPayload } from "./api-types.js";

export interface ConsoleStaleDeps {
  readonly fs?: typeof fs;
}

export function createConsoleStalePolicy(deps: ConsoleStaleDeps = {}) {
  const fsImpl = deps.fs ?? fs;

  function isBuildStale(lock: ConsoleLockPayload, buildFile: string): boolean {
    try {
      return lock.startedAt < fsImpl.statSync(buildFile).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  return { isBuildStale };
}
