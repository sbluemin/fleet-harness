import type { MemoryPaths } from "./types.js";

/** 도구가 닿는 지식 root는 호출자가 사령관 id로 해석해 넘긴다. 경로가 없으면 도구도 없다. */
export interface WikiToolExecutionContext {
  readonly paths: MemoryPaths;
}
