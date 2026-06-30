export type AgentSessionStatus = "starting" | "terminal-only" | "registered" | "closed" | "error" | "dormant";

export type AgentTurnState = "none" | "running" | "ended";

export type AgentAttentionReason =
  | "permission_prompt"
  | "auth_success"
  | "elicitation_dialog"
  | "elicitation_complete"
  | "elicitation_response";

export type AgentLabelSource = "user" | "auto";

export interface AgentProviderSession {
  readonly provider: "claude" | "codex";
  readonly sessionId: string;
  readonly transcriptPath?: string;
  readonly source?: string;
  readonly capturedAt: string;
}

export interface AgentDurableOperation {
  readonly sessionId: string;
  readonly theaterId: string;
  readonly cwd: string;
  readonly label?: string;
  readonly labelSource?: AgentLabelSource;
  readonly autoNamePromptSeen?: boolean;
  readonly cliId?: string;
  readonly cliLabel?: string;
  readonly createdAt: number;
  readonly providerSession?: AgentProviderSession;
}

export interface AgentTerminalSessionInfo {
  readonly sessionId: string;
  readonly terminalSessionId: string;
  readonly cwdLabel: string;
  readonly label?: string;
  readonly labelSource?: AgentLabelSource;
  readonly cliId?: string;
  readonly cliLabel?: string;
  readonly status: AgentSessionStatus;
  readonly turnState: AgentTurnState;
  readonly createdAt: number;
  readonly theaterId: string;
  readonly registrationId?: string;
  readonly cliRunId?: string;
  readonly tenantId?: string;
  readonly resumeAvailable: boolean;
}

export interface AgentObservedWorkspace {
  readonly tenantId: string;
  readonly tenantLabel: string;
  readonly createdAt: number;
  readonly sessions: number;
  readonly status: "live" | "closed" | "dormant";
  readonly cliRunId: string;
  readonly registrationId: string;
  readonly theaterId: string;
  readonly terminalSessionId?: string;
}

export interface AgentObservedEvent {
  readonly id: number;
  readonly tenantId: string;
  readonly jobId?: string;
  readonly type: string;
  readonly at: number;
  readonly event: Record<string, unknown>;
}

export interface AgentObservedJob {
  readonly jobId: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly events: readonly AgentObservedEvent[];
}

export interface AgentObserverTruncation {
  readonly droppedCount: number;
  readonly droppedBeforeId?: number;
}

export interface AgentWorkspaceJobs {
  readonly tenantId: string;
  readonly tenantLabel?: string;
  readonly jobs: readonly AgentObservedJob[];
  readonly truncation: AgentObserverTruncation;
}

export interface AgentSessionUpdatedEvent {
  readonly type: "session:updated";
  readonly session: AgentTerminalSessionInfo;
}

export interface AgentSessionAttentionEvent {
  readonly type: "session:attention";
  readonly session: AgentTerminalSessionInfo;
  readonly reason?: AgentAttentionReason;
}
