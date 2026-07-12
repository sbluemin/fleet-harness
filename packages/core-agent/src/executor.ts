import {
  engineExecuteOneShot,
  type AuthEnvResolver,
  type ExecuteOptions,
  type ExecResult,
  type OneShotExecution,
  type OneShotReady,
} from "./internal/executor-engine.js";

export type { AuthEnvResolver, ExecuteOptions, ExecResult, OneShotExecution, OneShotReady };

export function executeOneShot(opts: ExecuteOptions): OneShotExecution {
  return engineExecuteOneShot(opts);
}
