export type { ConsoleUpdateApplyFailureProgress, ConsoleUpdateApplyFailureResponse } from "@fleet-console/protocol/lifecycle/update";
import type { ConsoleUpdateFailureStage, ConsoleUpdateFailureReason, ConsoleUpdateOldConsoleEnding } from "@fleet-console/protocol/lifecycle/update";
import type { ConsoleLifecycleWait } from "@fleet-console/protocol/lifecycle/wait";
import type { ConsoleFontSettings } from "../../../../features/settings/shared/fonts.js";
import type { ConsoleExperimentSettings } from "../../../../features/settings/shared/experiments.js";
import type { ShortcutBindings } from "../../../../features/settings/shared/shortcuts.js";
import type { ObjectiveLaunchKind } from "../../../../features/objectives/shared/records/types.js";
import type { ApiCatalogEntry as SdkApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { ConsoleTheme } from "../../../../features/settings/shared/theme.js";
import type { ObjectiveRuntimeHydration, ObjectiveRuntimeState } from "../../../../features/execution/shared/client-contract.js";

export type ThemeId = "dark" | "light";

/**
 * 새 세션 컴포저(데스크톱 화면·모바일 시트)가 확정한 실행 의도.
 *
 * `variant`는 사이드바 실행 메뉴가 쓰는 것과 같은 flat wire 레코드다 — 여기에 `prompt`가 함께 실려
 * 터미널 플러그인의 세션 생성 body로 나간다. 프롬프트는 spawn 전용 값이라 응답이나 Objective
 * payload로 되돌아오지 않는다.
 */
export interface LaunchRequest {
  readonly theaterId: string;
  readonly pluginId: string | null;
  readonly kind: ObjectiveLaunchKind;
  readonly variant: Readonly<Record<string, string>>;
  /**
   * 첨부 이미지의 컴포저측 자취. id는 variant의 `attachments` CSV로도 실려 서버에 닿고,
   * 이름·미리보기(object URL)는 실행이 거절됐을 때 칩을 되살리기 위한 브라우저 전용 값이다 —
   * 저장 경로는 어디에도 없다.
   */
  readonly attachments?: readonly LaunchDraftAttachment[];
}

/** 본문 「새 세션 화면」의 대상. 첫 메시지를 보내기 전에는 아무것도 만들지 않는다. */
export interface NewSessionTarget {
  /** 처음 고른 Theater. 등록된 Theater 가 없으면 null — 화면이 「Theater 추가…」를 먼저 세운다. */
  readonly theaterId: string | null;
}

/**
 * 새 세션 컴포저(데스크톱 화면·모바일 시트)에서 시작한 실행의 거절.
 * `draft`가 null이면 문면을 덮지 않는다(프롬프트 없는 직접 실행). `attachments`가 null이면 칩을 건드리지 않는다.
 */
export interface NewSessionRejection {
  readonly draft: string | null;
  readonly attachments: readonly LaunchDraftAttachment[] | null;
  readonly errorCode: string | null;
  readonly shortenByChars: number | null;
}

/**
 * `composer.open`이 새 세션 컴포저에 건네는 시드. `draft`는 문면을 갈아치우고(보내지 않는다), 행선지는 '@'로 고른 것과 같다.
 * 컴포저가 자기 규칙(메시지를 받는 타입인가, 입력 대기 중인가)으로 다시 판정한다.
 */
export interface NewSessionSeed {
  readonly draft: string | null;
  readonly mentionObjectiveId: string | null;
  readonly mentionTarget: import("../../../../features/execution/shared/composer-ports.js").MentionTargetAddress | null;
}

/** 컴포저 밖(거절 칸·실행 의도)을 오가는 첨부 자취. previewUrl은 브라우저 object URL이다. */
export interface LaunchDraftAttachment {
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
  /** 연결된 사령관의 읽기 전용 요약. `label`은 항상 원래 Theater 이름이다. */
  readonly commodore?: { readonly id: string; readonly alias?: string };
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
  readonly shellUpdateRequired?: boolean;
  readonly port: number;
  readonly portMode: "dynamic" | "static";
  readonly requestedPort: number | null;
  readonly effectivePort: number;
  readonly portHonored: boolean;
  readonly wikiServerStatus: "available" | "unavailable" | "unknown";
}

export type ConsoleUpdateApplyError =
  | "checksum_mismatch"
  | "console_not_ready"
  | "download_failed"
  | "local_channel"
  | "managed_runtime_update_requires_relaunch"
  | "shell_update_required"
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
  /** The worker's own words, for diagnosis. */
  readonly error?: string;
  /** How the Console the update replaced ended (the lifecycle contract's ending). */
  readonly oldConsoleOutcome?: ConsoleUpdateOldConsoleEnding;
  /** On a failure: the contract's reason, judged by the worker and the Console, never by this screen. */
  readonly reason?: ConsoleUpdateFailureReason | "unknown";
  /** On a failure: the contract's shared, path-free explanation of the reason. */
  readonly description?: string;
  readonly failureStage?: ConsoleUpdateFailureStage;
  /** Set while the update is still being checked and the Console has not been asked to stop. */
  readonly wait?: ConsoleLifecycleWait;
}

export interface ConsoleUpdateApplyAcceptedResponse {
  readonly status: "accepted" | "delegated";
}

export interface ObjectiveGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
}

export interface ObjectiveGroup {
  readonly commodoreId: string;
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly theaterId: string;
  readonly createdAt: number;
}

export interface ObjectiveRecord {
  readonly commodoreId: string;
  readonly [key: string]: unknown;
  readonly sessions?: readonly { readonly id: string; readonly [key: string]: unknown; readonly ts: { readonly createdAt: number; readonly updatedAt: number } }[];
  readonly id: string;
  readonly theaterId: string;
  readonly order?: number;
  readonly title: string;
  // 사용자 지정 accent 키(서버 영속). 미설정 시 부재. Dock 칩 perimeter 링 색의 SSoT다.
  readonly accent?: string | null;
  // 사용자 지정 그룹 id(서버 영속). null이면 Ungrouped, 미설정 시 부재(Ungrouped와 동일 취급).
  readonly groupId?: string | null;
  // 부모 sessions에서 만든 자식 표시 뷰에만 있다. 최상위 Objective에는 영속하지 않는다.
  readonly parentObjectiveId?: string;
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
  /** 사이드바에서 Objective 을 더블클릭해야 여는지 — 켜면 한 번 클릭은 선택만 한다. 기본은 꺼짐. */
  readonly sideBarDoubleClickOpen: boolean;
  readonly reduceMotion: boolean;
  /** 몽글 아바타를 차분하게 — 사람을 부르는 상태만 움직인다. 구서버 응답에는 없고, 그때는 꺼짐이다. */
  readonly calmAvatars: boolean;
  readonly lowerUnfocusedFrameRate: boolean;
  readonly uiFont: UiFontSettings;
  readonly fonts: ConsoleFontSettings;
  readonly fontsMigrationPending?: boolean;
  readonly language: ConsoleLanguagePreference;
  /** 실험 기능과 모델 좌석 — 구서버 응답에는 없을 수 있고, 그때는 전부 꺼짐으로 정규화한다. */
  readonly experiments: ConsoleExperimentSettings;
  /** 사용자가 바꾼 단축키만(명령 id → 조합 목록). 구서버 응답에는 없을 수 있고, 그때는 빈 객체다. */
  readonly shortcuts: ShortcutBindings;
  /**
   * 보관한 지 이만큼(24시간 단위) 지난 보관 Objective 묶음을 서버가 영구 삭제한다. null은 꺼짐이며,
   * 구서버 응답에서 빠졌거나 알 수 없는 값이어도 꺼짐으로 정규화한다.
   */
  readonly archiveRetentionDays: ArchiveRetentionDays;
}

export type ArchiveRetentionDays = 7 | 30 | 90 | null;

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

export interface ObjectiveNotification {
  readonly kind: NotificationKind;
  readonly objectiveId: string;
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly objectiveRecordLabel: string;
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
  /** 이 원격 세션이 회수·대체로 끝났다면 그 사유. 종착 상태에서 폴링 등 소비자가 멈출 근거다. */
  readonly controlReclaimed: "reclaimed" | "superseded" | null;
  readonly channel: ObserverStatus["channel"];
  readonly activeTheme: ConsoleTheme;
  readonly version: string;
  readonly updateAvailable: boolean;
  readonly latestVersion: string | null;
  readonly shellUpdateRequired: boolean;
  readonly portMode: "dynamic" | "static";
  readonly requestedPort: number | null;
  readonly effectivePort: number;
  readonly portHonored: boolean;
  readonly theaters: readonly TheaterInfo[];
  /**
   * 목록 표면이 쓰는 최상위 Objective — 자식은 부모의 sessions에서 파생되어 이 목록에 들지 않는다.
   * id 로 찾을 때는 `findObjective`, 부모의 구성원은 `nestedObjectiveRecordsOf` 로 명시적으로 연다.
   */
  readonly objectiveRecords: readonly ObjectiveRecord[];
  /** 부모가 대표하는 구성원 Objective — 본문 풀·본문 교체·활동 끌어올리기처럼 구성원을 봐야 하는 소비자만 읽는다. */
  readonly nestedObjectiveRecords: readonly ObjectiveRecord[];
  /** 부모 패널이 지금 어느 구성원의 본문을 보이는가(부모 id → 구성원 id). 세션 안에서만 산다 — 새로 열면 부모 자신이다. */
  readonly nestedBodySelection: Readonly<Record<string, string>>;
  readonly objectiveRecordsHydrated: boolean;
  readonly groups: readonly ObjectiveGroup[];
  readonly activeObjectiveId: string | null;
  readonly activeObjectiveAcknowledged: boolean;
  /**
   * 사이드바에서 열지 않고 고르기만 한 Objective(「더블클릭으로 열기」를 켰을 때의 한 번 클릭). 무대·카메라·활성은 그대로이고
   * 목표 같은 문맥만 이것을 따른다. 활성과 같은 값이 되면 비우며, 여는 순간(어느 경로든 활성을 세우는 순간) 사라진다.
   */
  readonly selectedObjectiveId: string | null;
  readonly objectiveRecordRuntime: Readonly<Record<string, ObjectiveRuntimeState>>;
  readonly objectiveRecordRuntimeHydration: ObjectiveRuntimeHydration;
  readonly objectiveRecordRuntimeError: string | null;
  readonly addingTheater: boolean;
  readonly theaterError: string | null;
  readonly objectiveRecordsViewActive: boolean;
  readonly objectiveRecordSearchOpen: boolean;
  readonly objectiveRecordSearchSeed: string | null;
  /**
   * seed가 같은 값으로 다시 와도(⌘P 두 번) 팔레트가 알아채도록 여는 요청마다 오르는 번호.
   * 팔레트는 이 번호가 바뀔 때만 seed를 입력에 반영한다.
   */
  readonly objectiveRecordSearchSeedNonce: number;
  /** 팔레트가 지금 서 있는 모드. 전역 단축키가 ⌘K를 「닫기」로 볼지 「검색으로 복귀」로 볼지 가른다. */
  readonly objectiveRecordSearchMode: "objectiveRecords" | "commands" | null;
  /** 모바일 「새 대화」 시트가 떠 있는가. 데스크톱 새 세션 화면(`newSession`)과 같은 실행 경로를 쓴다. */
  readonly mobileNewSessionOpen: boolean;
  /** `composer.open`이 남긴 초안·행선지. 새 세션 화면·시트가 열리며 한 번 소비한다. */
  readonly newSessionSeed: NewSessionSeed | null;
  // 컴포저가 넘긴 실행 의도. ObjectiveRecords 화면이 자기 지오메트리·포커스 규율로 소비한다
  // (pendingObjectiveFocus와 같은 request/consume 계약).
  readonly pendingLaunch: LaunchRequest | null;
  readonly whatsNewOpen: boolean;
  readonly releaseNotes: readonly ReleaseNotes[];
  /** 적용된 릴리스 노트의 요청 로케일. 개별 노트는 번역 누락 시 영어로 fallback할 수 있다. */
  readonly releaseNotesLocale: ReleaseNotesLocale | null;
  readonly releaseNotesLoading: boolean;
  readonly releaseNotesError: string | null;
  readonly releaseNotesSourceRef: "main" | null;
  readonly releaseNotesFetchedAt: number | null;
  readonly releaseNotesStale: boolean;
  readonly selectedReleaseNoteKey: string | null;
  readonly onboardingOpen: boolean;
  readonly bootstrapped: boolean;
  readonly pendingObjectiveFocus: string | null;
  readonly keyboardFocusRequest: { readonly objectiveId: string; readonly requestId: number } | null;
  readonly pendingSideBarAddTheater: boolean;
  /** 본문 「새 세션 화면」 — 사이드바 맨 위 「+」·팔레트 「New Objective」·새 세션 단축키가 연다. 첫 메시지 전에는 세션을 만들지 않는다. */
  readonly newSession: NewSessionTarget | null;
  /** 이미 열린 새 세션 화면에 「컴포저로 돌아오라」는 요청 번호. 단축키를 다시 누르면 오른다 — 화면이 이 값이 바뀔 때 포커스한다. */
  readonly newSessionFocusRequest: number;
  /** 새 세션 화면·모바일 시트가 소비하는 거절. */
  readonly newSessionRejection: NewSessionRejection | null;
  readonly keyboardShortcutsOpen: boolean;
  readonly objectiveRecordNotifications: Readonly<Record<string, ObjectiveNotification>>;
  readonly notificationPreferences: NotificationPreferences;
  readonly codexReader: CodexReaderRequest | null;
  readonly codexReaderExpanded: boolean;
}
