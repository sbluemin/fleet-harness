export type { ConsoleUpdateApplyFailureProgress, ConsoleUpdateApplyFailureResponse } from "@fleet-console/protocol/lifecycle/update";
import type { ConsoleUpdateFailureStage, ConsoleUpdateFailureReason, ConsoleUpdateOldConsoleEnding } from "@fleet-console/protocol/lifecycle/update";
import type { ConsoleLifecycleWait } from "@fleet-console/protocol/lifecycle/wait";
import type { ConsoleFontSettings } from "../../../../features/settings/shared/fonts.js";
import type { ConsoleExperimentSettings } from "../../../../features/settings/shared/experiments.js";
import type { ShortcutBindings } from "../../../../features/settings/shared/shortcuts.js";
import type { ApiCatalogEntry as SdkApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { ConsoleTheme } from "../../../../features/settings/shared/theme.js";
import type { ObjectiveRuntimeHydration, ObjectiveRuntimeState } from "../../../../features/execution/shared/client-contract.js";

export type ThemeId = "dark" | "light";

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

export type CommanderSortKey = "activity" | "progress" | "remaining" | "due" | "created" | "name" | "manual";

export interface CommanderSortPreference {
  readonly key: CommanderSortKey;
  readonly direction: "asc" | "desc";
  /** 사람의 답을 기다리는 줄을 정렬과 상관없이 맨 위에 둔다. */
  readonly answerFirst: boolean;
  readonly grouped: boolean;
}

export interface CommanderFolds {
  readonly fresh: boolean;
  readonly done: boolean;
  readonly settled: boolean;
}

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
  /** 지휘관 목록 정렬. null은 settings.json에 키 없음(구서버 응답 포함)이다. */
  readonly commanderSort: CommanderSortPreference | null;
  /** 시작 전·완료 구역의 접힘. null은 settings.json에 키 없음(구서버 응답 포함)이다. */
  readonly commanderFolds: CommanderFolds | null;
  /** 사령관을 옮겨도 펼친 다른 사령관 목록을 유지하는지. null은 settings.json에 키 없음(구서버 응답 포함)이다. */
  readonly commanderKeepExpanded: boolean | null;
  /** 좌측 사이드바 사령관 아래에 시작 전·완료 목표를 보일지. null은 settings.json에 키 없음(기본 켜짐)이다. */
  readonly commanderShowSettled: boolean | null;
  readonly lowerUnfocusedFrameRate: boolean;
  /** TaskForce 사령관 말풍선 테두리를 이름 색으로 그릴지 — 구서버 응답에는 없고, 그때는 꺼짐이다. */
  readonly taskforceBubbleColor: boolean;
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
  readonly pendingSideBarAddTheater: string | null;
  readonly keyboardShortcutsOpen: boolean;
  /** 도움말 › 플릿 한눈에 보기 모션 팝업이 열려 있는가. */
  readonly fleetAtAGlanceOpen: boolean;
  /** 도움말 › 새 기능 다시보기 — 새 기능 카드 목록 전체가 순서대로 다시 떠 있는가. */
  readonly featureCardsReplayOpen: boolean;
  readonly objectiveRecordNotifications: Readonly<Record<string, ObjectiveNotification>>;
  readonly notificationPreferences: NotificationPreferences;
}
