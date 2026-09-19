import type { MemoryPaths } from "./types.js";

export interface WikiToolExecutionContext {
  readonly cwd: string;
  readonly paths?: MemoryPaths;
}
