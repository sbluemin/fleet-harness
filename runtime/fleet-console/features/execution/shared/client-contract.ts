import type { ClientNavigateCapability, ClientShellCapability } from "../../workspace/shared/navigation.js";
import type { ReactNode } from "react";
import type { LocalizedText } from "@fleet-console/i18n";
import type { OperationLaunchKind, OperationNode, OperationGeometry } from "./operations/types.js";
import type { ClientComposerCapability } from "./composer-ports.js";
import type { ClientPreferencesCapability, ClientSettingsCapability } from "../../settings/shared/client-ports.js";
import type { ClientRailCapability } from "../../workspace/shared/navigation-ports.js";
import type { ClientApiCapability, ClientLifecycleCapability } from "@fleet-console/infra/http/client-ports";
import type { ClientNotificationsCapability } from "./notification-ports.js";
import type { ConsoleTheme } from "../../settings/shared/theme.js";
import type { ClientMobileOperationCapability } from "../../workspace/shared/mobile.js";
export interface LaunchContext {
  readonly theaterId: string;
  readonly kind: OperationLaunchKind;
  readonly geometry: OperationGeometry;
  readonly operations: ClientOperationsCapability;
  readonly variant?: Readonly<Record<string, string>>;
}


/**
 * Operation 런타임은 두 축이다 — 축을 섞으면 한쪽이 다른 쪽을 삼킨다.
 *
 * `lifecycle`은 실행 표면이 접근 가능한지를 말한다. 채팅은 SDK 자식 없이도 항상 live이고,
 * `dormant`는 터미널 프로세스 없이 재개 근거만 남은 상태다. `activity`는 무엇을 하는지를 말한다. 예전에는
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


export interface ClientTerminalCapability {
  requestTicket(path: string, operationId: string, signal?: AbortSignal): Promise<TerminalTicket>;
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


export interface ClientOperationsCapability {
  create(input: { readonly theaterId: string; readonly type: string; readonly pluginId: string | null; readonly title: string; readonly payload?: Record<string, unknown>; readonly geometry?: OperationGeometry | null }): Promise<OperationNode>;
  rename(operationId: string, title: string): Promise<OperationNode>;
  remove(operationId: string): Promise<void>;
  /** 그 Operation 으로 간다 — 활성으로 세우고, 접혀 있으면 펴고, 키보드 초점을 준다. 어느 모드에서든 호스트가 자리를 정한다.
   * 이동은 코어가 확장 표면을 정리한다 — 플러그인은 자기 표면을 따로 닫지 않는다.
   * `snap: "full"` 은 Cruise 화면에서 Snap 전체 칸으로 앉힌다 — 스냅할 수 없는 모드·화면에서는 같은 일반 이동으로 폴백한다. */
  focus(operationId: string, options?: { readonly snap?: "full" }): void;
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


export interface UseOperationsResult {
  readonly operations: readonly OperationNode[];
  readonly refresh: () => Promise<void>;
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
   * places the shelf, and paints the surface. Build the buttons with
   * `Workspace caption-actions` so one band cannot carry two grammars.
   *
   * A conversation header splits that shelf into two capsules and reads these slots when they
   * are set. `captionViewSwitch` stands with the conversation's view control (turn fold);
   * `captionToolsLead` stands at the front of the tool capsule and is not collapsed into the
   * overflow menu. Omit both and the host keeps the whole shelf in `captionActions`.
   */
  readonly captionActions?: (context: OperationRenderContext) => ReactNode;
  /** Conversation header only — the view-switch button, beside the conversation's own view control. */
  readonly captionViewSwitch?: (context: OperationRenderContext) => ReactNode;
  /** Conversation header only — the leading tool-capsule button (the session browser). Never overflow-collapsed. */
  readonly captionToolsLead?: (context: OperationRenderContext) => ReactNode;
  /**
   * Fills the top of the host's Operation menu — the same card the caption's ··· button and the
   * sidebar's right-click open. The host owns the card, its grouping and
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
  /**
   * 모바일 Operation 화면에서만 실린다. 없다는 것이 「호스트가 ⋮을 그려 주지 않는다」는 말이다(데스크톱 대화 화면·확대 표면).
   */
  readonly mobileOperation?: ClientMobileOperationCapability;
  readonly navigate: ClientNavigateCapability;
  readonly shell: ClientShellCapability;
  readonly rail: ClientRailCapability;
  readonly active: boolean;
  /**
   * Requests DOM keyboard focus for the current Operation's primary body.
   * This is not a layout position, active state, or persistent state: a changed value means a new focus request.
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
   * host and must be treated as live. `false` is a parked or hidden
   * body: the plugin must not hold a dedicated HTTP stream for it.
   */
  readonly bodyLive?: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  /** Requests host-owned companion panels without exposing the host layout to plugins. */
  readonly onRequestCompanions?: (open: boolean) => void;
  readonly companionsOpen?: boolean;
  /** Host-owned effective companion visibility; `undefined` denotes a host without per-panel visibility support. */
  readonly hiddenCompanionPanelIds?: readonly string[];
  /** Requests a volatile host-owned visibility override for one companion panel. */
  readonly onSetCompanionPanelVisible?: (companionPanelId: string, visible: boolean) => void;
  /**
   * Companion panels this host offers for the Operation. `undefined` offers every panel the plugin declares; a host
   * that offers only some lists them, and the plugin does not raise an entry (such as a caption button) for the rest.
   */
  readonly companionPanelIds?: readonly string[];
}
