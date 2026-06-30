export interface ConsoleLockPayload {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly startedAt: number;
  readonly token: string;
  readonly version: string;
}

export interface ConsoleHealth {
  readonly ok: true;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly portMode: "dynamic" | "static";
  readonly requestedPort: number | null;
  readonly effectivePort: number;
  readonly portHonored: boolean;
  readonly endpoint: string;
  readonly startedAt: number;
  readonly version: string;
  readonly workspaceCount: number;
}

export interface ConsoleObservedWorkspace {
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

export interface ConsoleTheaterInfo {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
  readonly hasWiki: boolean;
  readonly activeAdmiralCount: number;
}

export interface ConsoleAgentCliMetadata {
  readonly id: string;
  readonly label: string;
}

export type ConsoleObserverWikiServerStatus = "available" | "unavailable" | "unknown";

export interface ConsoleObserverStatus {
  readonly workspaces: number;
  readonly version: string;
  readonly channel: "stable" | "local" | "unknown";
  readonly updateAvailable: boolean;
  readonly latestVersion?: string;
  readonly port: number;
  readonly portMode: "dynamic" | "static";
  readonly requestedPort: number | null;
  readonly effectivePort: number;
  readonly portHonored: boolean;
  readonly wikiServerStatus: ConsoleObserverWikiServerStatus;
}

export interface ConsoleObserverTheatersResponse {
  readonly theaters: readonly ConsoleTheaterInfo[];
  readonly agentClis?: readonly ConsoleAgentCliMetadata[];
}

export interface CreateTheaterCancelledResponse {
  readonly cancelled: true;
}

export interface CreateTheaterResponse extends ConsoleTheaterInfo {}

export type ConsoleTerminalSessionStatus = "starting" | "terminal-only" | "registered" | "closed" | "error" | "dormant";

// Agent CLI 턴(host 처리) 상태. "none"=턴 이력 없음(신규), "running"=처리중, "ended"=종료(유휴).
export type ConsoleTurnState = "none" | "running" | "ended";

export interface ConsoleTerminalSessionInfo {
  readonly sessionId: string;
  readonly terminalSessionId: string;
  readonly cwdLabel: string;
  readonly sequence: number;
  readonly label?: string;
  readonly accent?: string;
  readonly cliId?: string;
  readonly cliLabel?: string;
  readonly status: ConsoleTerminalSessionStatus;
  readonly turnState: ConsoleTurnState;
  readonly createdAt: number;
  readonly theaterId: string;
  readonly registrationId?: string;
  readonly cliRunId?: string;
  readonly tenantId?: string;
  readonly resumeAvailable: boolean;
}

export interface ConsoleSessionUpdatedEvent {
  readonly type: "session:updated";
  readonly session: ConsoleTerminalSessionInfo;
}

// Notification hook의 notification_type. idle_prompt만 캐리어 출격 중 억제 대상이고,
// 권한 요청·elicitation 등과 부재(예: AskUserQuestion=PreToolUse)는 실제 입력 대기로 간주한다.
export type ConsoleAttentionReason =
  | "idle_prompt"
  | "permission_prompt"
  | "auth_success"
  | "elicitation_dialog"
  | "elicitation_complete"
  | "elicitation_response";

// Agent CLI가 사용자 입력을 기다리며 중단된 transient 신호(턴 상태는 "running" 유지). session:updated와 달리
// 세션 메타를 갱신하지 않고 1회성 알림만 흘린다. reason은 출격 중 오탐(idle_prompt)을 구분하기 위한 신호다.
export interface ConsoleSessionAttentionEvent {
  readonly type: "session:attention";
  readonly session: ConsoleTerminalSessionInfo;
  readonly reason?: ConsoleAttentionReason;
}

export interface ConsoleTheaterFolderListEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "dir";
  readonly accessible: boolean;
}

export interface ConsoleTheaterFolderListResponse {
  readonly path: string;
  readonly parentPath: string | null;
  readonly roots: readonly string[];
  readonly entries: readonly ConsoleTheaterFolderListEntry[];
  readonly truncated?: true;
}

export interface ConsoleTheaterFolderGrantResponse {
  readonly folderGrantId: string;
}

export interface CreateTerminalSessionRequest {
  readonly folderGrantId: string;
  readonly cliId?: string;
}

export interface CreateTerminalSessionResponse extends ConsoleTerminalSessionInfo {}

export interface CreateTheaterSessionResponse extends ConsoleTerminalSessionInfo {}

export interface ListTerminalSessionsResponse {
  readonly sessions: readonly ConsoleTerminalSessionInfo[];
}

export interface ConsoleObservedEvent {
  readonly id: number;
  readonly tenantId: string;
  readonly jobId?: string;
  readonly type: string;
  readonly at: number;
  readonly event: Record<string, unknown>;
}

export interface ConsoleObservedJob {
  readonly jobId: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly events: readonly ConsoleObservedEvent[];
}

export interface ConsoleObserverTruncation {
  readonly droppedCount: number;
  readonly droppedBeforeId?: number;
}

export interface ConsoleObserverWorkspaceJobs {
  readonly tenantId: string;
  readonly tenantLabel?: string;
  readonly jobs: readonly ConsoleObservedJob[];
  readonly truncation: ConsoleObserverTruncation;
}

export interface ConsoleObserverAggregateJobsResponse {
  readonly tenants: readonly ConsoleObserverWorkspaceJobs[];
}

export interface ConsoleObserverWorkspacesResponse {
  readonly tenants: readonly ConsoleObservedWorkspace[];
}

export interface ConsoleUpdateApplyAcceptedResponse {
  readonly status: "accepted";
}

export interface ConsoleOperationGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
}

export interface ConsoleOperationNode {
  readonly id: string;
  readonly theaterId: string;
  readonly type: string;
  readonly pluginId: string;
  readonly title: string;
  readonly renamedTitle?: string;
  readonly payload: Record<string, unknown>;
  readonly geometry: ConsoleOperationGeometry | null;
  readonly state: Record<string, unknown>;
  readonly ts: {
    readonly createdAt: number;
    readonly updatedAt: number;
  };
}

export interface ConsoleOperationsResponse {
  readonly operations: readonly ConsoleOperationNode[];
}

export interface ConsoleOperationResponse {
  readonly operation: ConsoleOperationNode;
}
