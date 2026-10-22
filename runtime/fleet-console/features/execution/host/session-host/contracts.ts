import type { ClaudeGatewaySdkOptions, ClaudeGatewaySessionRequest } from "@fleet-console/agent-runtime/claude";
import type { AiGatewayStoredSettings } from "@fleet-console/ai-gateway";
import type { SessionGeneration, SessionLaunchFingerprint } from "@fleet-console/protocol/session-host";
import type { TerminalLaunchSpec } from "../terminal/terminal-types.js";

export interface HostedToolGroup {
  readonly name: string;
  readonly instructions?: string;
  readonly port: string;
  readonly tools: readonly { readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown> }[];
  readonly resources?: readonly { readonly uri: string; readonly name: string; readonly description?: string; readonly mimeType?: string }[];
}
export interface HostedSessionBase {
  readonly sessionKey: string;
  readonly generation: SessionGeneration;
  readonly launchFingerprint?: SessionLaunchFingerprint | null;
  /** Policy hooks wait on this backend; observational hooks always enter the replay stream. */
  readonly hookPolicyPort?: string;
}
export interface HostedSdkLaunch extends HostedSessionBase {
  readonly kind: "sdk";
  readonly sdk: Omit<ClaudeGatewaySdkOptions, "modelPolicy" | "spawnProcess">;
  readonly request: Omit<ClaudeGatewaySessionRequest, "canUseTool" | "mcpServers" | "abortController" | "stderr">;
  readonly embeddedTools?: readonly HostedToolGroup[];
  readonly permissionPort?: string;
}
export interface HostedPtyLaunch extends HostedSessionBase {
  readonly kind: "pty";
  readonly launch: TerminalLaunchSpec;
  readonly size: { readonly cols: number; readonly rows: number };
  readonly mcpTools?: readonly HostedToolGroup[];
  /** One pre-spawn business call receives stable MCP/hook coordinates and returns the final argv/environment. */
  readonly launchPort?: string;
}
export interface HostedGatewayLaunch extends HostedSessionBase {
  readonly kind: "gateway";
  readonly options: {
    readonly settings?: AiGatewayStoredSettings;
    readonly modelOverride?: string;
    readonly compactHookToken?: string;
    readonly modHookToken?: string;
    readonly maxUpstreamInFlight?: number;
  };
  /** Credential readers and business routing stay injected; never read an ambient credential here. */
  readonly ports: Readonly<Partial<Record<"readAuth" | "readCursorToken" | "readXaiToken" | "readAntigravityToken" | "renewAntigravityToken" | "readMuseCodeAuth" | "renewMuseCodeAuth" | "assignRouting", string>>>;
}
export type HostedSessionLaunch = HostedSdkLaunch | HostedPtyLaunch | HostedGatewayLaunch;
export interface SessionCheckpoint {
  readonly version: number;
  readonly lastConsumedSeq: number;
  readonly activeCommandId: string | null;
  readonly pendingInputs: readonly unknown[];
  readonly pendingAsks: readonly unknown[];
  readonly jobs: readonly unknown[];
  readonly queuedWakes: readonly unknown[];
  readonly state: unknown;
}
