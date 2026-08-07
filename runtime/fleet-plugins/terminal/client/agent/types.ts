export type SessionStatus = "starting" | "live" | "registered" | "terminal-only" | "closed" | "error" | "dormant";

export type TurnState = "none" | "running" | "ended";
export type ModelActivity = "working" | "not-working";

export type AttentionReason =
  | "idle_prompt"
  | "permission_prompt"
  | "auth_success"
  | "elicitation_dialog"
  | "elicitation_complete"
  | "elicitation_response";

export interface AgentCliStatus {
  readonly id: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly version: string | null;
}

export interface AgentCliState {
  readonly clis: readonly AgentCliStatus[];
}

export interface AgentCliDiagnosticsEntry {
  readonly cliCommand: string;
  readonly configuredPath: string | null;
  readonly resolutionSource: "env" | "user" | "path" | null;
  readonly searchedPathEntries: readonly string[];
}

export interface AgentCliDiagnostics {
  readonly entries: readonly AgentCliDiagnosticsEntry[];
}

export interface AgentCliMetadata {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly signedIn: boolean;
}

export type GoalState = "requested" | "active" | "deferred" | "met" | "impossible" | "capped" | "unknown";

export interface SessionGoal {
  readonly state: GoalState;
  readonly live: boolean;
  readonly origin: "fleet" | "terminal";
  readonly checksUsed: number;
  readonly checkLimit: number;
  readonly pendingCheckLimit?: number;
  readonly totalChecks?: number;
  readonly condition?: string;
  readonly durationMs?: number;
  readonly tokens?: number;
}

export interface SessionInfo {
  readonly sessionId: string;
  readonly terminalSessionId: string;
  readonly cwdLabel: string;
  readonly label?: string;
  readonly cliId?: string;
  readonly cliLabel?: string;
  readonly status: SessionStatus;
  readonly turnState: TurnState;
  readonly modelActivity?: ModelActivity;
  readonly attentionPending?: boolean;
  readonly backgroundPending?: boolean;
  readonly createdAt: number;
  readonly theaterId?: string;
  readonly tenantId?: string;
  readonly registrationId?: string;
  readonly resumeAvailable: boolean;
  readonly goal?: SessionGoal;
}

export interface AgentClientState {
  readonly connection: "connecting" | "live";
  readonly connectionError: string | null;
  readonly agentClis: readonly AgentCliMetadata[];
  readonly sessions: Readonly<Record<string, SessionInfo>>;
  readonly sessionOrder: readonly string[];
  readonly activeTerminalSessionId: string | null;
  readonly turnState: Readonly<Record<string, TurnState>>;
}
