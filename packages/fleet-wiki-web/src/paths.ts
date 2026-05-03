import path from "node:path";

import { resolveMemoryPaths as resolveFleetWikiMemoryPaths } from "@sbluemin/fleet-wiki";
import type { MemoryPaths } from "@sbluemin/fleet-wiki";

export function resolveWorkspaceMemoryPaths(cwd: string): MemoryPaths {
  return resolveFleetWikiMemoryPaths(path.resolve(cwd));
}
