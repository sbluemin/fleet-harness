import fs from "node:fs";

import type { GatewayLockPayload } from "./api-types.js";

export interface GatewayStaleDeps {
  readonly fs?: typeof fs;
}

export function createGatewayStalePolicy(deps: GatewayStaleDeps = {}) {
  const fsImpl = deps.fs ?? fs;

  function isBuildStale(lock: GatewayLockPayload, buildFile: string): boolean {
    try {
      return lock.startedAt < fsImpl.statSync(buildFile).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  return { isBuildStale };
}
