import type { GoalObservedState } from "./goal-projection.js";

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

export interface OperationGoalRecord {
  readonly origin: "fleet" | "terminal";
  readonly checkLimit: number;
  readonly requestedAt: number;
  // 요청 시점까지 트랜스크립트에 이미 쌓여 있던 goal 마커 수. 트랜스크립트는 세션 내내
  // 누적되므로, 이 인덱스 이전의 마커는 이전 목표의 잔재다. 이게 없으면 새 목표를 건 직후에
  // 과거 목표의 종료 마커가 현재 상태로 투영된다.
  readonly markerBaseline: number;
  // Fleet이 보낸 조건문만 보관한다. 터미널에서 직접 친 조건은 트랜스크립트에만 있고
  // payload는 브라우저까지 그대로 나가므로 절대 여기에 복사하지 않는다.
  readonly condition?: string;
}

export interface AgentSessionGoal {
  readonly state: GoalObservedState | "requested";
  readonly live: boolean;
  readonly origin: "fleet" | "terminal";
  readonly checksUsed: number;
  /** 지금 강제되고 있는 한도. 살아 있는 세션에서는 프로세스가 spawn 때 받은 값이다. */
  readonly checkLimit: number;
  /** 사용자가 고른 한도가 아직 강제되지 않을 때만 존재한다(다음 재개부터 적용). */
  readonly pendingCheckLimit?: number;
  readonly totalChecks?: number;
  readonly condition?: string;
  readonly durationMs?: number;
  readonly tokens?: number;
}

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
  readonly createdAt: number;
  readonly theaterId: string;
  readonly registrationId?: string;
  readonly cliRunId?: string;
  readonly tenantId?: string;
  readonly resumeAvailable: boolean;
  readonly goal?: AgentSessionGoal;
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
