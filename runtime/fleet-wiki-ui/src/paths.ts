import path from "node:path";

import { resolveMemoryPaths as resolveFleetWikiMemoryPaths } from "@dotobokuri/fleet-wiki";
import type { MemoryPaths } from "@dotobokuri/fleet-wiki";

export function resolveWorkspaceMemoryPaths(cwd: string): MemoryPaths {
  return resolveFleetWikiMemoryPaths(path.resolve(cwd));
}
