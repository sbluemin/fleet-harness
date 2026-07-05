import type { AgentCliId } from "@dotobokuri/fleet-admiral";
import type { GlobalOptionsData, GlobalOptionsService } from "@dotobokuri/core-infra/global-options";

import type { FleetCliOptions } from "../../cli-args.js";

export type SessionOptionSource = "arg" | "env" | "global-options" | "default" | "session";

export interface SessionOptions {
  readonly cliId: AgentCliId;
  readonly model?: string;
  readonly enableMetaphor: boolean;
}

export interface ResolvedSessionOptions {
  readonly values: SessionOptions;
  readonly sources: Record<keyof SessionOptions, SessionOptionSource>;
}

export interface SessionOptionsResolverInput {
  readonly argv: FleetCliOptions;
  readonly cliIdOverride?: AgentCliId;
  readonly defaults: SessionOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly globalOptions: GlobalOptionsData;
  readonly parseCliId: (value: string | undefined) => AgentCliId | undefined;
}

export interface SessionOptionsRuntime {
  readonly getResolved: () => ResolvedSessionOptions;
  readonly getDraft: () => SessionOptions;
  readonly getStatusLines: () => readonly string[];
  readonly selectCli: (cliId: AgentCliId) => void;
  readonly toggleEnableMetaphor: () => void;
  readonly setModel: (model: string | undefined) => void;
}

export interface CreateSessionOptionsRuntimeOptions {
  readonly argv: FleetCliOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly globalOptionsService: GlobalOptionsService;
  readonly defaults: SessionOptions;
  readonly onStatusChange?: () => void;
  readonly parseCliId: (value: string | undefined) => AgentCliId | undefined;
}
