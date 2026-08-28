import type http from "node:http";
import type { ReactNode } from "react";

import type { ExpandedSurfaceDescriptor, ExpandedSurfaceOpenRequest } from "../expanded-surface/types.js";
import type { FloatingWidgetDescriptor } from "../floating/types.js";
import type { LocalizedText } from "../i18n/types.js";
import type { ClientNotification } from "../notifications/types.js";
import type { OperationCatalogPlugin, OperationCreateInput, OperationLaunchCatalogProvider, OperationLaunchKind, OperationLaunchView, OperationNode, OperationPatchInput, OperationGeometry } from "../operations/types.js";
import type { RailPanelDescriptor } from "../rail/types.js";
import type { RouteHandler, UpgradeHandler } from "../routing/types.js";
import type { NotificationKindDescriptor } from "../notifications/types.js";
import type { SettingsSectionDescriptor } from "../settings/types.js";

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

export interface FleetClientPlugin {
  readonly id: string;
  readonly operationKinds?: readonly OperationKindDescriptor[];
  readonly settingsSections?: readonly SettingsSectionDescriptor[];
  readonly notificationKinds?: readonly NotificationKindDescriptor[];
  readonly railPanels?: readonly RailPanelDescriptor[];
  readonly floatingWidgets?: readonly FloatingWidgetDescriptor[];
  /**
   * 캔버스를 덮는 확대 작업면. 슬롯 기하·포커스·주소는 호스트가 소유하고 플러그인은
   * 본문만 그린다. 여러 표면이 세로로 나뉘어 동시에 설 수 있다.
   */
  readonly expandedSurfaces?: readonly ExpandedSurfaceDescriptor[];
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
}

export interface ClientApiCapability {
  fetch(pluginId: string, path: string, init?: RequestInit): Promise<Response>;
  subscribe(pluginId: string, path: string, onMessage: (event: MessageEvent<string>) => void): () => void;
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
   */
  open(options?: { readonly mentionOperationId?: string }): void;
}

export interface ClientOperationsCapability {
  create(input: { readonly theaterId: string; readonly type: string; readonly pluginId: string; readonly title: string; readonly payload?: Record<string, unknown>; readonly geometry?: OperationGeometry | null }): Promise<OperationNode>;
  rename(operationId: string, title: string): Promise<OperationNode>;
  remove(operationId: string): Promise<void>;
}

/**
 * 확대 표면을 여닫는 능력. 슬롯 목록·기하·포커스는 호스트가 소유하므로 플러그인은
 * "이걸 열어 달라"고 요청할 뿐이고, 어느 슬롯에 어떤 폭으로 서는지는 결정하지 못한다.
 */
export interface ClientExpandedSurfacesCapability {
  /** 표면을 연다. 이미 열려 있으면 기본적으로 그 슬롯을 재사용한다. 인스턴스 id를 돌려준다. */
  open(request: ExpandedSurfaceOpenRequest): string;
  close(instanceId: string): void;
  /** 이 표면이 지금 슬롯을 차지하고 있는지. */
  isOpen(surfaceId: string): boolean;
}

export interface ClientPreferencesCapability {
  read<T>(key: string, fallback: T): T;
  write<T>(key: string, value: T): void;
}

export interface ClientSettingsCapability {
  read(pluginId: string): Promise<Record<string, unknown> | null>;
  write(pluginId: string, value: Record<string, unknown>): Promise<void>;
}

export interface UseOperationsResult {
  readonly operations: readonly OperationNode[];
  readonly refresh: () => Promise<void>;
}

export interface OperationKindDescriptor {
  readonly pluginId: string;
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
  readonly pluginId: string;
  readonly type: string;
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
  readonly operations: FleetPluginOperationsHost;
  readonly events: FleetPluginEventsHost;
  readonly paths: FleetPluginPathsHost;
  readonly server: FleetPluginServerHost;
  readonly storage: FleetPluginStorageHost;
  readonly http: FleetPluginHttpHost;
  readonly security: FleetPluginSecurityHost;
  readonly lifecycle: FleetPluginLifecycleHost;
}

export interface FleetPluginServerHost {
  /**
   * Console이 실제로 리슨 중인 loopback origin. 리슨 확정 전에는 null.
   * 자식 프로세스에 Console 주소를 넘겨야 하는 플러그인이 포트를 추측하지 않도록 한다.
   */
  origin(): string | null;
}

export interface FleetPluginOperationsHost {
  list(): readonly OperationNode[];
  get(id: string): OperationNode | null;
  create(input: OperationCreateInput): OperationNode;
  patch(id: string, input: OperationPatchInput): OperationNode | null;
  delete(id: string): boolean;
  registerOperationType(type: string): () => void;
  registerPayloadSanitizer(pluginId: string, fields: readonly string[]): () => void;
  registerLaunchCatalog(pluginId: string, provider: OperationLaunchCatalogProvider): () => void;
}

export interface FleetPluginEventsHost {
  publish(channel: string, payload: unknown): void;
  subscribe(channel: string, listener: (payload: unknown) => void): () => void;
  registerSseChannel(channel: string): () => void;
}

export interface FleetPluginPathsHost {
  readonly fleetDataDir: string;
  pluginDataDir(pluginId: string): string;
  resolveTheaterPath(theaterId: string): string | null;
  canonicalizeTheaterPath(cwd: string): string;
  workspaceHash(canonicalCwd: string): string;
}

export interface FleetPluginStorageHost {
  readJson(pluginId: string, key: string): Promise<unknown>;
  writeJson(pluginId: string, key: string, value: unknown): Promise<void>;
}

export interface FleetPluginHttpHost {
  writeJson(res: http.ServerResponse, status: number, payload: unknown): void;
  readJsonBody<T>(req: http.IncomingMessage): Promise<T | null>;
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
