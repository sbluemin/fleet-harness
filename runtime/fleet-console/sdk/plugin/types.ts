import type http from "node:http";
import type { ReactNode } from "react";

import type { FloatingWidgetDescriptor } from "../floating/types.js";
import type { LocalizedText } from "../i18n/types.js";
import type { ClientNotification } from "../notifications/types.js";
import type { OperationCatalogPlugin, OperationCreateInput, OperationLaunchCatalogProvider, OperationLaunchKind, OperationNode, OperationPatchInput, OperationGeometry } from "../operations/types.js";
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

export type OperationActivity = "idle" | "running" | "awaiting" | "dormant" | "background";

export interface TerminalTicket {
  readonly ticket: string;
  readonly ttlMs: number;
}

export interface FleetClientPlugin {
  readonly id: string;
  readonly operationKinds?: readonly OperationKindDescriptor[];
  readonly settingsSections?: readonly SettingsSectionDescriptor[];
  readonly notificationKinds?: readonly NotificationKindDescriptor[];
  readonly railPanels?: readonly RailPanelDescriptor[];
  readonly floatingWidgets?: readonly FloatingWidgetDescriptor[];
  readonly install?: (ctx: PluginInstallContext) => void | (() => void);
  readonly launch?: (ctx: LaunchContext) => Promise<{ readonly id: string }>;
  readonly closeOperation?: (operationId: string) => void | Promise<void>;
  /**
   * Optional host→plugin resume request for a dormant Operation (e.g. a palette command).
   * Plugins without resumable sessions omit it; the host falls back to focusing the Operation.
   */
  readonly resumeOperation?: (operationId: string) => void | Promise<void>;
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
  readonly status: ClientOperationStatusCapability;
  readonly statusDetail: ClientOperationStatusDetailCapability;
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

export interface ClientOperationStatusCapability {
  set(operationId: string, status: OperationActivity): void;
  clear(operationId: string): void;
}

export interface ClientOperationStatusDetailCapability {
  set(operationId: string, detail: string): void;
  clear(operationId: string): void;
}

export interface ClientOperationsCapability {
  create(input: { readonly theaterId: string; readonly type: string; readonly pluginId: string; readonly title: string; readonly payload?: Record<string, unknown>; readonly geometry?: OperationGeometry | null }): Promise<OperationNode>;
  rename(operationId: string, title: string): Promise<OperationNode>;
  remove(operationId: string): Promise<void>;
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
  readonly status: ClientOperationStatusCapability;
  readonly statusDetail: ClientOperationStatusDetailCapability;
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
  readonly apiCatalogVersion?: 1;
  readonly pluginId: string;
  readonly manifest: FleetPluginManifest;
  readonly basePath: string;
  readonly wsBasePath: string;
  readonly host: FleetPluginHostCapabilities;
  registerRouter(path: string, handler: RouteHandler): void;
  registerRouter(path: string, catalog: ApiCatalogEntry | readonly ApiCatalogEntry[], handler: RouteHandler): void;
  registerWsHandler(path: string, handler: UpgradeHandler): void;
  registerWsHandler(path: string, catalog: ApiCatalogEntry | readonly ApiCatalogEntry[], handler: UpgradeHandler): void;
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
  OperationNode,
  OperationPatchInput,
  RailPanelDescriptor,
  SettingsSectionDescriptor,
};
