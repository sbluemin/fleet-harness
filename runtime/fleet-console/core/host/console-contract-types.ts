import type { ConsoleThemeId, UiFontSettings } from "./settings/settings-domain.js";

export interface ConsoleLockPayload {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly startedAt: number;
  readonly token: string;
  readonly version: string;
  readonly owner?: ConsoleOwnerMetadata;
}

export interface ConsoleOwnerMetadata {
  readonly kind: "cli" | "desktop";
  readonly id: string;
  readonly protocolVersion: number;
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
  readonly channel?: "stable" | "local";
  readonly owner?: ConsoleOwnerMetadata;
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
  readonly order?: number;
  readonly hasWiki: boolean;
  readonly activeAdmiralCount: number;
}

export interface ConsoleAgentCliMetadata {
  readonly id: string;
  readonly label: string;
}

export type ConsoleObserverWikiServerStatus = "available" | "unavailable" | "unknown";

export interface ConsoleObserverStatus {
  /** 이 콘솔이 스스로를 부르는 이름. 액세스 링크의 label과 같은 값이라 양쪽에서 같게 읽힌다. */
  readonly name: string;
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

export interface ConsoleEnvironmentDiagnostics {
  readonly channel: "local";
  readonly version: string;
  readonly effectivePort: number;
  readonly dataDir: string;
  readonly lockFile: string;
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
  readonly label?: string;
  readonly accent?: string;
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

/**
 * 수락에는 두 가지가 있다. "accepted"는 이 콘솔이 스스로 갈아 끼운다는 뜻이고,
 * "delegated"는 이 설치 레이아웃을 제자리에서 고칠 수 없어 창을 들고 있는 셸에게
 * 넘겼다는 뜻이다. 둘 다 업데이트가 시작됐다 — 다른 것은 수행자뿐이다.
 */
export interface ConsoleUpdateApplyAcceptedResponse {
  readonly status: "accepted" | "delegated";
}

// An apply request can be refused by the current installation layout without
// implying a Desktop release channel or Console feature mode.
export type ConsoleUpdateApplyError =
  | "console_not_ready"
  | "host_restart_confirmation_required"
  | "local_channel"
  | "managed_runtime_update_requires_relaunch"
  | "update_already_in_progress"
  | "update_not_available"
  | "update_worker_unavailable";

export interface ConsoleUpdateProgressResponse {
  readonly state: "idle" | "running" | "completed" | "failed";
  readonly phase?: string;
  readonly startedAt?: string;
  readonly targetVersion?: string;
  readonly fromVersion?: string;
  readonly endpointChanged?: boolean;
  readonly error?: string;
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
  readonly payload: Record<string, unknown>;
  readonly geometry: ConsoleOperationGeometry | null;
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

// 브라우저로 나가는 General 설정 DTO. console-settings.ts의 ConsoleSettingsData에서
// 내부 격리 키(version)를 제외하고 flat으로 변환해 표면화한다.

export interface RemotePortState {
  readonly mode: "auto" | "custom";
  readonly value: number;
}

export interface RemoteAccessState {
  readonly enabled: boolean;
  readonly publicEndpointEnabled: boolean;
  readonly listenAddress: string;
  readonly advertisedHost: string;
  readonly listenPort: RemotePortState;
  readonly advertisedPort: RemotePortState;
  readonly acknowledgment: {
    readonly version: 1;
    readonly listenAddress: string;
    readonly listenPort: number;
    readonly advertisedHost: string;
    readonly advertisedPort: number;
  } | null;
}

export interface GlobalSettingsState {
  readonly consolePortMode: "dynamic" | "static";
  readonly consoleStaticPort: number | null;
  readonly language: "auto" | "en" | "ko";
  /** 원격 리스너로 들어온 요청에는 실리지 않는다 — 이 섹션은 소유자 것이다. */
  readonly remoteAccess?: RemoteAccessState;
  readonly seenFeatureTours: readonly string[];
  readonly theme: ConsoleThemeId;
  /** 리퀴드 글래스 머티리얼 — 기본 옵트인(true). */
  readonly liquidGlass: boolean;
  /** 포커스하지 않은 패널 본문이 물러나는 세기(백분율, 0~70). 0은 물러나지 않음. */
  readonly unfocusedPanelFade: number;
  readonly uiFont: UiFontSettings;
}

export interface GlobalSettingsMutationResult {
  readonly state: GlobalSettingsState;
}
