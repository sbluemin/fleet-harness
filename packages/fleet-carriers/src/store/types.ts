import type { CliType } from "@dotobokuri/fleet-unified-agent";

import type { TaskForceCliType } from "../dispatch/types.js";

export type CarrierAgentMode = "cli" | "subagent";

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

export interface StoreLockOwner {
  pid: number;
  hostname: string;
  startedAt: number;
}

/** 로컬 프로세스가 직전에 기록한 carriers.json 지문(watcher echo 판별용, mtime+size 병합) */
export interface FleetStoreWriteFingerprint {
  generation: number;
  mtimeMs: number;
  size: number;
}
