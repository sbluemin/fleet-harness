/**
 * admiral/agent/executor — carrier-agnostic executor 공개 facade.
 *
 * 풀 기반 executeWithPool과 일회성 executeOneShot을 export.
 * 내부 구현은 internal/executor-engine.ts에 위임.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import {
  engineExecuteWithPool,
  engineExecuteOneShot,
  type ExecuteOptions,
  type ExecResult,
} from "./internal/executor-engine.js";

export type { ExecuteOptions, ExecResult };

export async function executeWithPool(opts: ExecuteOptions): Promise<ExecResult> {
  return engineExecuteWithPool(opts);
}

export async function executeOneShot(opts: ExecuteOptions): Promise<ExecResult> {
  return engineExecuteOneShot(opts);
}
