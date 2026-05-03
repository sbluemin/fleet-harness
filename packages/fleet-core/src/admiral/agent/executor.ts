/**
 * admiral/agent/executor — carrier executor 공개 facade.
 *
 * 풀 기반 executeWithPool과 일회성 executeOneShot을 export.
 * 내부 구현은 internal/executor-engine.ts에 위임.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import {
  engineExecuteWithPool,
  engineExecuteOneShot,
  type CarrierExecuteOptions,
  type CarrierExecResult,
} from "./internal/executor-engine.js";

export type { CarrierExecuteOptions, CarrierExecResult };

export async function executeWithPool(opts: CarrierExecuteOptions): Promise<CarrierExecResult> {
  return engineExecuteWithPool(opts);
}

export async function executeOneShot(opts: CarrierExecuteOptions): Promise<CarrierExecResult> {
  return engineExecuteOneShot(opts);
}
