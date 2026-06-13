export interface ObservedTenant {
  readonly tenantId: string;
  readonly tenantLabel: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly sessions: number;
  readonly status?: "online" | "offline" | "deregistered";
  readonly cliRunId?: string;
  readonly registrationId?: string;
  readonly terminalSessionId?: string;
}

export type SessionStatus = "starting" | "live" | "registered" | "terminal-only" | "closed" | "error";

export interface SessionInfo {
  readonly sessionId: string;
  readonly terminalSessionId: string;
  readonly cwdLabel: string;
  readonly status: SessionStatus;
  readonly createdAt: number;
  readonly tenantId?: string;
  readonly registrationId?: string;
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
  readonly droppedBeforeId?: number;
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
  readonly truncation: ObserverTruncation;
}

export interface TrackToolCall {
  readonly key: string;
  readonly title: string;
  readonly status: string;
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
  readonly tools: readonly TrackToolCall[];
  readonly requestPreview?: string;
  readonly error?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
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

export type ConnectionState = "auth-needed" | "connecting" | "live";

export interface ConsoleState {
  readonly token: string | null;
  readonly terminalToken: string | null;
  readonly connection: ConnectionState;
  readonly connectionError: string | null;
  readonly tenants: readonly ObservedTenant[];
  readonly sessions: Readonly<Record<string, SessionInfo>>;
  readonly sessionOrder: readonly string[];
  readonly activeTerminalSessionId: string | null;
  readonly creatingTerminalSession: boolean;
  readonly terminalSessionError: string | null;
  readonly tenantJobs: Readonly<Record<string, TenantJobsView>>;
  readonly tenantOrder: readonly string[];
  readonly selectedTenantId: string | null;
  readonly selectedJobId: string | null;
  readonly timelineOpen: boolean;
  readonly coverOpen: boolean;
}
