import type http from "node:http";
import type { ReactNode } from "react";

import type { LaunchContext } from "../launch/types.js";
import type { ClientNotification } from "../notifications/types.js";
import type { OperationCatalogPlugin, OperationCreateInput, OperationLaunchCatalogProvider, OperationLaunchKind, OperationNode, OperationPatchInput, OperationGeometry } from "../operations/types.js";
import type { RailPanelDescriptor } from "../rail/types.js";
import type { RouteHandler, UpgradeHandler } from "../routing/types.js";
import type { NotificationKindDescriptor } from "../notifications/types.js";
import type { SettingsSectionDescriptor } from "../settings/types.js";

export type ConsoleTheme = "maritime" | "carbon";

export type OperationActivity = "idle" | "running" | "awaiting" | "live" | "dormant";

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
  readonly install?: (ctx: PluginInstallContext) => void | (() => void);
  readonly launch?: (ctx: LaunchContext) => Promise<{ readonly id: string }>;
  readonly closeOperation?: (operationId: string) => void | Promise<void>;
  readonly renderLaunchIcon?: (kind: OperationLaunchKind) => ReactNode;
}

export interface PluginInstallContext {
  readonly api: ClientApiCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly terminal: ClientTerminalCapability;
  readonly notifications: ClientNotificationsCapability;
  readonly operations: ClientOperationsCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly status: ClientOperationStatusCapability;
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

export interface ClientOperationsCapability {
  create(input: { readonly theaterId: string; readonly type: string; readonly pluginId: string; readonly title: string; readonly payload?: Record<string, unknown>; readonly geometry?: OperationGeometry | null }): Promise<OperationNode>;
  rename(operationId: string, title: string): Promise<OperationNode>;
  remove(operationId: string): Promise<void>;
}

export interface ClientPreferencesCapability {
  read<T>(key: string, fallback: T): T;
  write<T>(key: string, value: T): void;
}

export interface UseOperationsResult {
  readonly operations: readonly OperationNode[];
  readonly refresh: () => Promise<void>;
}

export interface OperationKindDescriptor {
  readonly pluginId: string;
  readonly type: string;
  readonly title: string;
  readonly subtitle?: (operation: OperationNode) => string | undefined;
  readonly render?: (context: OperationRenderContext) => ReactNode;
}

export interface OperationContext {
  readonly operationId: string;
  readonly theaterId: string;
  readonly pluginId: string;
  readonly type: string;
}

export interface OperationRenderContext extends OperationContext {
  readonly active: boolean;
  readonly geometry: OperationGeometry;
  readonly operation: OperationNode;
  readonly zoom: number;
  readonly theme: ConsoleTheme;
  readonly api: ClientApiCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly terminal: ClientTerminalCapability;
  readonly notifications: ClientNotificationsCapability;
  readonly operations: ClientOperationsCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly status: ClientOperationStatusCapability;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
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

export interface FleetPluginServerContext {
  readonly pluginId: string;
  readonly manifest: FleetPluginManifest;
  readonly basePath: string;
  readonly wsBasePath: string;
  readonly host: FleetPluginHostCapabilities;
  registerRouter(path: string, handler: RouteHandler): void;
  registerWsHandler(path: string, handler: UpgradeHandler): void;
}

export interface FleetPluginHostCapabilities {
  readonly operations: FleetPluginOperationsHost;
  readonly events: FleetPluginEventsHost;
  readonly paths: FleetPluginPathsHost;
  readonly storage: FleetPluginStorageHost;
  readonly http: FleetPluginHttpHost;
  readonly security: FleetPluginSecurityHost;
  readonly lifecycle: FleetPluginLifecycleHost;
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
  readonly dataDir: string;
  readonly capturesDir: string;
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
  validateHost(req: http.IncomingMessage, expectedPort: number): boolean;
  isTerminalAuthorized(req: http.IncomingMessage): boolean;
  isLockAuthorized(req: http.IncomingMessage): boolean;
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
