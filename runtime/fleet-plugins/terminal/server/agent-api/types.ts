export type AgentSessionStatus = "starting" | "terminal-only" | "registered" | "closed" | "error" | "dormant";

export type AgentTurnState = "none" | "running" | "ended";

export type AgentModelActivity = "working" | "not-working";

export type AgentAttentionReason =
  | "idle_prompt"
  | "permission_prompt"
  | "auth_success"
  | "elicitation_dialog"
  | "elicitation_complete"
  | "elicitation_response";

export type AgentLabelSource = "user" | "auto";

// Provider-derived titles are durable server state. Keep this separate from
// AgentLabelSource because that union is projected into browser session DTOs.
export interface AgentProviderTitleMarker {
  readonly source: "provider";
}

export interface AgentProviderSession {
  readonly provider: "claude";
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
  readonly providerTitle?: AgentProviderTitleMarker;
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
  readonly modelActivity?: AgentModelActivity;
  readonly attentionPending?: boolean;
  readonly backgroundPending?: boolean;
  /**
   * Chat Mode가 이 세션을 인수했는지. PTY는 접혔지만 core-agent SDK가 같은 provider 세션을 이어
   * 돌리므로 실행 표면은 살아 있다 — 활동 해석은 PTY의 유무가 아니라 이 값을 먼저 읽어야 한다.
   */
  readonly chatActive?: boolean;
  /** Chat Mode의 SDK 턴이 진행 중인지. runTurn 의 시작과 finally 가 이 값의 유일한 필자다. */
  readonly chatWorking?: boolean;
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
  /** First valid observer-only request, retained beyond the event window. */
  readonly request?: AgentObservedRequest;
  readonly events: readonly AgentObservedEvent[];
}

export interface AgentObservedRequestBlock {
  readonly tag: string;
  readonly hint: string;
  readonly required: boolean;
  readonly present: boolean;
  readonly body: string;
}

export interface AgentObservedRequest {
  readonly blocks: readonly AgentObservedRequestBlock[];
  readonly additional: string;
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
