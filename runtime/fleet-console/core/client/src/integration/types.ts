import type { ConsoleExperimentSettings, ShortcutBindings } from "@fleet-console/sdk/settings";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { ApiCatalogEntry as SdkApiCatalogEntry, ConsoleTheme, OperationRuntimeHydration, OperationRuntimeState } from "@fleet-console/sdk/plugin";

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
  readonly pluginId: string | null;
  readonly kind: OperationLaunchKind;
  readonly variant: Readonly<Record<string, string>>;
  /**
   * 첨부 이미지의 컴포저측 자취. id는 variant의 `attachments` CSV로도 실려 서버에 닿고,
   * 이름·미리보기(object URL)는 실행이 거절됐을 때 칩을 되살리기 위한 브라우저 전용 값이다 —
   * 저장 경로는 어디에도 없다.
   */
  readonly attachments?: readonly QuickLaunchDraftAttachment[];
}

/** 컴포저 밖(초안 슬롯·실행 의도)을 오가는 첨부 자취. previewUrl은 브라우저 object URL이다. */
export interface QuickLaunchDraftAttachment {
  readonly id: string;
  readonly name: string;
  readonly previewUrl: string;
}

export type ReleaseNotesLocale = "en" | "ko";

export type ReleaseNoteProduct = "fleet-cli" | "fleet-console" | "fleet-desktop" | "fleet-mobile";

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

/**
 * 이 콘솔이 방금 겪은(또는 겪고 있는) 업데이트. 서버의 메모리가 아니라 워커가 디스크에
 * 남긴 기록에서 온다 — 그래서 재기동을 건너뛰고도 결과를 말할 수 있다.
 */
export interface ConsoleUpdateProgress {
  readonly state: "idle" | "running" | "completed" | "failed";
  readonly phase?: string;
  readonly startedAt?: string;
  readonly targetVersion?: string;
  readonly fromVersion?: string;
  readonly endpointChanged?: boolean;
  readonly error?: string;
}

export interface ConsoleUpdateApplyAcceptedResponse {
  readonly status: "accepted" | "delegated";
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
  readonly order?: number;
  readonly type: string;
  readonly pluginId: string | null;
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

/** Remote listener and public endpoint settings. Auto and Custom modes both carry persisted concrete candidates. */
export { REMOTE_AUTO_PORT_MIN, REMOTE_AUTO_PORT_MAX, REMOTE_PORT_MIN, REMOTE_PORT_MAX, isWarnableLocalPort, generateRemoteAutoPort, isCommittableRemotePortDraft, isValidRemoteListenAddress, isValidRemoteAdvertisedHost, remoteEffectiveEndpoint, remoteEndpointRequirements, remoteEndpointImpact, buildRemoteEndpointPresentation, remoteAccessStateEquals, isValidRemoteAccessPort, isValidRemoteAccessAcknowledgment, isValidRemoteAccessState, isValidRemoteAccessId, isValidRemoteFingerprint, isValidRemoteTimestamp } from "../../../../features/remote-access/client/contracts.js";
export type { RemoteAccessPort, RemoteAccessAcknowledgment, RemoteAccessState, RemoteAccessClass, RemoteAccessLinkSummary, RemoteAccessPairedDevice, RemoteAccessInterface, RemoteAccessStatus, RemoteAccessErrorCode, RemoteEndpointRequirement, RemoteEndpointImpact, RemoteForwardRule, RemoteEndpointPresentation, RemoteAccessLink } from "../../../../features/remote-access/client/contracts.js";
import type { RemoteAccessState } from "../../../../features/remote-access/client/contracts.js";

export interface GlobalSettingsState {
  readonly consolePortMode: "dynamic" | "static";
  readonly consoleStaticPort: number | null;
  /** 원격 접속에는 실리지 않는다. 부재는 "여기서는 다루지 않는다"는 뜻이며 화면은 섹션을 세우지 않는다. */
  readonly remoteAccess?: RemoteAccessState;
  readonly seenFeatureTours: readonly string[];
  readonly theme: ThemeId;
  /** 리퀴드 글래스 머티리얼 — 기본 옵트인(true). */
  readonly liquidGlass: boolean;
  /** 포커스하지 않은 패널 본문이 물러나는 세기(백분율, 0~70). 0은 물러나지 않음. */
  readonly unfocusedPanelFade: number;
  readonly uiFont: UiFontSettings;
  readonly language: ConsoleLanguagePreference;
  /** 실험 기능과 모델 좌석 — 구서버 응답에는 없을 수 있고, 그때는 전부 꺼짐으로 정규화한다. */
  readonly experiments: ConsoleExperimentSettings;
  /** 사용자가 바꾼 단축키만(명령 id → 조합 목록). 구서버 응답에는 없을 수 있고, 그때는 빈 객체다. */
  readonly shortcuts: ShortcutBindings;
}

export interface GlobalSettingsMutationResult {
  readonly state: GlobalSettingsState;
}

export type ApiCatalogEntry = SdkApiCatalogEntry;

export type ConnectionState = "connecting" | "live" | "offline";

export interface ControlHolder {
  readonly handle: string;
  readonly device: string | null;
  readonly openedAt: number;
}

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
  /** 이 콘솔이 스스로를 부르는 이름. 원격에서 보고 있어도 그 콘솔의 이름을 그대로 읽는다. */
  readonly consoleName: string;
  readonly connection: ConnectionState;
  readonly connectionLostAt: number | null;
  readonly controlHolder: ControlHolder | null;
  readonly controlCurtainDismissed: boolean;
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
  readonly operationRuntime: Readonly<Record<string, OperationRuntimeState>>;
  readonly operationRuntimeHydration: OperationRuntimeHydration;
  readonly operationRuntimeError: string | null;
  readonly addingTheater: boolean;
  readonly theaterError: string | null;
  readonly operationsViewActive: boolean;
  readonly operationSearchOpen: boolean;
  readonly operationSearchSeed: string | null;
  /**
   * seed가 같은 값으로 다시 와도(⌘P 두 번) 팔레트가 알아채도록 여는 요청마다 오르는 번호.
   * 팔레트는 이 번호가 바뀔 때만 seed를 입력에 반영한다.
   */
  readonly operationSearchSeedNonce: number;
  /** 팔레트가 지금 서 있는 모드. 전역 단축키가 ⌘K를 「닫기」로 볼지 「검색으로 복귀」로 볼지 가른다. */
  readonly operationSearchMode: "operations" | "commands" | null;
  readonly quickLaunchOpen: boolean;
  // 컴포저를 화면 하단에 도킹해 두는 옵트인 상태. 고정 중에는 컴포저가 상주하므로 quickLaunchOpen과
  // 무관하게 떠 있고, 모달 계약(스크림·포커스 트랩·스크롤 잠금)을 내려놓는다 — 공존이 목적이다.
  readonly quickLaunchPinned: boolean;
  // 고정 중 Mod+J가 보내는 포커스 왕복 요청. 접힘 여부는 실제 포커스에서 파생되므로 상태로 두지
  // 않고, 단축키는 "뒤집어 달라"는 요청만 남긴다(양방향 동기화로 인한 루프를 만들지 않는다).
  readonly quickLaunchFocusToggle: number;
  // 고정 중 "열어 달라"는 명시 요청(모바일 새 Operation 버튼 등). 단축키의 왕복과 달리 언제나
  // 펼쳐 포커스한다 — 펼쳐진 바에서 열기를 누른 사용자를 물러나게 하면 버튼이 거꾸로 동작한다.
  readonly quickLaunchExpandRequest: number;
  // 컴포저를 열면서 함께 건네는 행선지(Operation id). 패널 본문의 회신 버튼처럼 "이 Operation에게"
  // 라는 의도를 이미 들고 오는 진입점이 쓴다. 초안과 같은 request/consume 계약이라 컴포저가 열림
  // 전이(모달)·펼침(도킹)에서 한 번 읽고 비운다 — 남겨 두면 다음 열림이 지난 행선지를 되쓴다.
  // 시드가 있는 열림은 남은 초안을 복원하지 않는다. 닫힘의 미룸은 Mod+J 같은 일반 재오픈에만 산다.
  readonly quickLaunchMentionSeed: string | null;
  /** 멘션 시드와 함께 실리는 초안 — 시드가 주소를 잡은 직후 문면으로 들어간다(브라우저 첨부 등 플러그인 인용). */
  readonly quickLaunchMentionDraft: string | null;
  // 고정을 잠시 접어 두는 화면(설정처럼 실행이 할 일이 아닌 표면). 고정 자체는 유지되므로 화면을
  // 벗어나면 도킹이 그대로 돌아오고, 그동안 컴포저는 예전처럼 모달로만 열린다.
  readonly quickLaunchDockSuppressed: boolean;
  // 실행이 거절되면 컴포저를 이 초안과 함께 다시 연다 — 서버 거절(모델 비활성·CLI 미가용·
  // 프롬프트 전달 불가)은 컴포저가 결과를 기다리지 않는 구조라 이 경로로만 사용자에게 돌아온다.
  readonly quickLaunchDraft: string | null;
  // 초안과 함께 살아남는 첨부 자취. 텍스트만 보존하면 거절·닫힘이 방금 붙여넣은 이미지를
  // 조용히 버린다 — 파일 자체는 서버에 미발사분으로 남아 있으므로 id로 다시 실을 수 있다.
  readonly quickLaunchDraftAttachments: readonly QuickLaunchDraftAttachment[] | null;
  // 거절 사유의 서버 코드. 초안만 되살리면 결정적 실패(Windows shim 문자·FLEET_TERMINAL_CMD)는
  // 무엇을 고쳐야 하는지 모른 채 같은 Run을 반복하게 된다.
  readonly quickLaunchError: string | null;
  // 거절이 "몇 글자 줄이라"고 말할 때 그 수. 상한이 서버 쪽 argv 전체에 달려 있어 브라우저가
  // 되계산할 수 없으므로, 서버가 준 값만 싣는다.
  readonly quickLaunchErrorShortenBy: number | null;
  // 컴포저가 넘긴 실행 의도. Operations 화면이 자기 지오메트리·포커스 규율로 소비한다
  // (pendingOperationFocus와 같은 request/consume 계약).
  readonly pendingQuickLaunch: QuickLaunchRequest | null;
  readonly whatsNewOpen: boolean;
  readonly releaseNotes: readonly ReleaseNotes[];
  /** 적용된 릴리스 노트의 요청 로케일. 개별 노트는 번역 누락 시 영어로 fallback할 수 있다. */
  readonly releaseNotesLocale: ReleaseNotesLocale | null;
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
