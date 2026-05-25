import type { FleetCliPreset, FleetPresetData, PresetService, PresetSourceLabel } from "@dotobokuri/fleet-infra/preset";

import type { AgentCliId } from "../agent-cli/types.js";
import type { FleetCliOptions } from "../cli-args.js";

export type SessionOptionSource = PresetSourceLabel | "session";

export interface SessionOptions {
  readonly cliId: AgentCliId;
  readonly model?: string;
  readonly native: boolean;
  readonly replaceSystemPrompt: boolean;
  readonly enableMetaphor: boolean;
  readonly cursorSync: boolean;
}

export interface ResolvedSessionOptions {
  readonly values: SessionOptions;
  readonly sources: Record<keyof SessionOptions, SessionOptionSource>;
}

export interface SessionOptionsResolverInput {
  readonly argv: FleetCliOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly preset: FleetPresetData;
  readonly defaults: SessionOptions;
  readonly parseCliId: (value: string | undefined) => AgentCliId | undefined;
}

export interface SessionOptionsRuntime {
  readonly getResolved: () => ResolvedSessionOptions;
  readonly getDraft: () => SessionOptions;
  readonly selectCli: (cliId: AgentCliId) => void;
  readonly toggleNative: () => void;
  readonly toggleReplaceSystemPrompt: () => void;
  readonly toggleEnableMetaphor: () => void;
  readonly toggleCursorSync: () => void;
  readonly setModel: (model: string | undefined) => void;
  readonly saveDraft: () => Promise<ResolvedSessionOptions>;
  readonly resetOverrides: () => void;
}

export interface CreateSessionOptionsRuntimeOptions {
  readonly argv: FleetCliOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly presetService: PresetService;
  readonly defaults: SessionOptions;
  readonly parseCliId: (value: string | undefined) => AgentCliId | undefined;
}

export type SessionOptionsDraftPatch = Partial<SessionOptions>;
export type SessionOptionsPresetFragment = FleetCliPreset;
