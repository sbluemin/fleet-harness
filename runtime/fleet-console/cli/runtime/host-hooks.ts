import { mkdirSync } from "node:fs";
import path from "node:path";

import { withDirectoryLock } from "@dotobokuri/core-infra";

const PLUGIN_STORE_LOCK_DIR_SUFFIX = ".lock";

export function withFleetPluginStoreLock<T>(target: string, fn: () => T): T {
  const lockDir = `${target}${PLUGIN_STORE_LOCK_DIR_SUFFIX}`;
  mkdirSync(path.dirname(lockDir), { recursive: true });
  return withDirectoryLock({ lockDir }, fn);
}
