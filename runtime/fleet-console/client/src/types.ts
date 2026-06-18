export type ThemeId = "maritime" | "carbon";

export type TerminalRenderer = "webgl" | "dom";

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

export interface TheaterInfo {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
  readonly hasWiki: boolean;
  readonly activeAdmiralCount: number;
}

export interface AgentCliMetadata {
  readonly id: string;
  readonly label: string;
}

export interface TheaterBootstrap {
  readonly theaters: readonly TheaterInfo[];
  readonly agentClis: readonly AgentCliMetadata[];
}

export interface ObserverStatus {
  readonly workspaces: number;
  readonly jobs: number;
  readonly version: string;
  readonly channel: "stable" | "local" | "unknown";
  readonly updateAvailable: boolean;
  readonly latestVersion?: string;
  readonly port: number;
  readonly wikiServerStatus: "available" | "unavailable" | "unknown";
}

export interface CarrierReadinessEntry {
  readonly carrierId: string;
  readonly displayName: string;
  readonly role: string | null;
  readonly model: string;
  readonly effort: string | null;
  readonly taskForceBackendCount: number;
  readonly subagentMode: boolean;
  readonly category?: "strategy" | "planning" | "operations";
  readonly slot: number;
  readonly cliType: string;
}

export type CarrierSettingsAgentMode = "cli" | "subagent";

export interface CarrierSettingsModelOption {
  readonly modelId: string;
  readonly name: string;
  readonly effort?: {
    readonly levels: readonly string[];
    readonly default: string;
  };
}

export interface CarrierSettingsCliOption {
  readonly id: string;
  readonly displayName: string;
  readonly supportsSubagent: boolean;
  readonly models: readonly CarrierSettingsModelOption[];
  readonly defaultModel: string;
}

export interface CarrierSettingsOptions {
  readonly cliTypes: readonly CarrierSettingsCliOption[];
  readonly taskForceConstraints: {
    readonly minBackends: number;
  };
}

export interface CarrierSettingsTaskForceBackend {
  readonly cliType: string;
  readonly model: string;
  readonly effort?: string;
}

export interface CarrierSettingsCarrier {
  readonly carrierId: string;
  readonly displayName: string;
  readonly sourceDisplayName: string;
  readonly role: string;
  readonly roleDescription: string;
  readonly category?: "strategy" | "planning" | "operations";
  readonly slot: number;
  readonly cliType: string;
  readonly defaultCliType: string;
  readonly model: string;
  readonly effort?: string;
  readonly agentMode: CarrierSettingsAgentMode;
  readonly subagentMode: boolean;
  readonly taskForceBackendCount: number;
  readonly taskforce: {
    readonly backends: readonly CarrierSettingsTaskForceBackend[];
  };
}

export interface CarrierSettingsState {
  readonly generation: number;
  readonly carriers: readonly CarrierSettingsCarrier[];
}

export interface CarrierSettingsMutationResult {
  readonly state: CarrierSettingsState;
}

// 전역 설정(시스템 프롬프트 주입 방식 + 메타포) DTO — server src/global-settings-types.ts와 수동 동기화한다.
export interface GlobalSettingsState {
  readonly replaceSystemPrompt: boolean;
  readonly enableMetaphor: boolean;
}

export interface GlobalSettingsMutationResult {
  readonly state: GlobalSettingsState;
}

export type SessionStatus = "starting" | "live" | "registered" | "terminal-only" | "closed" | "error" | "dormant";

// Agent CLI 턴(host 처리) 상태. "none"=턴 이력 없음(신규), "running"=처리중, "ended"=종료(유휴).
export type TurnState = "none" | "running" | "ended";

export interface SessionInfo {
  readonly sessionId: string;
  readonly terminalSessionId: string;
  readonly cwdLabel: string;
  readonly sequence: number;
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

export type ConnectionState = "connecting" | "live";

// Operation 상태 전이/입력 대기 알림 토스트. kind는 인디케이터 상태에 대응:
//   carrier-call=캐리어 출격(Job 발생, aurora) · ended=작업 완료(턴 종료, 그린)
//   · input-waiting=입력 대기(AskUserQuestion·권한/유휴/elicitation, amber).
export type OperationToastKind = "carrier-call" | "ended" | "input-waiting";

export interface OperationToast {
  readonly id: number;
  readonly kind: OperationToastKind;
  readonly sessionId: string;
  readonly theaterLabel: string;
  readonly operationLabel: string;
}

export interface ConsoleState {
  readonly connection: ConnectionState;
  readonly connectionError: string | null;
  readonly activeTheme: ThemeId;
  readonly terminalRenderer: TerminalRenderer;
  readonly updateAvailable: boolean;
  readonly latestVersion: string | null;
  readonly tenants: readonly ObservedTenant[];
  readonly theaters: readonly TheaterInfo[];
  readonly agentClis: readonly AgentCliMetadata[];
  readonly activeTheaterId: string | null;
  readonly addingTheater: boolean;
  readonly theaterError: string | null;
  readonly sessions: Readonly<Record<string, SessionInfo>>;
  readonly sessionOrder: readonly string[];
  readonly activeTerminalSessionId: string | null;
  readonly creatingTerminalSession: boolean;
  readonly terminalSessionError: string | null;
  readonly tenantJobs: Readonly<Record<string, TenantJobsView>>;
  readonly tenantOrder: readonly string[];
  readonly timelineOpen: boolean;
  readonly shellOpen: boolean;
  readonly operationSearchOpen: boolean;
  readonly shortcutsOpen: boolean;
  readonly onboardingOpen: boolean;
  readonly bootstrapped: boolean;
  // 검색 등에서 특정 Operation으로 이동을 요청한 일회성 신호. Map 모드는 이를 소비해 해당 패널로 확대한다.
  readonly pendingOperationFocus: string | null;
  readonly selectedJobId: string | null;
  readonly expandedSessionIds: readonly string[];
  // Theater 무관 전역 Operation 상태 전이 알림 토스트 큐(현재 보는 Operation은 억제).
  readonly operationToasts: readonly OperationToast[];
}
