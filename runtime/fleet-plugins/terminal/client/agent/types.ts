export type SessionStatus = "starting" | "live" | "registered" | "terminal-only" | "closed" | "error" | "dormant";

export type TurnState = "none" | "running" | "ended";

export type AttentionReason =
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

export interface AgentCliMetadata {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly signedIn: boolean;
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
  readonly createdAt: number;
  readonly theaterId?: string;
  readonly tenantId?: string;
  readonly registrationId?: string;
  readonly resumeAvailable: boolean;
}

export interface ObservedTenant {
  readonly tenantId: string;
  readonly tenantLabel: string;
  readonly createdAt: number;
  readonly sessions: number;
  readonly status?: "live" | "closed" | "dormant";
  readonly cliRunId?: string;
  readonly registrationId?: string;
  readonly theaterId?: string;
  readonly terminalSessionId?: string;
}

export interface ObservedEvent {
  readonly id: number;
  readonly tenantId: string;
  readonly jobId?: string;
  readonly type: string;
  readonly at: number;
  readonly event: Record<string, unknown>;
}

export interface ObserverTruncation {
  readonly droppedCount: number;
  readonly newestId?: number;
}

export interface SnapshotJob {
  readonly jobId: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly events: readonly ObservedEvent[];
}

export interface SnapshotTenantJobs {
  readonly tenantId: string;
  readonly tenantLabel?: string;
  readonly jobs: readonly SnapshotJob[];
  readonly truncation?: ObserverTruncation;
}

export interface TrackToolCall {
  readonly id: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly status?: string;
}

export interface TrackView {
  readonly trackId: string;
  readonly displayName: string;
  readonly displayCli?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly subtitle?: string;
  readonly kind?: string;
  readonly status: string;
  readonly text: string;
  readonly thought: string;
  readonly sentTextLength: number;
  readonly sentThoughtLength: number;
  readonly requestPreview?: string;
  readonly tools: readonly TrackToolCall[];
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly error?: string;
}

export interface JobView {
  readonly jobId: string;
  readonly tenantId: string;
  readonly label?: string;
  readonly ownerCarrierId?: string;
  readonly kind?: string;
  readonly status: string;
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly finishedAt?: number;
  readonly summary?: string;
  readonly error?: string;
  readonly trackOrder: readonly string[];
  readonly tracks: Readonly<Record<string, TrackView>>;
  readonly lastEventId: number;
  readonly recentEvents: readonly ObservedEvent[];
}

export interface TenantJobsView {
  readonly tenantId: string;
  readonly tenantLabel?: string;
  readonly jobOrder: readonly string[];
  readonly jobs: Readonly<Record<string, JobView>>;
  readonly truncation: ObserverTruncation;
}

export interface AgentClientState {
  readonly connection: "connecting" | "live";
  readonly connectionError: string | null;
  readonly agentClis: readonly AgentCliMetadata[];
  readonly sessions: Readonly<Record<string, SessionInfo>>;
  readonly sessionOrder: readonly string[];
  readonly tenants: readonly ObservedTenant[];
  readonly tenantJobs: Readonly<Record<string, TenantJobsView>>;
  readonly tenantOrder: readonly string[];
  readonly activeTerminalSessionId: string | null;
  readonly turnState: Readonly<Record<string, TurnState>>;
}
