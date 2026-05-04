import type { CliType } from "@sbluemin/unified-agent";

export interface BridgeLaunchContext {
  cli: CliType;
  model: string;
  sessionId: string;
  cwd: string;
  effort?: string;
}

export interface BridgeCommandSpec {
  command: string;
  cwd: string;
  title: string;
}

export type ActiveBridgeSession = BridgeLaunchContext;

export const BRIDGE_DEFAULT_KEY = "alt+t";
export const BRIDGE_EXTENSION_ID = "bridge";
export const BRIDGE_ACTION_ID = "launch";
export const BRIDGE_KEYBIND_CATEGORY = "Fleet Bridge";
export const BRIDGE_TITLE_PREFIX = "ACP Bridge";

export type InteractiveShellBridge = {
  open(opts: { command: string; title?: string; cwd?: string; env?: Record<string, string> }): Promise<{ exitCode: number | null; signal?: number; cancelled: boolean } | void>;
  isOpen(): boolean;
} | undefined;
