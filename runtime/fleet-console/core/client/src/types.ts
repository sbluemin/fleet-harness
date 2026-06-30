import type { OperationActivity } from "@fleet-console/sdk/plugin";

export type ThemeId = "maritime" | "carbon";

export interface ReleaseNoteSection {
  readonly heading: "Added" | "Changed" | "Fixed" | "Removed" | "Breaking Changes";
  readonly items: readonly ReleaseNoteItem[];
}

export interface ReleaseNoteItem {
  readonly packageTags: readonly string[];
  readonly text: string;
}

export interface ReleaseNotes {
  readonly version: string;
  readonly date: string | null;
  readonly sections: readonly ReleaseNoteSection[];
}

export interface ReleaseNotesResponse {
  readonly notes: readonly ReleaseNotes[];
  readonly sourceRef: "main";
  readonly fetchedAt: number;
  readonly stale: boolean;
}

export interface TheaterInfo {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
  readonly hasWiki: boolean;
  readonly activeAdmiralCount: number;
}

export interface TheaterBootstrap {
  readonly theaters: readonly TheaterInfo[];
}

export interface ObserverStatus {
  readonly workspaces: number;
  readonly jobs: number;
  readonly version: string;
  readonly channel: "stable" | "local" | "unknown";
  readonly updateAvailable: boolean;
  readonly latestVersion?: string;
  readonly port: number;
  readonly portMode: "dynamic" | "static";
  readonly requestedPort: number | null;
  readonly effectivePort: number;
  readonly portHonored: boolean;
  readonly wikiServerStatus: "available" | "unavailable" | "unknown";
}

export type ConsoleUpdateApplyError =
  | "active_terminal_sessions"
  | "console_not_ready"
  | "local_channel"
  | "update_already_in_progress"
  | "update_not_available"
  | "update_worker_unavailable";

export interface ConsoleUpdateApplyAcceptedResponse {
  readonly status: "accepted";
}

export interface OperationGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
}

export interface OperationGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly theaterId: string;
  readonly createdAt: number;
}

export interface OperationNode {
  readonly id: string;
  readonly theaterId: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly pluginId: string;
  readonly title: string;
  readonly renamedTitle?: string;
  readonly payload: Record<string, unknown>;
  readonly geometry: OperationGeometry | null;
  // 사용자 지정 accent 키(서버 영속). 미설정 시 부재. Dock 칩 perimeter 링 색의 SSoT다.
  readonly accent?: string | null;
  // 사용자 지정 그룹 id(서버 영속). null이면 Ungrouped, 미설정 시 부재(Ungrouped와 동일 취급).
  readonly groupId?: string | null;
  readonly state: Record<string, unknown>;
  readonly ts: {
    readonly createdAt: number;
    readonly updatedAt: number;
  };
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

export interface GlobalSettingsState {
  readonly consolePortMode: "dynamic" | "static";
  readonly consoleStaticPort: number | null;
}

export interface GlobalSettingsMutationResult {
  readonly state: GlobalSettingsState;
}

export interface ApiCatalogEntry {
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly category: string;
  readonly gate: string;
}

export type ConnectionState = "connecting" | "live";

export type NotificationKind = "ended" | "input-waiting";

export interface OperationNotification {
  readonly kind: NotificationKind;
  readonly operationId: string;
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly operationLabel: string;
  readonly count: number;
  readonly lastRaisedSeq: number;
}

export interface NotificationPreferences {
  readonly globalMute: boolean;
  readonly dnd: boolean;
  readonly mutedTheaterIds: Readonly<Record<string, true>>;
}

export type CodexReaderRequest =
  | { readonly kind: "entry"; readonly entryId: string }
  | { readonly kind: "drydock"; readonly patchId?: string }
  | { readonly kind: "conflicts"; readonly id?: string };

export interface ConsoleState {
  readonly connection: ConnectionState;
  readonly connectionError: string | null;
  readonly activeTheme: ThemeId;
  readonly version: string;
  readonly updateAvailable: boolean;
  readonly latestVersion: string | null;
  readonly portMode: "dynamic" | "static";
  readonly requestedPort: number | null;
  readonly effectivePort: number;
  readonly portHonored: boolean;
  readonly theaters: readonly TheaterInfo[];
  readonly operations: readonly OperationNode[];
  readonly operationsHydrated: boolean;
  readonly groups: readonly OperationGroup[];
  readonly activeTheaterId: string | null;
  readonly activeOperationId: string | null;
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  readonly addingTheater: boolean;
  readonly theaterError: string | null;
  readonly operationsViewActive: boolean;
  readonly operationSearchOpen: boolean;
  readonly whatsNewOpen: boolean;
  readonly releaseNotes: readonly ReleaseNotes[];
  readonly releaseNotesLoading: boolean;
  readonly releaseNotesError: string | null;
  readonly releaseNotesSourceRef: "main" | null;
  readonly releaseNotesFetchedAt: number | null;
  readonly releaseNotesStale: boolean;
  readonly automaticWhatsNewVersion: string | null;
  readonly selectedReleaseNoteKey: string | null;
  readonly onboardingOpen: boolean;
  readonly bootstrapped: boolean;
  readonly pendingOperationFocus: string | null;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly notificationPreferences: NotificationPreferences;
  readonly codexReader: CodexReaderRequest | null;
  readonly codexReaderExpanded: boolean;
}
