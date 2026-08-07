import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { ConsoleTheme, OperationActivity } from "@fleet-console/sdk/plugin";

export type ThemeId = "instrument" | "maritime" | "carbon" | "whites";

/**
 * Quick Launch 컴포저가 확정한 실행 의도.
 *
 * `variant`는 캔버스 우클릭 메뉴가 쓰는 것과 같은 flat wire 레코드다 — 여기에 `prompt`가 함께 실려
 * 터미널 플러그인의 세션 생성 body로 나간다. 프롬프트는 spawn 전용 값이라 응답이나 Operation
 * payload로 되돌아오지 않는다.
 */
export interface QuickLaunchRequest {
  readonly theaterId: string;
  readonly pluginId: string;
  readonly kind: OperationLaunchKind;
  readonly variant: Readonly<Record<string, string>>;
}

export type ReleaseNotesLocale = "en" | "ko";

export type ReleaseNoteProduct = "fleet-cli" | "fleet-console" | "fleet-desktop";

export type ConsoleLanguagePreference = "auto" | ReleaseNotesLocale;

export type UiFontId = "manrope" | "jetbrains-mono" | "source-code-pro";

export type UiFontSettings =
  | { readonly source: "builtin"; readonly id: UiFontId; readonly size: number }
  | { readonly source: "system"; readonly familyName: string; readonly size: number };

export interface ReleaseNoteSection {
  readonly heading: "Added" | "Changed" | "Fixed" | "Removed" | "Breaking Changes";
  readonly items: readonly ReleaseNoteItem[];
}

export interface ReleaseNoteItem {
  readonly packageTags: readonly string[];
  readonly text: string;
  readonly product?: ReleaseNoteProduct;
}

export interface ReleaseNotes {
  readonly version: string;
  readonly date: string | null;
  readonly sections: readonly ReleaseNoteSection[];
  readonly localizationFallback: boolean;
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
  readonly order?: number;
  readonly hasWiki: boolean;
  readonly activeAdmiralCount: number;
}

export interface TheaterBootstrap {
  readonly theaters: readonly TheaterInfo[];
}

export interface ObserverStatus {
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
  readonly wikiServerStatus: "available" | "unavailable" | "unknown";
}

export interface ConsoleEnvironmentDiagnostics {
  readonly channel: "local";
  readonly version: string;
  readonly effectivePort: number;
  readonly dataDir: string;
  readonly lockFile: string;
}

export type ConsoleUpdateApplyError =
  | "console_not_ready"
  | "local_channel"
  | "managed_runtime_update_requires_relaunch"
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
  readonly type: string;
  readonly pluginId: string;
  readonly title: string;
  readonly payload: Record<string, unknown>;
  readonly geometry: OperationGeometry | null;
  // 사용자 지정 accent 키(서버 영속). 미설정 시 부재. Dock 칩 perimeter 링 색의 SSoT다.
  readonly accent?: string | null;
  // 사용자 지정 그룹 id(서버 영속). null이면 Ungrouped, 미설정 시 부재(Ungrouped와 동일 취급).
  readonly groupId?: string | null;
  readonly ts: {
    readonly createdAt: number;
    readonly updatedAt: number;
  };
}

export interface GlobalSettingsState {
  readonly consolePortMode: "dynamic" | "static";
  readonly consoleStaticPort: number | null;
  readonly seenFeatureTours: readonly string[];
  readonly theme: ThemeId;
  readonly uiFont: UiFontSettings;
  readonly language: ConsoleLanguagePreference;
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

export type ConnectionState = "connecting" | "live" | "offline";

export type NotificationKind = "ended" | "input-waiting";

export interface OperationNotification {
  readonly kind: NotificationKind;
  readonly operationId: string;
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly operationLabel: string;
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
  | { readonly kind: "conflicts"; readonly id?: string }
  | { readonly kind: "schema"; readonly templateId?: string };

export interface ConsoleState {
  readonly connection: ConnectionState;
  readonly connectionLostAt: number | null;
  readonly channel: ObserverStatus["channel"];
  readonly activeTheme: ConsoleTheme;
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
  readonly activeOperationAcknowledged: boolean;
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  readonly addingTheater: boolean;
  readonly theaterError: string | null;
  readonly operationsViewActive: boolean;
  readonly operationSearchOpen: boolean;
  readonly operationSearchSeed: string | null;
  readonly quickLaunchOpen: boolean;
  // 실행이 거절되면 컴포저를 이 초안과 함께 다시 연다 — 서버 거절(모델 비활성·CLI 미가용·
  // 프롬프트 전달 불가)은 컴포저가 결과를 기다리지 않는 구조라 이 경로로만 사용자에게 돌아온다.
  readonly quickLaunchDraft: string | null;
  // 컴포저가 넘긴 실행 의도. Operations 화면이 자기 지오메트리·포커스 규율로 소비한다
  // (pendingOperationFocus와 같은 request/consume 계약).
  readonly pendingQuickLaunch: QuickLaunchRequest | null;
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
  readonly keyboardFocusRequest: { readonly operationId: string; readonly requestId: number } | null;
  readonly pendingSideBarAddTheater: boolean;
  readonly pendingSideBarTheaterLaunch: string | null;
  readonly launchMenuRequest: { readonly requestId: number } | null;
  readonly keyboardShortcutsOpen: boolean;
  readonly operationNotifications: Readonly<Record<string, OperationNotification>>;
  readonly notificationPreferences: NotificationPreferences;
  readonly codexReader: CodexReaderRequest | null;
  readonly codexReaderExpanded: boolean;
}
