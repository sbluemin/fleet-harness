import type { AgentHost } from "../agent/types.js";
import type { ConsoleActionInput, ConsoleActionReceipt, ConsoleOperationObservation } from "../mcp/control.js";
import type http from "node:http";
import type { ConsoleUseMcpHost, PluginAdmiralMcpHost, PluginMcpTransport } from "../mcp/types.js";
import type { ReactNode } from "react";

import type { PaneDescriptor } from "../pane/types.js";
import type { ExpandedSurfaceDescriptor, ExpandedSurfaceOpenRequest } from "../expanded-surface/types.js";
import type { FloatingWidgetDescriptor } from "../floating/types.js";
import type { ConsoleLocale, LocalizedText } from "../i18n/types.js";
import type { ClientNotification } from "../notifications/types.js";
import type { OperationCatalogPlugin, OperationCreateInput, OperationLaunchCatalogProvider, OperationLaunchKind, OperationLaunchView, OperationNode, OperationPatchInput, OperationGeometry } from "../operations/types.js";
import type { RailEntryDescriptor, RailPanelDescriptor } from "../rail/types.js";
import type { RouteHandler, UpgradeHandler } from "../routing/types.js";
import type { NotificationKindDescriptor } from "../notifications/types.js";
import type { ConsoleExperimentSettings, ExperimentModelOption, SettingsSectionDescriptor } from "../settings/types.js";

export const PROMPT_REFINE_MAX_CHARS = 8_000;
export type PromptRefinePurpose = "launch" | "follow-up";

/**
 * 실험 기능 "프롬프트 다듬기"의 입력. 본문과 Theater 이름, 편집 의도만 넘긴다 — Operation id,
 * transcript나 경로는 이 계약에 없다. 런치 또는 멘션 대상의 소유 플러그인이 답한다.
 */
export interface PromptRefineInput {
  /** 생략한 기존 호출은 새 작업 지시문으로 다룬다. */
  readonly purpose?: PromptRefinePurpose;
  readonly prompt: string;
  readonly theaterLabel: string | null;
  readonly language: ConsoleLocale;
  readonly signal?: AbortSignal;
}

/**
 * 고쳐 쓴 초안. 코어는 사용자가 적용하기 전까지 입력창을 바꾸지 않는다. `notes`는 초안이 무엇을
 * 보탰거나 확인이 필요한지 짧게 적은 줄들이다.
 */
export interface PromptRefinement {
  readonly prompt: string;
  readonly notes: readonly string[];
}

export interface LaunchContext {
  readonly theaterId: string;
  readonly kind: OperationLaunchKind;
  readonly geometry: OperationGeometry;
  readonly operations: ClientOperationsCapability;
  readonly variant?: Readonly<Record<string, string>>;
}

export type ConsoleTheme = "instrument" | "maritime" | "carbon" | "whites";

/**
 * Operation 런타임은 두 축이다 — 축을 섞으면 한쪽이 다른 쪽을 삼킨다.
 *
 * `lifecycle`은 실행 표면이 살아 있는지를 말하고(`dormant`는 살아 있는 생산자가 하나도 없고
 * 재개 근거만 남은 상태), `activity`는 살아 있는 동안 무엇을 하는지를 말한다. 예전에는
 * `dormant`가 활동 어휘에도 있어서 활동 해석의 첫 분기를 차지했고, 그래서 PTY를 접고 SDK로
 * 이어 도는 세션(Chat Mode)의 진행 신호가 전부 그 분기에 삼켜졌다. 판별 유니온으로 갈라두면
 * "dormant인데 running" 같은 상태를 타입이 만들 수 없다.
 */
export type OperationLifecycle = "live" | "dormant";

export type OperationActivity = "idle" | "running" | "awaiting" | "background";

export type OperationRuntimeState =
  | {
    readonly lifecycle: "live";
    readonly activity: OperationActivity;
  }
  | { readonly lifecycle: "dormant" };

/**
 * 호스트가 런타임 축을 아직 신뢰할 수 없는 구간.
 *
 * `pending`은 권위 스냅샷이 도착하기 전이고, `degraded`는 스냅샷/스트림 계약이 깨져 상태를 알 수
 * 없는 구간이다. 어느 쪽도 유휴나 휴면으로 추정하지 않는다 — 이 결함의 실패 양상이 바로 "모르는
 * 것을 조용히 유휴로 말하기"였다.
 */
export type OperationRuntimeHydration = "pending" | "ready" | "degraded";

export interface TerminalTicket {
  readonly ticket: string;
  readonly ttlMs: number;
}

/**
 * Operation이 아닌 Quick Launch 행선지 하나.
 *
 * '@' 덱은 Operation 카테고리 아래에 이 기여를 `categoryLabel`별로 세운다. 호스트는 라벨의 뜻을
 * 해석하지 않는다 — 어느 플러그인의 무엇인지만 알고, 이름과 능력 문구는 그 표면을 가진 플러그인만
 * 안다.
 *
 * Operation 행선지와 달리 Theater도 활동 상태도 없다. 그래서 행은 상태 배지를 달지 않고,
 * 대신 `capabilityLabel`이 **고르기 전에** 무엇을 할 수 있는 대상인지 말한다 — 바로 윗줄의
 * Operation은 파일을 읽고 이 대상은 못 읽을 수 있어, 능력 차이를 선택 후에 알리면 늦다.
 */
export interface MentionTargetDescriptor {
  /** 플러그인 안에서 고유한 id. 호스트는 `${pluginId}:${id}`로 이름공간을 나눠 쓴다. */
  readonly id: string;
  /** 행에 보이는 이름. 사용자가 '@' 뒤에 타이핑해 거르는 값이기도 하다. */
  readonly label: string;
  /** 카테고리 밴드 문구. 같은 값을 가진 행끼리 한 카테고리로 묶인다. */
  readonly categoryLabel: string;
  /** 카테고리 머리와 행 배지에 함께 서는 짧은 능력 문구(예: "웹 전용"). */
  readonly capabilityLabel?: string;
  /** 보조 기술에 읽히는 긴 설명. 능력 한계를 여기서 완전한 문장으로 말한다. */
  readonly description?: string;
  /** 행 머리의 정체성 마크. Operation 행의 Theater 이니셜 자리와 같다. */
  readonly renderMark?: () => ReactNode;
}

/**
 * 커맨드 밴드 우측 클러스터 앞에 서는 플러그인 항목. 밴드의 24×24 버튼 문법을 따르는 것은
 * 플러그인의 책임이고, 호스트는 등록 순서대로 나란히 세울 뿐이다.
 */
export interface CommandBandEntryDescriptor {
  readonly id: string;
  readonly render: () => ReactNode;
}

export interface ClientExecutionProvider {
  readonly id: string | null;
  readonly operationKinds?: readonly OperationKindDescriptor[];
  readonly settingsSections?: readonly SettingsSectionDescriptor[];
  readonly notificationKinds?: readonly NotificationKindDescriptor[];
  /**
   * @deprecated 진입점·본문·검색·기본폭을 한 객체에 묶는 옛 계약. `railEntries` + `panes`로
   * 나눠 등록하라. 호스트는 당분간 둘 다 받아 하나의 레지스트리로 합성한다.
   */
  readonly railPanels?: readonly RailPanelDescriptor[];
  /** 우측 레일의 아이콘 진입점. 무엇을 여는지는 `panes` 또는 `activate`가 말한다. */
  readonly railEntries?: readonly RailEntryDescriptor[];
  /**
   * 표면 안의 열. 레일 표면과 확대 표면 어디에나 설 수 있고, 등록은 서로 독립이다 —
   * 어느 페인이 언제 서는지는 등록이 아니라 `panes.open` 호출이 정한다.
   */
  readonly panes?: readonly PaneDescriptor[];
  readonly floatingWidgets?: readonly FloatingWidgetDescriptor[];
  /**
   * 커맨드 밴드 우측에 서는 24px 항목. 플러그인이 자기 상태를 상단 바에 상주시키는 자리다 —
   * 호스트는 슬롯의 자리와 순서만 소유하고 본문은 플러그인이 그린다. 비어 있는 항목은 아무것도
   * 그리지 않으면(null) 자리를 차지하지 않는다.
   */
  readonly commandBandEntries?: readonly CommandBandEntryDescriptor[];
  /**
   * 캔버스를 덮는 확대 작업면. 슬롯 기하·포커스·주소는 호스트가 소유하고 플러그인은
   * 본문만 그린다. 여러 표면이 세로로 나뉘어 동시에 설 수 있다.
   */
  readonly expandedSurfaces?: readonly ExpandedSurfaceDescriptor[];
  /**
   * 다른 플러그인이 소유한 Operation 의 캡션·사이드바 칩에 얹는 표식.
   *
   * `captionActions`·`operationMarks` 는 Operation 종류의 소유자만 그린다. 그러나 "이 Operation 이 어느 목표에
   * 연결돼 있는가"처럼 Operation 을 소유하지 않는 플러그인이 아는 사실도 그 자리에 서야 한다. 호스트가 캡션의
   * 액션 무리 앞과 칩의 이름 뒤에 그린다. 그릴 것이 없으면 null 을 돌려주고, 그러면 자리도 없다.
   */
  readonly operationCaptionContributions?: readonly OperationCaptionContribution[];
  /**
   * 한 실행 구조에 묶인 Operation 들 — 뿌리(조율자) 하나와 선후 관계를 가진 구성원(단계)들.
   *
   * 그룹은 사람이 정리하는 목록이고, 묶음은 플러그인이 아는 실행 구조다. 호스트는 관계·라벨·진행만 받아 뿌리의
   * 캡션에 진척도 띠(와 단계 목록), 뿌리 패널 본문에 구성원 세션으로 바꿔 보는 노드 줄(「N 노드」, N 은 members
   * 선언 순서의 자리)을 그린다. 묶음은 그리기만 한다 — 구성원이 목록 표면에 서지 않게 하는 것은 코어의 부모 관계
   * (`OperationNode.parentOperationId`, launch 의 `parentOperationId`)이고, 진행의 진실은 플러그인 쪽에 남는다.
   * `get()` 은 바뀌지 않았으면 같은 참조를 돌려줘야 한다(useSyncExternalStore).
   */
  readonly operationClusters?: OperationClusterSource;
  /**
   * 콘솔이 살아 있는 동안 호스트가 계속 마운트해 두는 화면 없는 기여.
   *
   * rail 패널도 확대 표면도 열려 있을 때만 마운트되므로, 주소 동기화처럼 "열려 있지
   * 않아도 돌아야 하는" React 로직은 설 자리가 없다. 그런 로직을 어느 화면 안에 얹으면
   * 그 화면이 닫히는 순간 조용히 멈춘다.
   *
   * 호스트는 이 기여를 라우팅 위에서 마운트하므로 훅이 주소 변화에 반응할 수 있고,
   * 아무것도 그리지 않는 것이 정상이다(`null` 반환).
   */
  readonly persistentComponents?: readonly PersistentComponentDescriptor[];
  readonly install?: (ctx: PluginInstallContext) => void | (() => void);
  readonly launch?: (ctx: LaunchContext) => Promise<{ readonly id: string }>;
  readonly closeOperation?: (operationId: string) => void | Promise<void>;
  /**
   * Optional host→plugin resume request for a dormant Operation (e.g. a palette command).
   * Plugins without resumable sessions omit it; the host falls back to focusing the Operation.
   */
  readonly resumeOperation?: (operationId: string) => void | Promise<void>;
  /**
   * Operation types (OperationNode.type) this plugin accepts host-forwarded user
   * messages for. Quick Launch mentions list only Operations whose plugin declares
   * their type here alongside `messageOperation`.
   */
  readonly messageableOperationTypes?: readonly string[];
  /**
   * Host→plugin request to deliver user text to an Operation's live session.
   * A dormant Operation is resumed by the plugin before delivery. Optional attachment
   * ids (from `uploadLaunchAttachment`) ride along and the plugin's server composes
   * the stored file paths after the text. Rejects with an Error whose `message` is
   * the server rejection code when one is available.
   */
  readonly messageOperation?: (operationId: string, text: string, attachmentIds?: readonly string[]) => Promise<void>;
  /**
   * 지금 행선지가 될 수 있는 비-Operation 대상들. 덱이 열릴 때마다 다시 읽히므로 설정으로
   * 켜고 끈 결과가 그대로 반영된다 — 정적 배열로 두면 로스터가 마운트 시점에 굳는다.
   * 이 함수와 `messageMentionTarget`을 **함께** 선언한 플러그인의 대상만 덱에 오른다.
   */
  readonly mentionTargets?: () => readonly MentionTargetDescriptor[];
  /**
   * Host→plugin request to deliver user text to a non-Operation mention target.
   * `targetId` is the plugin-local `MentionTargetDescriptor.id`. Attachments are not
   * forwarded — the host refuses that combination before calling. Rejects with an Error
   * whose `message` is the server rejection code when one is available.
   */
  readonly messageMentionTarget?: (targetId: string, text: string) => Promise<void>;
  /**
   * Host→plugin upload of a Quick Launch image attachment. The plugin stores the bytes
   * server-side and returns an opaque id only — absolute storage paths never enter the
   * browser. The returned id rides the launch variant (`attachments`, comma-joined) and
   * the plugin's launch path forwards it to the server. Rejects with an Error whose
   * `message` is the server rejection code when one is available.
   */
  readonly uploadLaunchAttachment?: (file: Blob) => Promise<{ readonly id: string }>;
  /** Best-effort discard of an uploaded-but-unsent attachment (composer chip removal). */
  readonly discardLaunchAttachment?: (id: string) => Promise<void>;
  readonly renderLaunchIcon?: (kind: OperationLaunchKind) => ReactNode;
  /**
   * 실험 기능 "프롬프트 다듬기". 코어가 켜져 있을 때만 부르고, 답이 늦거나 없으면 조용히 수동
   * 흐름으로 남는다. 런치 또는 멘션 대상의 소유자가 선언한다.
   */
  readonly refinePrompt?: (input: PromptRefineInput) => Promise<PromptRefinement | null>;
  /** 후속 메시지 편집을 명시적으로 지원하는 Operation 타입. 생략하면 런치만 지원한다. */
  readonly promptRefineOperationTypes?: readonly string[];
  /**
   * 모델 좌석 선택지에 보태는 모델들. 코어는 Claude 별칭만 알고, Gateway에서 켠 모델은 그것을
   * 아는 플러그인이 내놓는다.
   */
  readonly experimentModelOptions?: () => Promise<readonly ExperimentModelOption[]>;
  /**
   * 맵 모드에서 명시적으로 frame 활성 선택 또는 Fleet Map 점 선택 시 호출된다.
   */
  readonly onMapOperationSelected?: (operationId: string) => void;
}

export interface FleetClientPlugin extends ClientExecutionProvider {
  readonly id: string;
}

export interface PluginInstallContext {
  readonly api: ClientApiCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly terminal: ClientTerminalCapability;
  readonly notifications: ClientNotificationsCapability;
  readonly operations: ClientOperationsCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly settings: ClientSettingsCapability;
  readonly runtime: ClientOperationRuntimeCapability;
  readonly statusDetail: ClientOperationStatusDetailCapability;
  readonly composer: ClientComposerCapability;
  readonly surfaces: ClientExpandedSurfacesCapability;
  readonly consoleState: ClientConsoleStateCapability;
  readonly navigation: ClientNavigationCapability;
  readonly rail: ClientRailCapability;
  readonly consoleEvents: ClientConsoleEventsCapability;
  readonly experiments: ClientExperimentsCapability;
}

/**
 * 실험 기능 설정의 읽기. 설정 자체는 코어 general 설정이고 소유자도 코어다 — 플러그인은 무엇이
 * 켜져 있고 어느 좌석에 무엇이 앉았는지만 읽는다. 아직 읽히지 않았으면 null이며, 그때는 전부
 * 꺼진 것으로 다뤄야 한다(옵트인의 기본은 꺼짐).
 */
export interface ClientExperimentsCapability {
  read(): ConsoleExperimentSettings | null;
  subscribe(listener: () => void): () => void;
  /** 설정 저장 — 코어의 general 설정 한 필드를 통째로 바꾼다. 플러그인은 자기 행만 고쳐 넘긴다. */
  update(next: ConsoleExperimentSettings): Promise<boolean>;
  /**
   * 코어가 experiments 필드를 지금 저장 중인지. 같은 필드의 겹친 저장은 코어가 거절하므로(false),
   * 플러그인 행은 이 동안 자기 컨트롤을 잠가 눌린 값이 조용히 버려지는 일을 막는다.
   */
  saving(): boolean;
  /** 모델 선택지 — Claude 별칭 + 등록된 플러그인이 내놓는 Gateway 모델. 플러그인 카드가 자기 행의 선택기에 쓴다. */
  modelOptions(): Promise<readonly ExperimentModelOption[]>;
}

/**
 * 상주 기여가 받는 콘솔 전역 사실. 패널이 하나도 열려 있지 않아도 참이어야 하는 것들이다 —
 * 로케일·테마는 열린 화면의 속성이 아니라 콘솔의 속성이므로, 화면을 통해서만 전해지면
 * 아무 화면도 없을 때 플러그인은 기본값에 갇힌다.
 */
export interface PersistentComponentContext {
  readonly language?: ConsoleLocale;
  readonly theme?: ConsoleTheme;
}

/** 화면 없는 상주 기여. 호스트가 콘솔 수명 동안 마운트해 둔다. */
export interface PersistentComponentDescriptor {
  readonly id: string;
  readonly render: (ctx: PersistentComponentContext) => ReactNode;
}

export interface ClientConsoleEventsCapability {
  /**
   * 콘솔 공용 스트림에서 이 채널의 프레임을 받는다. 서버 쪽 `registerSseChannel`의 짝이며,
   * 올린 채널만 브라우저까지 온다. 받는 쪽이 없으면 프레임은 조용히 버려진다.
   */
  subscribe(channel: string, onEvent: (payload: unknown) => void): () => void;
}

export interface ClientRailCapability {
  /** rail 패널을 펼친다. 공유 링크로 들어온 플러그인이 자기 패널을 세울 때 쓴다. */
  open(panelId: string): void;
  /** 지정한 패널이 현재 활성 상태일 때만 닫는다. */
  close(panelId: string): void;
  /** 지정한 패널이 현재 레일 슬롯에 서 있는가. */
  isOpen(panelId: string): boolean;
}

export interface ClientApiCapability {
  fetch(pluginId: string | null, path: string, init?: RequestInit): Promise<Response>;
  subscribe(pluginId: string | null, path: string, onMessage: (event: MessageEvent<string>) => void): () => void;
  resync(): void;
}

export interface ClientLifecycleCapability {
  onDispose(cleanup: () => void): () => void;
}

export interface ClientTerminalCapability {
  requestTicket(pluginId: string, path: string, operationId: string, signal?: AbortSignal): Promise<TerminalTicket>;
}

export interface ClientNotificationsCapability {
  emit(notification: ClientNotification): void;
  dismiss(id: string): void;
}

export interface ClientOperationRuntimeCapability {
  set(operationId: string, state: OperationRuntimeState): void;
  clear(operationId: string): void;
  /**
   * 이 플러그인이 소유한 Operation들의 런타임 축을 신뢰할 수 있는지 보고한다. `degraded`는
   * 상태를 모른다는 뜻이지 유휴라는 뜻이 아니므로, 호스트는 이 구간에서 활동을 추정하지 않는다.
   */
  setHydration(state: OperationRuntimeHydration, error?: string): void;
}

export interface ClientOperationStatusDetailCapability {
  set(operationId: string, detail: string): void;
  clear(operationId: string): void;
}

export interface ClientComposerCapability {
  /**
   * Brings up the host composer and puts the caret in it. Whether that is the modal or the docked
   * bar is the host's business, not the plugin's.
   *
   * `mentionOperationId` addresses the composer at that Operation, exactly as typing an `@` mention
   * does. The host still applies its own addressing rules — an Operation that cannot be messaged,
   * or is waiting on its own prompt, is left unaddressed. A mention seed starts a fresh address:
   * leftover unsent draft from a previous close is discarded, not preserved across this open.
   *
   * `draft` seeds the prompt text instead — used to hand a plugin's text (an aide's answer, a
   * snippet) to the composer. It replaces any unsent draft; it never submits.
   */
  open(options?: { readonly mentionOperationId?: string; readonly draft?: string }): void;
}

export interface ClientOperationsCapability {
  create(input: { readonly theaterId: string; readonly type: string; readonly pluginId: string | null; readonly title: string; readonly payload?: Record<string, unknown>; readonly geometry?: OperationGeometry | null }): Promise<OperationNode>;
  rename(operationId: string, title: string): Promise<OperationNode>;
  remove(operationId: string): Promise<void>;
  /** 그 Operation 으로 간다 — 활성으로 세우고, 접혀 있으면 펴고, 키보드 초점을 준다. 어느 모드에서든 호스트가 자리를 정한다.
   * `snap: "full"` 은 Cruise 화면에서 Snap 전체 칸으로 앉힌다 — 스냅할 수 없는 모드·화면에서는 같은 일반 이동으로 폴백한다. */
  focus(operationId: string, options?: { readonly snap?: "full" }): void;
}

/**
 * 확대 표면을 여닫는 능력. 슬롯 목록·기하·포커스는 호스트가 소유하므로 플러그인은
 * "이걸 열어 달라"고 요청할 뿐이고, 어느 슬롯에 어떤 폭으로 서는지는 결정하지 못한다.
 */
/**
 * 콘솔 상태 중 플러그인이 알아도 되는 몫.
 *
 * 스토어 전체를 넘기지 않는다 — 넘기면 플러그인이 코어의 내부 형태에 결합되고,
 * 그 형태를 바꿀 때마다 플러그인이 깨진다. Theater 목록과 활성 Theater는 플러그인이
 * 자기 데이터를 어느 프로젝트 기준으로 읽을지 정하는 데 필요한 최소값이다.
 */
export interface ClientConsoleStateCapability {
  getTheaters(): readonly ConsoleTheaterSummary[];
  /**
   * Operation 목록의 브라우저 DTO 몫 — 제목·Theater·종류·활동. 활동은 코어가 런타임 축에서 읽는
   * 값이며, 어느 플러그인이 그 축의 권위인지는 플러그인이 알 필요가 없다. transcript·경로는 없다.
   * 사이드바와 같은 목록이라 부모가 대표하는 구성원(`parentOperationId`)은 빠진다 — 구성원을 거느리는
   * 플러그인만 `{ nested: true }` 로 함께 읽는다.
   */
  getOperations(options?: { readonly nested?: boolean }): readonly ConsoleOperationSummary[];
  getActiveTheaterId(): string | null;
  setActiveTheater(theaterId: string): void;
  subscribe(listener: () => void): () => void;
}

export interface ConsoleTheaterSummary {
  readonly id: string;
  readonly label: string;
}

export interface ConsoleOperationSummary {
  readonly id: string;
  readonly theaterId: string;
  readonly type: string;
  readonly title: string;
  readonly activity: "idle" | "running" | "awaiting" | "background" | "ended";
  /** `{ nested: true }` 로 읽은 구성원만 — 이 Operation 을 대표하는 부모. */
  readonly parentOperationId?: string;
  /**
   * `{ nested: true }` 로 읽은 부모(구성원을 거느린 Operation)만 — 구성원의 대기·실행을 끌어올리기 전 자기 활동이다.
   * 부모 자신의 대기·실행을 구성원 것과 가를 때 쓴다(`ownActivity ?? activity`). `activity` 와 같은 규칙으로 센다.
   */
  readonly ownActivity?: "idle" | "running" | "awaiting" | "background" | "ended";
}

/**
 * 주소 표시줄의 쿼리 문자열 중 플러그인 몫.
 *
 * 라우터 자체를 넘기지 않는다 — 경로는 코어 화면의 것이고, 플러그인이 그것을 옮기면
 * 콘솔이 어디 있는지를 플러그인이 정하게 된다. 쿼리 파라미터만 읽고 쓴다.
 */
export interface ClientNavigationCapability {
  getSearchParam(key: string): string | null;
  /** `null` 값은 그 파라미터를 지운다. `replace`는 뒤로가기 기록을 남기지 않는다. */
  setSearchParams(next: Readonly<Record<string, string | null>>, options?: { readonly replace?: boolean }): void;
  subscribe(listener: () => void): () => void;
}

export interface ClientExpandedSurfacesCapability {
  /** 표면을 연다. 이미 열려 있으면 기본적으로 그 슬롯을 재사용한다. 인스턴스 id를 돌려준다. */
  open(request: ExpandedSurfaceOpenRequest): string;
  /** 슬롯 하나를 닫는다. `open`이 돌려준 **인스턴스** id를 넘길 것 — 표면 id가 아니다. */
  close(instanceId: string): void;
  /**
   * 이 표면의 슬롯을 전부 닫는다. 플러그인은 대개 자기 인스턴스 id를 들고 있지 않고
   * "내 표면을 닫는다"만 원하므로, 표면 id로 닫는 길을 따로 둔다 — 표면 id를 `close`에
   * 넘기면 일치하는 인스턴스가 없어 조용히 아무 일도 일어나지 않는다.
   */
  closeSurface(surfaceId: string): void;
  /** 이 표면이 지금 슬롯을 차지하고 있는지. */
  isOpen(surfaceId: string): boolean;
}

export interface ClientPreferencesCapability {
  read<T>(key: string, fallback: T): T;
  write<T>(key: string, value: T): void;
}

export interface ClientSettingsCapability {
  read(pluginId: string | null): Promise<Record<string, unknown> | null>;
  write(pluginId: string | null, value: Record<string, unknown>): Promise<void>;
}

export interface UseOperationsResult {
  readonly operations: readonly OperationNode[];
  readonly refresh: () => Promise<void>;
}

export interface OperationCaptionContributionContext {
  readonly operation: OperationNode;
  readonly language: "en" | "ko";
  /** 캔버스 캡션(넓은 칩)인지 사이드바 칩(12px 표식)인지. */
  readonly surface: "caption" | "chip";
}

export interface OperationCaptionContribution {
  readonly id: string;
  readonly render: (context: OperationCaptionContributionContext) => ReactNode;
}

/** 구성원(단계)의 진행 — 세션 활동이 아니라 구조 안의 자리다. 막힘은 선행이 안 끝난 것, 열림은 시작을 기다리는 것. */
export type OperationClusterProgress = "blocked" | "open" | "running" | "awaiting" | "done";

export interface OperationClusterMember {
  /**
   * 구성원의 Operation id. `pending` 이면 아직 Operation 이 없는 자리표시 id 다(플러그인 안에서 안정적이면 된다) —
   * 호스트는 띠(단계 사각)·진행 셈에만 쓰고 행·패널·본문 선택에는 세우지 않는다.
   */
  readonly operationId: string;
  readonly pending?: boolean;
  /** 묶음 안에서 제목 대신 부르는 짧은 이름("1. package.json name 읽기"). */
  readonly label: string;
  /**
   * 지휘관 패널의 노드 줄에 서는 이름("조사") — 이 세션이 누구인지 한 낱말로. 없으면 호스트가 선언 순서로 「N 노드」라 부른다.
   * `label`(무엇을 하는지)은 말풍선·낭독에 그대로 남는다. 지휘관 패널이 이 구성원의 본문을 보일 때 캡션 제목 뒤 「› 이름」도 이것이다.
   */
  readonly name?: string;
  /**
   * 이 구성원의 정체성 톤(`--id-<key>` 의 key, 예: "moss") — 지휘관 캡션 제목 뒤 「› 이름」의 잉크. 플러그인이 자기 화면의 구성원
   * 표식과 같은 톤을 준다. 없으면 구성원 Operation 의 강조색, 그것도 없으면 제목의 중립 잉크다.
   */
  readonly tone?: string;
  /** 명단(roster) 순서(0부터 시작). 세션 줄에서 명단 순서로 정렬할 때 사용한다. */
  readonly order?: number;
  /** 선행 구성원의 operationId. 전부 끝나야 이 구성원이 열린다. */
  readonly after: readonly string[];
  readonly progress: OperationClusterProgress;
  /** 살아 있는 구성원 세션의 입력·결정 대기. 임무 진행(done/blocked)과 별개이며, 생략 시 옛 progress awaiting만 사용한다. */
  readonly awaitingInput?: boolean;
  /** 끝난 구성원이 남긴 산출 요약 한 줄 — War Room 무대가 직전 단계의 것을 보여준다. */
  readonly result?: string;
}

export interface OperationCluster {
  /** 플러그인 안에서 유일한 id. 호스트가 `<pluginId>:` 를 앞에 붙인다. */
  readonly id: string;
  readonly theaterId: string;
  /** 묶음의 제목(목표 제목) — 툴팁과 War Room 위치 표시에 선다. */
  readonly title: string;
  /** 뿌리(조율자) operationId. 뿌리는 구성원 목록에 들지 않는다. */
  readonly root: string;
  readonly members: readonly OperationClusterMember[];
  /** 띠·위치 표시를 누르면 — 플러그인의 표면으로 간다. 구성원 id 가 오면 그 구성원을 집는다. */
  readonly open?: (operationId?: string) => void;
}

export interface OperationClusterSource {
  readonly subscribe: (listener: () => void) => () => void;
  readonly get: () => readonly OperationCluster[];
}

export interface OperationKindDescriptor {
  readonly pluginId: string | null;
  readonly type: string;
  readonly title: LocalizedText;
  readonly subtitle?: (operation: OperationNode) => string | undefined;
  readonly render?: (context: OperationRenderContext) => ReactNode;
  /**
   * Fills the caption band's action shelf, left of the host's own menu and window controls.
   * The band stays host-owned exactly as it does for a companion panel's `caption`: the host
   * places the shelf, paints the surface, and drops it entirely on a War Room deck tile, where a
   * card body is inert and its controls would be a false promise. Build the buttons with
   * `@fleet-console/sdk/components/caption-actions` so one band cannot carry two grammars.
   */
  readonly captionActions?: (context: OperationRenderContext) => ReactNode;
  /**
   * Fills the top of the host's Operation menu — the same card the caption's ··· button, the
   * sidebar's right-click and a War Room card all open. The host owns the card, its grouping and
   * accent sections and keyboard travel; this section stands first, above them, and is followed by
   * the host's divider. Rows are `button.group-context-menu-item` with a `menuitem*` role so the
   * host's arrow-key travel and Escape reach them. Keep it to per-Operation switches and readouts
   * that belong to this Operation; nothing here may open another surface without closing the menu.
   */
  readonly operationMenu?: (context: OperationMenuContext) => ReactNode;
  /**
   * Small marks the host shows on this Operation's sidebar chip, after its name — the standing
   * facts about this Operation worth reading in a list (a capability it has been granted, say),
   * never activity, which the host's own beacon already owns. Return nothing when there is
   * nothing to mark. Each mark is a 12px glyph the host tints; give it a `title`.
   */
  readonly operationMarks?: (context: OperationMenuContext) => ReactNode;
  /**
   * Current height in panel pixels of fixed bottom chrome this body always paints below its live
   * content (e.g. an agent CLI's input composer and status lines). A host preview that crops the
   * body may push that band out of frame so the live area fills the preview. The host reads it
   * each time it builds a preview, so a band that follows a user preference (a terminal font size,
   * say) reports its height at that moment. Omit it when the body streams all the way to its
   * bottom edge, as a bare terminal does.
   */
  readonly previewBottomChrome?: () => number;
  readonly companions?: readonly CompanionPanelDescriptor[];
  readonly canOpenCompanions?: (context: OperationCompanionAvailabilityContext) => boolean | Promise<boolean>;
}

export interface OperationCompanionAvailabilityContext {
  readonly api: ClientApiCapability;
  readonly operation: OperationNode;
}

export interface CompanionPanelShortcut {
  /** Physical KeyboardEvent.code; the host always combines it with Alt. */
  readonly code: string;
  /** Key label shown in the host shortcut help, e.g. "A". */
  readonly label: string;
  /** Sibling companion panel ids closed together with this one; the target is always included. Opening reveals the target and leaves every other panel at its own default visibility, matching what a panel's own open control does. */
  readonly clusterIds?: readonly string[];
}

export interface CompanionPanelDescriptor {
  readonly id: string;
  readonly title: LocalizedText;
  readonly hideCaption?: boolean;
  readonly defaultHidden?: boolean;
  readonly shortcut?: CompanionPanelShortcut;
  /**
   * Omitted means always available. An unavailable panel is not rendered, carries no keyboard shortcut,
   * and is absent from shortcut help, while the host still reports its id through `hiddenCompanionPanelIds`
   * so plugin-side visibility checks stay correct.
   */
  readonly available?: (operation: OperationNode) => boolean;
  /**
   * Fills the caption band. The band itself stays host-owned — its geometry, surface, rim, and the frame's
   * top corners — exactly as the body slot is host-owned and plugin-filled; omitted renders the host's
   * dot and localized title. Ignored when `hideCaption` is set, which leaves the frame headless.
   */
  readonly caption?: (context: OperationRenderContext) => unknown;
  readonly render: (context: OperationRenderContext) => unknown;
}

export interface OperationContext {
  readonly operationId: string;
  readonly theaterId: string;
  readonly pluginId: string | null;
  readonly type: string;
}

/** What an Operation menu section knows: the Operation as the host sees it, the UI language, and how to close the card. */
export interface OperationMenuContext {
  readonly operation: OperationNode;
  readonly language: "en" | "ko";
  readonly onClose: () => void;
}

export interface OperationRenderContext extends OperationContext {
  readonly active: boolean;
  /**
   * Requests DOM keyboard focus for the current Operation's primary body.
   * This is not canvas position, active state, or persistent state: a changed value means a new focus request.
   * `undefined` denotes an older host and `0` denotes no request; consumers must only detect change, not compare order.
   * Plugins cannot increment this host-owned value themselves.
   */
  readonly keyboardFocusRequestId?: number;
  readonly geometry: OperationGeometry;
  readonly operation: OperationNode;
  readonly zoom: number;
  readonly theme: ConsoleTheme;
  readonly language?: "en" | "ko";
  readonly api: ClientApiCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly terminal: ClientTerminalCapability;
  readonly notifications: ClientNotificationsCapability;
  readonly operations: ClientOperationsCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly settings: ClientSettingsCapability;
  readonly runtime: ClientOperationRuntimeCapability;
  readonly statusDetail: ClientOperationStatusDetailCapability;
  readonly composer: ClientComposerCapability;
  /**
   * 호스트가 이 Operation에 대해 해소한 런타임 축. `null`은 권위 스냅샷 도착 전이거나 축이
   * degraded라는 뜻이며, live/dormant 추정값이 아니다 — 패널 본문이 자기 진행 상태를 별도로
   * 판단하지 않고 이 값 하나를 읽어야 사이드바와 본문이 갈라지지 않는다.
   */
  readonly runtimeState: OperationRuntimeState | null;
  /**
   * Whether this body is on a surface the user can read. `undefined` is an older
   * host and must be treated as live. `false` is a parked, minimized, or hidden
   * body: the plugin must not hold a dedicated HTTP stream for it. A War Room
   * deck tile stays live — its body is painted, even while inert.
   */
  readonly bodyLive?: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  /** Requests host-owned companion panels without exposing Canvas implementation to plugins. */
  readonly onRequestCompanions?: (open: boolean) => void;
  readonly companionsOpen?: boolean;
  /** Host-owned effective companion visibility; `undefined` denotes a host without per-panel visibility support. */
  readonly hiddenCompanionPanelIds?: readonly string[];
  /** Requests a volatile host-owned visibility override for one companion panel. */
  readonly onSetCompanionPanelVisible?: (companionPanelId: string, visible: boolean) => void;
}

export interface FleetPluginManifest {
  /**
   * 이 플러그인이 소유할 콘솔 수준 경로 한 칸(`/console/<prefix>`).
   *
   * 기본적으로 플러그인 라우트는 `/plugins/<id>` 안에 갇힌다. 사용자가 주고받는
   * 링크를 가진 표면은 그 안에 살 수 없다 — 주소가 구현 위치를 드러내고, 플러그인을
   * 옮기는 순간 이미 공유된 링크가 전부 깨진다. 그래서 선언한 플러그인에만 한 칸을
   * 내주고, 겹치면 등록이 거절된다.
   */
  readonly consoleRoutePrefix?: string;
  readonly id: string;
  readonly apiVersion?: number;
  readonly name?: string;
  readonly client?: string;
  readonly routes?: string;
  readonly sensitiveFields?: readonly string[];
}

export interface FleetPluginDefinition {
  readonly id: string;
  readonly name?: string;
  readonly register?: (ctx: FleetPluginServerContext) => void | Promise<void>;
}

export interface FleetPluginRouteModule {
  readonly register?: (ctx: FleetPluginServerContext) => void | Promise<void>;
  readonly default?: FleetPluginRouteExport;
}

export type FleetPluginRouteExport =
  | ((ctx: FleetPluginServerContext) => void | Promise<void>)
  | { readonly register?: (ctx: FleetPluginServerContext) => void | Promise<void> };

export type ApiCatalogMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
export type ApiCatalogGate = "loopback" | "origin-write" | "origin-strict" | "lock-token" | "anthropic-credential" | "one-use-ticket";
export type ApiCatalogTransport = "http" | "sse" | "websocket" | "proxy";

export interface ApiCatalogEntry {
  readonly method: ApiCatalogMethod;
  readonly path: string;
  readonly summary: string;
  readonly category: string;
  readonly gate: ApiCatalogGate;
  readonly transport: ApiCatalogTransport;
}

export interface FleetPluginServerContext {
  readonly pluginId: string;
  readonly manifest: FleetPluginManifest;
  readonly basePath: string;
  readonly wsBasePath: string;
  readonly host: FleetPluginHostCapabilities;
  registerRouter(path: string, handler: RouteHandler): void;
  registerRouter(path: string, handler: RouteHandler, catalog: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
  registerWsHandler(path: string, handler: UpgradeHandler): void;
  registerWsHandler(path: string, handler: UpgradeHandler, catalog: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
}

export interface FleetPluginHostCapabilities {
  readonly agent: AgentHost;
  readonly consoleUse: ConsoleUseMcpHost;
  readonly admiralMcp: PluginAdmiralMcpHost;
  readonly mcpTransport?: PluginMcpTransport;
  readonly operations: FleetPluginOperationsHost;
  readonly events: FleetPluginEventsHost;
  readonly paths: FleetPluginPathsHost;
  readonly server: FleetPluginServerHost;
  readonly storage: FleetPluginStorageHost;
  readonly http: FleetPluginHttpHost;
  readonly security: FleetPluginSecurityHost;
  readonly lifecycle: FleetPluginLifecycleHost;
  readonly theaterFlags: FleetPluginTheaterFlagsHost;
  /** Console Use 와 같은 길로 Operation 을 시작·메시지하는 능력. 없는 호스트에서는 없다. */
  readonly consoleControl?: FleetPluginConsoleControlHost;
  /**
   * 실험 설정 읽기. 이 능력이 없는 호스트(구버전·테스트 스텁)에서는 전부 꺼진 것으로 읽어야 한다 —
   * 옵트인의 부재는 꺼짐이다.
   */
  readonly experiments?: FleetPluginExperimentsHost;
}

/** 서버 쪽 실험 설정 읽기 — 저장값을 매번 읽으므로 설정을 바꾼 직후의 요청부터 새 값을 본다. */
export interface FleetPluginExperimentsHost {
  read(): ConsoleExperimentSettings;
  /**
   * 저장 직후 호출된다. 요청마다 읽지 않는 상주 작업(감시자·타이머)이 옵트인 전환을 놓치지 않게
   * 하는 통로다 — 없는 호스트에서는 다음 읽기까지 옛 값이 유효하다.
   */
  subscribe?(listener: (settings: ConsoleExperimentSettings) => void): () => void;
}

export interface FleetPluginServerHost {
  /**
   * Console이 실제로 리슨 중인 loopback origin. 리슨 확정 전에는 null.
   * 자식 프로세스에 Console 주소를 넘겨야 하는 플러그인이 포트를 추측하지 않도록 한다.
   */
  origin(): string | null;
}

export type FleetPluginSidebarPosition = "first" | "last" | { readonly before: string } | { readonly after: string };

export interface FleetPluginOperationsHost {
  list(): readonly OperationNode[];
  get(id: string): OperationNode | null;
  create(input: OperationCreateInput): OperationNode;
  patch(id: string, input: OperationPatchInput): OperationNode | null;
  delete(id: string): boolean;
  /** 같은 Theater·사이드바 그룹 안에서 순서를 바꾼다. unknown_operation, mixed_sections, unknown_anchor는 오류로 던진다. */
  reorder?(input: { readonly theaterId: string; readonly operationIds: readonly string[]; readonly position: FleetPluginSidebarPosition; readonly groupId: string | null }): { readonly operationIds: readonly string[]; readonly groupId: string | null; readonly members: readonly string[] };
  registerOperationType(type: string): () => void;
  registerPayloadSanitizer(pluginId: string, fields: readonly string[]): () => void;
  registerLaunchCatalog(pluginId: string, provider: OperationLaunchCatalogProvider): () => void;
  /**
   * Operation 그룹 — 사이드바가 Operation 을 묶는 그 그룹이다. 플러그인이 자기 목록을 따로 두는 대신 이 그룹을
   * 그대로 목록으로 쓸 수 있도록 연다. 만들기·이름·색은 사람의 PATCH 와 같은 길을 지나 영속되고
   * `group:changed` / `group:removed` 로 모든 브라우저에 닿는다. 없는 호스트(구버전·테스트 스텁)에서는 없다.
   * Operation 이 그룹을 옮기면(누가 옮겼든) 서버 안 채널 `operation:grouped`(`OperationGroupedEvent`)가 난다.
   */
  readonly groups?: FleetPluginOperationGroupsHost;
}

export interface FleetPluginOperationGroup {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly theaterId: string;
  readonly createdAt: number;
}

export interface FleetPluginOperationGroupsHost {
  list(theaterId?: string): readonly FleetPluginOperationGroup[];
  get(id: string): FleetPluginOperationGroup | null;
  create(input: { readonly theaterId: string; readonly name: string; readonly color: string; readonly order?: number }): FleetPluginOperationGroup;
  patch(id: string, input: { readonly name?: string; readonly color?: string; readonly order?: number }): FleetPluginOperationGroup | null;
  /** 빈 그룹만 지운다 — 멤버가 있으면 false. */
  delete(id: string): boolean;
}

/**
 * Console Use 와 같은 제어 경로로 Operation 을 시작하거나 그 입력창에 메시지를 넣는 능력. 호출자는 이 플러그인
 * 자신이며(`{ kind: "plugin", pluginId }`), 시작한 Operation 의 `payload.launchedBy` 에 그렇게 남는다. 시트를 거치지
 * 않는다 — `console_launch` 가 쓰는 서버 경로 그대로다. 없는 호스트에서는 없다.
 */
export interface FleetPluginConsoleControlHost {
  /** 접수 뒤 실행 결과(operationId 또는 실패)가 정해질 때까지 기다린다. 실패는 코드 문자열을 message 로 던진다. */
  request(input: ConsoleActionInput, requestId?: string): Promise<ConsoleActionReceipt>;
  /** 한 Operation 의 지금 관측 — 활동·생명주기·표면·마지막 산출. 모르면 null. */
  observe(operationId: string): ConsoleOperationObservation | null;
  /**
   * 유휴 Agent Operation을 휴면으로 보낸다. 진행 중이면 not_idle; ending이면 전이가 진행 중이므로 재관측한다.
   * `endPendingWork` 는 interrupt 로 풀 수 없는 두 상태도 재운다 — 사람의 답을 기다리는 터미널 세션은 떠 있던 질문·허가 요청을 버리고,
   * 백그라운드 작업이 남은 세션은 그 작업을 끝낸다. 사람이 그 작업의 종결을 결정한 경우에만 쓴다. 실행 중인 턴은 여전히 not_idle 이다.
   */
  sleep?(operationId: string, options?: { readonly endPendingWork?: boolean }): Promise<{ readonly ok: true; readonly lifecycle: "dormant" | "ending" } | { readonly ok: false; readonly error: string }>;
  /**
   * 이미 있는 Operation의 다음 프로세스 기동(휴면 재개·채팅을 새로 띄우는 실행)에 쓸 서브에이전트 정책.
   * live 프로세스는 중단하지 않고, 세션 스냅샷도 바꾸지 않는다. 없는 Operation은 무시한다.
   * `blocked`는 강제 차단, `default`는 그 차단을 걷고 전역 정책만 적용한다.
   */
  setSubagentSpawn?(operationId: string, policy: "blocked" | "default"): void;
  /**
   * 이미 있는 Operation의 사람 질문(`AskUserQuestion`) 정책. 다음 기동부터 도구 목록에 반영되고, 살아 있는 채팅 세션은
   * 남은 질문 호출을 카드 없이 거절한다. 떠 있는 터미널 프로세스는 중단하지 않는다. 없는 Operation은 무시한다.
   */
  setUserQuestions?(operationId: string, policy: "blocked" | "default"): void;
  /**
   * 이 플러그인의 멱등 기동 키(`ConsoleActionInput.launchKey`) 상태 — absent(영속된 적 없음) · reserved(예약만) · pending(이 호스트에서
   * 기동 중) · live · deleting(삭제 유예) · purged. 다른 Theater 에 선 키는 `launch_key_conflict` 로 거절하고 그 Operation 을
   * 드러내지 않는다. 원장을 읽을 수 없으면 `storage_unavailable` 을 던진다(absent 로 추측하지 않는다).
   */
  launchState?(input: { readonly theaterId: string; readonly key: string }): { readonly state: "absent" | "reserved" | "pending" | "live" | "deleting" | "purged"; readonly operationId?: string };
  /**
   * 키들을 한꺼번에 예약한다(전부 또는 전무) — 새 키만 용량을 쓰고, 넘치면 `launch_key_capacity`. 수락한 키는 만료하지 않으며
   * 그 키의 삭제 기록·조회·같은 키 재기동은 용량과 무관하다.
   */
  reserveLaunchKeys?(input: { readonly theaterId: string; readonly keys: readonly string[] }): void;
  /** 이 플러그인이 쓴 키 수와 상한. */
  launchKeyUsage?(): { readonly used: number; readonly limit: number };
}

/**
 * Theater DTO에 플러그인이 실을 수 있는 플래그.
 *
 * 코어가 `hasWiki` 같은 필드를 직접 계산하면, 그 지식을 소유한 플러그인이 빠져도
 * 필드는 남아 거짓을 말한다. 소유자가 채우고, 없으면 필드도 없다.
 */
export interface FleetPluginTheaterFlagsHost {
  register(flag: string, resolve: (theaterId: string) => boolean): () => void;
}

export interface FleetPluginEventsHost {
  publish(channel: string, payload: unknown): void;
  subscribe(channel: string, listener: (payload: unknown) => void): () => void;
  registerSseChannel(channel: string): () => void;
}

/** 한 프로젝트 경로에 딸린, 플러그인이 쓸 수 있는 데이터 디렉터리. */
export interface PluginWorkspaceDirectory {
  /** 이 워크스페이스의 데이터가 사는 절대 경로. */
  readonly path: string;
  /** 경로를 정규화해 얻은 안정적인 식별자. 같은 프로젝트는 항상 같은 값이다. */
  readonly id: string;
}

export interface FleetPluginPathsHost {
  /**
   * Fleet 데이터 루트. 호스트 공용 디렉터리(`desktop/`·`computer-use/`)가 사는 자리다.
   * 사용자가 Console에서 고르는 값은 여기가 아니라 `consoleDataDir`에 산다.
   */
  readonly fleetDataDir: string;
  /**
   * 이 Console 인스턴스의 슬롯. 설정·자격증명·워크스페이스처럼 그 인스턴스와 수명을
   * 같이하는 것이 사는 자리이고, 채널·체크아웃·override마다 다르다.
   */
  readonly consoleDataDir: string;
  pluginDataDir(pluginId: string): string;
  resolveTheaterPath(theaterId: string): string | null;
  canonicalizeTheaterPath(cwd: string): string;
  workspaceHash(canonicalCwd: string): string;
  /**
   * 한 프로젝트 경로의 워크스페이스 디렉터리를 만들어 준다(있으면 그대로).
   *
   * 플러그인이 직접 만들면 이름 규칙과 정체성 파일이 호스트와 갈라져, 같은 프로젝트가
   * 두 디렉터리로 나뉜다.
   */
  ensureWorkspaceDirectory(cwd: string): PluginWorkspaceDirectory;
  /**
   * 디렉터리 단위 배타 실행. 같은 저장소를 두 프로세스가 동시에 옮기는 것을 막는다
   * (마이그레이션·압축처럼 중간 상태가 읽히면 안 되는 작업).
   */
  withDirectoryLock<T>(lockDir: string, operation: () => T): T;
}

export interface FleetPluginStorageHost {
  readJson(pluginId: string, key: string): Promise<unknown>;
  writeJson(pluginId: string, key: string, value: unknown): Promise<void>;
}

export interface FleetPluginHttpHost {
  writeJson(res: http.ServerResponse, status: number, payload: unknown): void;
  readJsonBody<T>(req: http.IncomingMessage): Promise<T | null>;
  /**
   * 플러그인이 HTML이나 자산을 직접 쓸 때 얹는 보안 헤더.
   *
   * 목록을 플러그인이 각자 적으면 언젠가 하나가 빠지고, 그 하나가 빠진 응답만
   * 스크립트를 실행할 수 있게 된다. 호스트가 한 벌로 소유한다.
   */
  securityHeaders(extra?: Readonly<Record<string, string>>): Record<string, string>;
}

export interface FleetPluginSecurityHost {
  /**
   * 요청이 도착한 리스너의 Host 경계를 통과했는지 판정한다. 리스너마다 허용 Host가 다르므로
   * 기대 포트는 호스트만 알 수 있다 — 플러그인이 스스로 고른 포트로는 잘못된 경계에 대고
   * 승인할 수 있어 인자로 받지 않는다.
   */
  validateHost(req: http.IncomingMessage): boolean;
  isTerminalAuthorized(req: http.IncomingMessage): boolean;
  isLockAuthorized(req: http.IncomingMessage): boolean;
  /**
   * 이 요청이 열 수 있는 소켓의 등급. 제어를 쥔 원격이 있는 동안 이 기계 앞의 새 터미널은
   * 관전으로만 열린다 — 새로고침이나 패널 재마운트가 조용히 제어를 되가져가면 화면은
   * 여전히 그 기기가 몰고 있다고 말하는데 실제 소유권은 넘어와 버린다.
   *
   * 플러그인이 스스로 판정할 수 없는 값이다. 어느 리스너로 들어왔는지도, 지금 제어를 쥔
   * 세션이 있는지도 Console만 안다.
   */
  resolveTerminalSocketRole(req: http.IncomingMessage): "control" | "viewer";
  /**
   * 이 요청이 쓰기까지 허용되는가.
   *
   * 리스너 신원 자체를 넘기지 않는다 — bind 주소와 포트는 플러그인이 알 필요가 없고,
   * 알면 언젠가 그것으로 자기 경계를 다시 짠다. 판정만 넘긴다: 어느 리스너로 들어왔고
   * 지금 그 리스너가 무엇을 허용하는지는 Console만 안다.
   */
  isWriteAdmitted(req: http.IncomingMessage): boolean;
  /**
   * 이 요청을 받은 리스너가 인정하는 Origin. 허용 집합은 리스너마다 다르므로 호스트가
   * 알려 주고, 대조는 플러그인이 자기 실패 어휘로 한다.
   */
  expectedOrigin(req: http.IncomingMessage): string | null;
}

export interface FleetPluginLifecycleHost {
  registerCleanup(cleanup: () => void | Promise<void>): () => void;
}

export interface DiscoveredFleetPlugin {
  readonly root: string;
  readonly manifest: FleetPluginManifest;
  readonly clientEntry: string | null;
  readonly routesEntry: string | null;
}

export type {
  NotificationKindDescriptor,
  OperationCatalogPlugin,
  OperationCreateInput,
  OperationLaunchCatalogProvider,
  OperationLaunchKind,
  OperationLaunchView,
  OperationNode,
  OperationPatchInput,
  RailPanelDescriptor,
  SettingsSectionDescriptor,
};
