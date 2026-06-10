import type { CliType } from "@dotobokuri/core-unified-agent";

import type { TaskForceCliType } from "../dispatch/types.js";

export type CarrierAgentMode = "cli" | "subagent";

/** 캐리어별 persona 소유 기본값 — 상태 해석(resolve) 시 fallback으로 사용 */
export interface CarrierModelDefaults {
  readonly cliType: CliType;
  readonly defaultAgentMode?: CarrierAgentMode;
  readonly defaultEffort?: string;
  readonly defaultModel?: string;
}

export interface AgentCliSelection {
  model: string;
  effort?: string;
}

export type TaskForceSelection = AgentCliSelection;

export type AgentCliConfig = Partial<Record<CliType, AgentCliSelection>>;

export type TaskForceConfig = Partial<Record<TaskForceCliType, TaskForceSelection>>;

export interface CarrierState {
  agentMode?: CarrierAgentMode;
  agentCliType?: CliType;
  agentCli?: AgentCliConfig;
  taskforce?: TaskForceConfig;
  displayName?: string;
}

export interface FleetCarriers {
  _meta?: {
    generation?: number;
  };
  carriers?: Record<string, CarrierState>;
}

export interface ResolvedCarrierState {
  agentMode: CarrierAgentMode;
  agentCliType?: CliType;
  agentCli: AgentCliConfig;
  taskforce: TaskForceConfig;
  displayName?: string;
}

export interface FleetStoreSnapshot {
  generation: number;
  carriers: Record<string, ResolvedCarrierState>;
}

export interface CarrierAgentModeSnapshot {
  agentModes: Record<string, "subagent">;
  generation: number;
}

/** 로컬 프로세스가 직전에 기록한 carriers.json 지문(watcher echo 판별용, mtime+size 병합) */
export interface FleetStoreWriteFingerprint {
  generation: number;
  mtimeMs: number;
  size: number;
}
