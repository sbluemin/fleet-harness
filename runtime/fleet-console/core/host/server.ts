import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import {
  createCarrierRegistry,
  registerDefaultCarriers,
} from "@dotobokuri/fleet-carriers";
import { createInfraServices } from "@dotobokuri/core-infra";

import { buildApiCatalog, type ApiCatalogEntry } from "./api-catalog.js";
import type { ConsoleHealth, ConsoleObserverStatus, ConsoleTheaterFolderListResponse, ConsoleTheaterInfo, ConsoleUpdateApplyAcceptedResponse } from "./api-types.js";
import { createCarrierSettingsRouter } from "./carrier-settings-routes.js";
import { createCodexWorkspaceContextRouter } from "./codex/context-routes.js";
import { createCodexGateway } from "./codex/gateway.js";
import { createConsoleSettingsStore } from "./console-settings.js";
import { createConsoleDurableStateStore, emptyDurableConsoleState, type DurableConsoleState } from "./durable-state.js";
import { createGlobalSettingsRouter } from "./global-settings-routes.js";
import { createPluginSettingsRouter } from "./plugin-settings-routes.js";
import { createConsoleLock, type ConsoleLockHandle } from "./lock.js";
import { createOperationsRouter } from "./operations/routes.js";
import { createSanitizedOpDto } from "./operations/sanitize.js";
import { createOperationStore } from "./operations/store.js";
import type { OperationNode } from "./operations/types.js";
import { createConsoleDataPaths } from "./paths.js";
import { createPlansRouter } from "./plans/routes.js";
import { createPluginClientAssets } from "./plugin-host/client-assets.js";
import { createFleetPluginHost } from "./plugin-host/host.js";
import type { FleetPluginHostCapabilities, OperationCatalogPlugin, OperationLaunchCatalogProvider, OperationLaunchKind } from "./plugin-host/types.js";
import { readFleetConsoleRelease, type FleetConsoleRelease } from "./release.js";
import { createConsoleReleaseNotesService, type ConsoleReleaseNotesService } from "./release-notes/service.js";
import { ConsoleReleaseNotesUnavailableError, type ReleaseNotesLocale } from "./release-notes/types.js";
import { RouteRegistry } from "./route-registry/route-registry.js";
import { UpgradeRegistry } from "./route-registry/upgrade-registry.js";
import { withSecurityHeaders } from "./security-headers.js";
import { encodeSseData } from "./sse.js";
import { createStaticConsoleHandler } from "./static-console.js";
import { listTheaterFolders, TheaterFolderListError } from "./theater-folder-browser.js";
import { createFolderGrantStore } from "./theater-folder-grants.js";
import { createTheaterPathContextRouter } from "./theater-path-context-routes.js";
import { resolveTheaterPathContext } from "./theater-path-context.js";
import type { TheaterRegistration } from "./theaters.js";
import { TheaterRegistry } from "./theaters.js";
import { canonicalizeTheaterPathSync, workspaceHash } from "./theater.js";
import { createConsoleUpdateApplyService, type ConsoleUpdateApplyService } from "./update-apply.js";
import { createConsoleUpdateCheckService, type ConsoleUpdateCheckService } from "./update-check.js";

export interface ConsoleServerDeps {
  readonly host?: string;
  readonly port?: number;
  readonly version?: string;
  readonly codexCwd?: string;
  readonly dataDir?: string;
  readonly agentCliDetector?: unknown;
  readonly agentRuntime?: unknown;
  readonly release?: FleetConsoleRelease;
  readonly releaseNotes?: ConsoleReleaseNotesService;
  readonly updateCheck?: ConsoleUpdateCheckService;
  readonly updateApply?: ConsoleUpdateApplyService;
}

export interface ConsoleServer {
  readonly host: string;
  readonly port: number;
  start(lockPaths: { readonly dir: string; readonly lockFile: string }): Promise<string>;
  stop(): Promise<void>;
  registerCodexWorkspace(cwd: string): Promise<string>;
}

type TheaterFolderListBody = { readonly path?: unknown };
type TheaterFolderGrantBody = { readonly path?: unknown };
type CreateTheaterBody = { readonly folderGrantId?: unknown };
type UpdateApplyBody = Record<string, unknown>;

interface ConsolePortRuntimeState {
  readonly requestedPort: number | null;
  readonly portMode: "dynamic" | "static";
  readonly effectivePort: number;
  readonly portHonored: boolean;
}

interface ConsolePortListenPlan {
  readonly port: number;
  readonly requestedPort: number | null;
  readonly portMode: "dynamic" | "static";
  readonly allowFallback: boolean;
}

interface ConsolePortListenResult {
  readonly srv: http.Server;
  readonly localLoopbackServer: http.Server | null;
  readonly actualPort: number;
  readonly endpoint: string;
  readonly portState: ConsolePortRuntimeState;
}

const DEFAULT_HOST = "127.0.0.1";
// 포트 0은 OS가 사용 가능한 임의 포트를 할당한다는 의미다. 실제 바인딩된 포트는
// start()에서 srv.address()의 actualPort로 캡처해 락 파일에 기록한다.
const DEFAULT_PORT = 0;
const MIN_CONSOLE_STATIC_PORT = 1024;
const MAX_CONSOLE_STATIC_PORT = 65535;
const SERVER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const UPDATE_APPLY_FORBIDDEN_BODY_KEYS = new Set(["channel", "package", "packageName", "packageVersion", "packages", "targetVersion", "version"]);
const OPERATION_RENAMED_EVENT_CHANNEL = "operation:renamed";
const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";
export const SERVER_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: "/api/v1/status",
    summary: "콘솔 관측 상태를 조회합니다.",
    category: "Observer",
    gate: "loopback",
  },
  {
    method: "GET",
    path: "/api/v1/settings/api-catalog",
    summary: "백엔드 API 카탈로그를 조회합니다.",
    category: "Observer",
    gate: "loopback",
  },
  {
    method: "GET",
    path: "/api/v1/updates/release-notes",
    summary: "Get the console release notes.",
    category: "Update",
    gate: "loopback",
  },
  {
    method: "GET",
    path: "/api/v1/theaters",
    summary: "Theater 목록을 조회합니다.",
    category: "Observer",
    gate: "loopback",
  },
  {
    method: "POST",
    path: "/api/v1/theaters",
    summary: "새 Theater를 등록합니다.",
    category: "Observer",
    gate: "origin-write",
  },
  {
    method: "DELETE",
    path: "/api/v1/theaters/:theaterId",
    summary: "Theater와 소속 Operation을 제거합니다.",
    category: "Observer",
    gate: "origin-write",
  },
  {
    method: "GET",
    path: "/api/v1/theaters/:theaterId/path-context",
    summary: "Get the selected Theater path context.",
    category: "Observer",
    gate: "loopback",
  },
  {
    method: "PUT",
    path: "/api/v1/theaters/:theaterId/path-context",
    summary: "Save the selected Theater path context.",
    category: "Observer",
    gate: "origin-write",
  },
  {
    method: "GET",
    path: "/api/v1/theaters/:theaterId/path-context/worktrees",
    summary: "List contained Git worktrees for a Theater.",
    category: "Observer",
    gate: "loopback",
  },
  {
    method: "POST",
    path: "/api/v1/theaters/:theaterId/path-context/directories",
    summary: "List contained directories for a Theater path context.",
    category: "Observer",
    gate: "origin-write",
  },
  {
    method: "POST",
    path: "/api/v1/theaters/:theaterId/codex-workspace",
    summary: "Resolve the Codex workspace for a Theater path context.",
    category: "Observer",
    gate: "origin-write",
  },
  {
    method: "POST",
    path: "/plugins/terminal/shell/ticket",
    summary: "Shell WebSocket 접속 티켓을 발급합니다.",
    category: "Terminal Plugin",
    gate: "origin-write",
  },
  {
    method: "GET",
    path: "/plugins/terminal/settings",
    summary: "Get Terminal plugin prompt settings.",
    category: "Terminal Plugin",
    gate: "loopback",
  },
  {
    method: "PUT",
    path: "/plugins/terminal/settings",
    summary: "Save Terminal plugin prompt settings.",
    category: "Terminal Plugin",
    gate: "origin-write",
  },
  {
    method: "POST",
    path: "/api/v1/theaters/folder-listings",
    summary: "Theater 폴더 선택 목록을 조회합니다.",
    category: "Observer",
    gate: "origin-write",
  },
  {
    method: "POST",
    path: "/api/v1/theaters/folder-grants",
    summary: "Theater 폴더 접근 grant를 발급합니다.",
    category: "Observer",
    gate: "origin-write",
  },
  {
    method: "POST",
    path: "/api/v1/plans/list",
    summary: "Theater의 실행 계획 목록을 조회합니다.",
    category: "Observer",
    gate: "origin-write",
  },
  {
    method: "POST",
    path: "/api/v1/plans/read",
    summary: "실행 계획 문서를 조회합니다.",
    category: "Observer",
    gate: "origin-write",
  },
  {
    method: "POST",
    path: "/api/v1/updates/apply",
    summary: "Request console update application.",
    category: "Update",
    gate: "origin-strict",
  },
  {
    method: "GET",
    path: "/api/v1/health",
    summary: "Check console status with the lock token.",
    category: "Health",
    gate: "lock-token",
  },
];

export function createConsoleServer(deps: ConsoleServerDeps = {}): ConsoleServer {
  const host = deps.host ?? DEFAULT_HOST;
  const port = deps.port ?? DEFAULT_PORT;
  const release = deps.release ?? readFleetConsoleRelease();
  const tryServeStaticConsole = createStaticConsoleHandler(release.packageRoot);
  // 버전은 런타임에 package.json을 읽는 release.ts SSoT에서 해석한다(channel과 동일 경로).
  // 과거 빌드타임 상수(__PKG_VERSION__)는 tsup define에 주입된 적이 없어 항상 "0.0.0-dev"로
  // 폴백되는 죽은 경로였다. deps.version은 테스트 오버라이드용으로 유지한다.
  const version = deps.version ?? release.version;
  const channel = release.channel;
  const carrierRegistry = createCarrierRegistry();
  registerDefaultCarriers(carrierRegistry);
  const lock = createConsoleLock({ hostname: () => host });
  const releaseNotes = deps.releaseNotes ?? createConsoleReleaseNotesService();
  const updateCheck = deps.updateCheck ?? createConsoleUpdateCheckService();
  const updateApply = deps.updateApply ?? createConsoleUpdateApplyService();
  const theaters = new TheaterRegistry();
  const operations = createOperationStore();
  const folderGrants = createFolderGrantStore();
  const infraServices = createInfraServices();
  // channel은 createConsoleDataPaths가 release SSoT로 자체 감지한다(hook 서브프로세스·fallback과 동일 경로).
  const durablePaths = createConsoleDataPaths({ fleetDataDir: deps.dataDir });
  const durableStateStore = createConsoleDurableStateStore({ paths: durablePaths });
  const consoleSettingsStore = createConsoleSettingsStore({ paths: durablePaths });
  const codex = createCodexGateway({
    cwd: deps.codexCwd ?? process.cwd(),
    host,
    version,
    getPort: () => lockHandle?.payload.port ?? port,
  });
  const routeRegistry = new RouteRegistry();
  const upgradeRegistry = new UpgradeRegistry();
  const pluginOperationTypes = new Set<string>();
  const pluginPayloadSanitizers = new Map<string, readonly string[]>();
  const pluginLaunchCatalogProviders = new Map<string, OperationLaunchCatalogProvider[]>();
  const pluginCleanupCallbacks = new Set<() => void | Promise<void>>();
  const pluginEventListeners = new Map<string, Set<(payload: unknown) => void>>();
  const operationSseSubscribers = new Set<http.ServerResponse>();
  let unsubscribeUpdateCheckChanges = updateCheck.onChange?.(() => {
    broadcastUpdateAvailable();
  }) ?? null;
  const pluginHostCapabilities: FleetPluginHostCapabilities = {
    operations: {
      list: () => operations.list(),
      get: (id) => operations.get(id),
      create: (input) => {
        const operation = operations.create(input);
        persistDurableState();
        return operation;
      },
      patch: (id, input) => {
        const previousTitle = "title" in input ? operations.get(id)?.title : undefined;
        const operation = operations.patch(id, input);
        if (operation) {
          persistDurableState();
          if (previousTitle !== undefined && previousTitle !== operation.title) {
            broadcastOperationChanged(operation);
          }
        }
        return operation;
      },
      delete: (id) => {
        const deleted = operations.delete(id);
        if (deleted) persistDurableState();
        return deleted;
      },
      registerOperationType: (type) => {
        pluginOperationTypes.add(type);
        return () => {
          pluginOperationTypes.delete(type);
        };
      },
      registerPayloadSanitizer: (pluginId, fields) => {
        pluginPayloadSanitizers.set(pluginId, fields);
        return () => {
          if (pluginPayloadSanitizers.get(pluginId) === fields) pluginPayloadSanitizers.delete(pluginId);
        };
      },
      registerLaunchCatalog: (pluginId, provider) => {
        const providers = pluginLaunchCatalogProviders.get(pluginId) ?? [];
        providers.push(provider);
        pluginLaunchCatalogProviders.set(pluginId, providers);
        // disposer는 멱등이어야 한다 — 같은 함수 참조를 여러 번 등록한 경우, 한 disposer를 중복 호출해도
        // 이 등록분 하나만 제거하도록 disposed 플래그로 막는다(중복 호출이 다른 등록분을 삭제하는 것 방지).
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          const current = pluginLaunchCatalogProviders.get(pluginId);
          if (!current) return;
          const index = current.indexOf(provider);
          if (index >= 0) current.splice(index, 1);
          if (current.length === 0) pluginLaunchCatalogProviders.delete(pluginId);
        };
      },
    },
    events: {
      publish: (channel, payload) => {
        for (const listener of pluginEventListeners.get(channel) ?? []) listener(payload);
      },
      subscribe: (channel, listener) => {
        const listeners = pluginEventListeners.get(channel) ?? new Set<(payload: unknown) => void>();
        listeners.add(listener);
        pluginEventListeners.set(channel, listeners);
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) pluginEventListeners.delete(channel);
        };
      },
      registerSseChannel: () => () => undefined,
    },
    paths: {
      capturesDir: durablePaths.capturesDir,
      pluginDataDir: (pluginId) => path.join(durablePaths.dir, "plugins", pluginId),
      resolveTheaterPath: (theaterId) => theaters.get(theaterId)?.realpath ?? null,
      canonicalizeTheaterPath: canonicalizeTheaterPathSync,
      workspaceHash,
    },
    storage: {
      readJson: (pluginId, key) => readPluginStorageJson(durablePaths.dir, pluginId, key),
      writeJson: (pluginId, key, value) => writePluginStorageJson(durablePaths.dir, pluginId, key, value),
    },
    http: {
      writeJson,
      readJsonBody,
    },
    security: {
      validateHost,
      isTerminalAuthorized,
      isLockAuthorized,
    },
    lifecycle: {
      registerCleanup: (cleanup) => {
        pluginCleanupCallbacks.add(cleanup);
        return () => pluginCleanupCallbacks.delete(cleanup);
      },
    },
  };
  const pluginHost = createFleetPluginHost({
    ...resolveBuiltInPluginDiscoveryRoots(release.packageRoot),
    routes: routeRegistry,
    upgrades: upgradeRegistry,
    host: pluginHostCapabilities,
  });
  const pluginClientAssets = createPluginClientAssets({ plugins: pluginHost.plugins });
  async function resolveOperationCatalog(): Promise<{ readonly plugins: readonly OperationCatalogPlugin[] }> {
    const result: OperationCatalogPlugin[] = [];
    for (const plugin of pluginHost.plugins) {
      const providers = pluginLaunchCatalogProviders.get(plugin.manifest.id);
      if (!providers) continue;
      const kinds: OperationLaunchKind[] = [];
      for (const provider of providers) {
        let provided: readonly OperationLaunchKind[] = [];
        try {
          provided = await provider();
        } catch {
          provided = [];
        }
        for (const kind of provided) {
          const safe = sanitizeLaunchKind(kind);
          if (safe) kinds.push(safe);
        }
      }
      const seenKindIds = new Set<string>();
      const deduped = kinds.filter((kind) => {
        if (seenKindIds.has(kind.id)) return false;
        seenKindIds.add(kind.id);
        return true;
      });
      if (deduped.length === 0) continue;
      result.push({ id: plugin.manifest.id, title: plugin.manifest.name ?? plugin.manifest.id, kinds: deduped });
    }
    return { plugins: result };
  }
  let server: http.Server | null = null;
  let loopbackServer: http.Server | null = null;
  let lockHandle: ConsoleLockHandle | null = null;
  let activeLockFile: string | null = null;
  let activeEndpoint: string | null = null;
  let portState: ConsolePortRuntimeState = {
    requestedPort: null,
    portMode: "dynamic",
    effectivePort: port,
    portHonored: true,
  };
  let consoleResourcesDisposed = false;
  let updateApplyInFlight = false;
  const carrierSettingsRouter = createCarrierSettingsRouter({
    registry: carrierRegistry,
    isAuthorized: isTerminalAuthorized,
    readJsonBody,
    writeJson,
  });
  const globalSettingsRouter = createGlobalSettingsRouter({
    consoleSettingsStore,
    isAuthorized: isTerminalAuthorized,
    readJsonBody,
    writeJson,
  });
  const pluginSettingsRouter = createPluginSettingsRouter({
    consoleSettingsStore,
    isAuthorized: isTerminalAuthorized,
    readJsonBody,
    writeJson,
  });
  const plansRouter = createPlansRouter({
    isAuthorized: isTerminalAuthorized,
    readJsonBody,
    resolveTheaterPath: (theaterId) => theaters.get(theaterId)?.realpath ?? null,
    writeJson,
  });
  const theaterPathContextRouter = createTheaterPathContextRouter({
    getTheater: (theaterId) => theaters.get(theaterId),
    isAuthorized: isTerminalAuthorized,
    persist: persistDurableState,
    readJsonBody,
    setPathContext: (theaterId, relPath) => theaters.setPathContext(theaterId, relPath),
    writeJson,
  });
  const codexWorkspaceContextRouter = createCodexWorkspaceContextRouter({
    getTheater: (theaterId) => theaters.get(theaterId),
    isAuthorized: isTerminalAuthorized,
    readJsonBody,
    resolveWorkspace: (theaterId, theaterRoot, relPath) => codex.resolveWorkspaceForPath(theaterId, theaterRoot, relPath),
    writeJson,
  });
  const operationsRouter = createOperationsRouter({
    store: operations,
    isAuthorized: isTerminalAuthorized,
    readJsonBody,
    writeJson,
    persist: persistDurableState,
    getPluginSensitiveFields: (pluginId) => [
      ...(pluginHost.sensitiveFieldsByPluginId.get(pluginId) ?? []),
      ...(pluginPayloadSanitizers.get(pluginId) ?? []),
    ],
    resolveLaunchCatalog: resolveOperationCatalog,
    publishRenameEvent: (event) => pluginHostCapabilities.events.publish(OPERATION_RENAMED_EVENT_CHANNEL, event),
    publishDeleteEvent: (event) => pluginHostCapabilities.events.publish(OPERATION_DELETED_EVENT_CHANNEL, event),
    broadcastOperationChanged,
    subscribeOperationSse: (res) => {
      res.writeHead(200, withSecurityHeaders({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      }));
      res.write(":connected\n\n");
      operationSseSubscribers.add(res);
      res.on("close", () => {
        operationSseSubscribers.delete(res);
      });
    },
  });
  routeRegistry.register("/api/v1/operations", operationsRouter);
  routeRegistry.register("/api/v1/theaters", async (context) => {
    if (await theaterPathContextRouter(context)) return true;
    return codexWorkspaceContextRouter(context);
  });
  routeRegistry.register("/api/v1/settings", async (ctx) => {
    const { req, res, pathname } = ctx;
    if (pathname === "/api/v1/settings/api-catalog") {
      handleObserverApiCatalog(req, res);
      return true;
    }
    if (await carrierSettingsRouter(ctx)) return true;
    if (await pluginSettingsRouter(ctx)) return true;
    return globalSettingsRouter(ctx);
  });
  routeRegistry.register("/plugin-runtime", handlePluginRuntimeRoute);

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = getPathname(req);
    if (pathname === "/console/codex" || pathname.startsWith("/console/codex/")) {
      runAsyncBooleanHandler(codex.handle(req, res), res, () => tryServeStaticConsole(req, res, pathname));
      return;
    }
    if (!validateHost(req, lockHandle?.payload.port ?? port)) {
      writeJson(res, 403, { error: "host_mismatch" });
      return;
    }
    if (tryServeStaticConsole(req, res, pathname)) return;
    if (pathname === "/api/v1/health") {
      handleHealth(req, res);
      return;
    }
    runAsyncBooleanHandler(routeRegistry.handle({ req, res, pathname }), res, () => {
      handleCoreRequest(req, res, pathname);
      return true;
    });
  }

  function handleCoreRequest(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    if (pathname === "/api/v1/status") {
      handleStatus(req, res);
      return;
    }
    if (pathname === "/api/v1/theaters") {
      runAsyncHandler(handleObserverTheaters(req, res), res);
      return;
    }
    if (pathname === "/api/v1/theaters/folder-listings") {
      runAsyncHandler(handleTheaterFoldersList(req, res), res);
      return;
    }
    if (pathname === "/api/v1/theaters/folder-grants") {
      runAsyncHandler(handleTheaterFolderGrants(req, res), res);
      return;
    }
    if (pathname === "/api/v1/plans/list" || pathname === "/api/v1/plans/read") {
      runAsyncBooleanHandler(plansRouter({ req, res, pathname }), res, () => false);
      return;
    }
    const theaterItemMatch = pathname.match(/^\/api\/v1\/theaters\/([^/]+)$/);
    if (theaterItemMatch) {
      runAsyncHandler(handleObserverTheaterItem(req, res, decodeURIComponent(theaterItemMatch[1] ?? "")), res);
      return;
    }
    if (pathname === "/api/v1/updates/release-notes") {
      runAsyncHandler(handleObserverReleaseNotes(req, res), res);
      return;
    }
    if (pathname === "/api/v1/updates/apply") {
      runAsyncHandler(handleUpdateApply(req, res), res);
      return;
    }
    res.writeHead(404);
    res.end();
  }

  function handlePluginRuntimeRoute({ req, res, pathname }: { readonly req: http.IncomingMessage; readonly res: http.ServerResponse; readonly pathname: string }): boolean {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (pathname === "/plugin-runtime/manifest") {
      writeJson(res, 200, pluginClientAssets.manifest());
      return true;
    }
    const clientMatch = pathname.match(/^\/plugin-runtime\/client\/([^/]+)\.mjs$/u);
    if (clientMatch) {
      const source = pluginClientAssets.getClient(decodeURIComponent(clientMatch[1] ?? ""));
      if (!source) {
        writeJson(res, 404, { error: "Not found" });
        return true;
      }
      writeJavaScript(res, 200, source);
      return true;
    }
    const shimMatch = pathname.match(/^\/plugin-runtime\/shim\/([^/]+)\.mjs$/u);
    if (shimMatch) {
      const source = pluginClientAssets.getShim(decodeURIComponent(shimMatch[1] ?? ""));
      if (!source) {
        writeJson(res, 404, { error: "Not found" });
        return true;
      }
      writeJavaScript(res, 200, source);
      return true;
    }
    return false;
  }

  function handleHealth(req: http.IncomingMessage, res: http.ServerResponse): void {
    const handle = lockHandle;
    const token = handle?.payload.token;
    if (handle && token && req.headers.authorization === `Bearer ${token}`) {
      const payload = handle.payload;
      const body: ConsoleHealth = {
        ok: true,
        pid: payload.pid,
        host: payload.host,
        port: payload.port,
        portMode: portState.portMode,
        requestedPort: portState.requestedPort,
        effectivePort: portState.effectivePort,
        portHonored: portState.portHonored,
        endpoint: payload.endpoint,
        startedAt: payload.startedAt,
        version: payload.version,
        workspaceCount: operations.list().length,
      };
      writeJson(res, 200, body);
      return;
    }
    writeJson(res, 401, { error: "Unauthorized" });
  }

  async function handleTheaterFoldersList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody<TheaterFolderListBody>(req);
    if (!isPlainObject(body) || (body.path !== undefined && body.path !== null && typeof body.path !== "string")) {
      writeJson(res, 400, { error: "invalid_path" });
      return;
    }
    try {
      const payload: ConsoleTheaterFolderListResponse = await listTheaterFolders(body.path === undefined ? null : body.path);
      writeJson(res, 200, payload);
    } catch (error) {
      if (error instanceof TheaterFolderListError) {
        writeJson(res, theaterFolderListStatus(error), { error: error.code });
        return;
      }
      throw error;
    }
  }

  async function handleTheaterFolderGrants(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody<TheaterFolderGrantBody>(req);
    if (!isPlainObject(body) || typeof body.path !== "string") {
      writeJson(res, 400, { error: "invalid_folder" });
      return;
    }
    try {
      writeJson(res, 200, { folderGrantId: folderGrants.issue(body.path) });
    } catch {
      writeJson(res, 400, { error: "invalid_folder" });
    }
  }

  async function handleObserverTheaters(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === "GET") {
      writeJson(res, 200, { theaters: listTheaterInfos() });
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody<CreateTheaterBody>(req);
    if (!isPlainObject(body) || typeof body.folderGrantId !== "string") {
      writeJson(res, 400, { error: "invalid_folder_grant" });
      return;
    }
    const cwd = folderGrants.consume(body.folderGrantId);
    if (!cwd) {
      writeJson(res, 400, { error: "invalid_folder_grant" });
      return;
    }
    const theater = await theaters.register(cwd);
    let hasWiki = false;
    try {
      await codex.registerWorkspace(theater.realpath, undefined, theater.id);
      hasWiki = true;
    } catch (error) {
      if (!(error instanceof Error && error.message === "knowledge_root_missing")) {
        console.warn(`[fleet-console] Codex workspace registration skipped for Theater ${theater.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    persistDurableState();
    writeJson(res, 200, toTheaterInfo(theater, hasWiki));
  }

  async function handleObserverTheaterItem(req: http.IncomingMessage, res: http.ServerResponse, theaterId: string): Promise<void> {
    if (req.method !== "DELETE") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    // DELETE는 idempotent해야 한다 — Theater가 레지스트리에 이미 없어도(유령 항목이나 중복 forget) 목표 상태(부재)는
    // 이미 달성된 것이므로 404가 아닌 성공으로 처리하고, 남아 있을 수 있는 소속 Operation도 함께 정리한다.
    theaters.remove(theaterId);
    // Theater를 잊을 때 그 Theater가 소유한 root·nested Codex 워크스페이스를 모두 해제한다.
    // 다른 Theater가 같은 workspace id를 소유하면 등록을 유지한다.
    codex.unregisterTheaterWorkspaces(theaterId);
    for (const operation of operations.listByTheater(theaterId)) {
      pluginHostCapabilities.events.publish(OPERATION_DELETED_EVENT_CHANNEL, {
        operationId: operation.id,
        pluginId: operation.pluginId,
        type: operation.type,
      });
    }
    operations.deleteByTheater(theaterId);
    persistDurableState();
    writeJson(res, 200, { ok: true });
  }

  function handleStatus(req: http.IncomingMessage, res: http.ServerResponse): void {
    const theaterId = readUrl(req).searchParams.get("theaterId");
    const payload: ConsoleObserverStatus = {
      workspaces: operations.list().length,
      version,
      channel,
      ...updateCheck.getStatus(),
      port: lockHandle?.payload.port ?? port,
      portMode: portState.portMode,
      requestedPort: portState.requestedPort,
      effectivePort: portState.effectivePort,
      portHonored: portState.portHonored,
      wikiServerStatus: resolveWikiServerStatus(theaterId),
    };
    writeJson(res, 200, payload);
  }

  function handleObserverApiCatalog(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    writeJson(res, 200, { version, routes: buildApiCatalog() });
  }

  async function handleObserverReleaseNotes(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    try {
      const searchParams = readUrl(req).searchParams;
      const force = searchParams.get("force") === "true";
      const locale: ReleaseNotesLocale = searchParams.get("locale") === "ko" ? "ko" : "en";
      writeJson(res, 200, await releaseNotes.refresh({ force, locale }));
    } catch (error) {
      if (error instanceof ConsoleReleaseNotesUnavailableError) {
        writeJson(res, 503, { error: "release_notes_unavailable" });
        return;
      }
      throw error;
    }
  }

  async function handleUpdateApply(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isExactConsoleOrigin(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody<UpdateApplyBody>(req);
    if (body === null && requestHasBody(req)) {
      writeJson(res, 400, { error: "invalid_update_apply_body" });
      return;
    }
    if (body !== null && (!isPlainObject(body) || hasForbiddenUpdateApplyBodyKeys(body))) {
      writeJson(res, 400, { error: "invalid_update_apply_body" });
      return;
    }
    if (channel === "local") {
      writeJson(res, 403, { error: "local_channel" });
      return;
    }
    if (updateApplyInFlight) {
      writeJson(res, 409, { error: "update_already_in_progress" });
      return;
    }
    const freshStatus = await updateCheck.refresh({ force: true });
    if (!freshStatus.updateAvailable || !freshStatus.latestVersion) {
      writeJson(res, 409, { error: "update_not_available" });
      return;
    }
    const handle = lockHandle;
    if (!handle || !activeEndpoint || !activeLockFile) {
      writeJson(res, 503, { error: "console_not_ready" });
      return;
    }
    updateApplyInFlight = true;
    try {
      await updateApply.start({
        currentEndpoint: activeEndpoint,
        currentPackageRoot: release.packageRoot,
        currentPid: process.pid,
        dataDir: durablePaths.dir,
        lockFile: activeLockFile,
        targetVersion: freshStatus.latestVersion,
      });
    } catch {
      updateApplyInFlight = false;
      writeJson(res, 503, { error: "update_worker_unavailable" });
      return;
    }
    res.once("finish", () => {
      setImmediate(() => {
        void stopAfterAcceptedUpdateApply();
      });
    });
    const payload: ConsoleUpdateApplyAcceptedResponse = { status: "accepted" };
    writeJson(res, 202, payload);
  }

  // 카탈로그 gate 레이블은 "origin-write"로 개명됐지만 이 함수 이름은 별도 정리 범위.
  function isTerminalAuthorized(req: http.IncomingMessage): boolean {
    if (!lockHandle) return false;
    // Origin 검증으로 WS 경로와 동일한 출처 경계를 terminal 라우트에 적용한다.
    return isAllowedTerminalOrigin(req, lockHandle.payload.port ?? port);
  }

  function isLockAuthorized(req: http.IncomingMessage): boolean {
    const token = lockHandle?.payload.token;
    return !!token && req.headers.authorization === `Bearer ${token}`;
  }

  // 카탈로그 gate 레이블은 "origin-strict"로 개명됐지만 이 함수 이름은 별도 정리 범위.
  function isExactConsoleOrigin(req: http.IncomingMessage): boolean {
    if (!lockHandle) return false;
    return req.headers.origin === `http://127.0.0.1:${lockHandle.payload.port ?? port}`;
  }

  function listTheaterInfos(): readonly ConsoleTheaterInfo[] {
    return theaters.list().map((theater) => toTheaterInfo(theater, codex.getWorkspace(theater.id) !== null));
  }

  function toTheaterInfo(theater: TheaterRegistration, hasWiki: boolean): ConsoleTheaterInfo {
    return {
      id: theater.id,
      label: theater.label,
      createdAt: theater.registeredAt,
      lastOpenedAt: theater.lastOpenedAt,
      hasWiki,
      activeAdmiralCount: operations.listByTheater(theater.id).filter((operation) => operation.pluginId === "terminal" && operation.type === "agent").length,
    };
  }

  function resolveWikiServerStatus(theaterId: string | null): ConsoleObserverStatus["wikiServerStatus"] {
    if (!theaterId) return "unknown";
    if (!theaters.get(theaterId)) return "unknown";
    return codex.getWorkspace(theaterId) ? "available" : "unavailable";
  }

  async function stopAfterAcceptedUpdateApply(): Promise<void> {
    try {
      await stopServer();
    } catch (error) {
      console.warn(`[fleet-console] Update apply shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function cleanupAfterFailedStart(): Promise<void> {
    const current = server;
    const currentLoopback = loopbackServer;
    const currentLock = lockHandle;
    server = null;
    loopbackServer = null;
    lockHandle = null;
    activeLockFile = null;
    activeEndpoint = null;
    await Promise.all([
      closeHttpServer(current),
      closeHttpServer(currentLoopback),
    ]);
    await disposeConsoleResources(currentLock);
  }

  async function disposeConsoleResources(currentLock: ConsoleLockHandle | null): Promise<void> {
    updateCheck.stop?.();
    unsubscribeUpdateCheckChanges?.();
    unsubscribeUpdateCheckChanges = null;
    if (consoleResourcesDisposed) {
      currentLock?.release();
      return;
    }
    consoleResourcesDisposed = true;
    const cleanupResults = await Promise.allSettled([...pluginCleanupCallbacks].map((cleanup) => cleanup()));
    for (const result of cleanupResults) {
      if (result.status === "rejected") {
        console.warn(`[fleet-console] Plugin cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
    pluginCleanupCallbacks.clear();
    pluginEventListeners.clear();
    currentLock?.release();
  }

  async function rehydrateDurableState(): Promise<void> {
    let state: DurableConsoleState;
    try {
      state = durableStateStore.load();
      theaters.restore(state.theaters);
      operations.replace(state.operations);
      operations.replaceGroups(state.groups ?? []);
      const healed = await healRestoredPathContexts();
      if (healed) persistDurableState();
    } catch (error) {
      console.warn(`[fleet-console] Durable state restore skipped: ${error instanceof Error ? error.message : String(error)}`);
      state = emptyDurableConsoleState();
      theaters.restore([]);
      operations.replace([]);
      operations.replaceGroups([]);
    }
    // Codex WorkspaceRegistry는 인메모리라 재시작 시 비워진다. hasWiki 판정이 이 레지스트리에
    // 의존하므로(getWorkspace !== null), 복원된 Theater를 재등록하지 않으면 위키가 있는 Theater도
    // hasWiki=false가 되어 Console 재실행마다 Codex(Wiki)가 마운트되지 않는다. POST 추가 경로와
    // 대칭으로 복원 Theater의 워크스페이스를 best-effort 재등록한다.
    await restoreCodexWorkspaces();
  }

  async function healRestoredPathContexts(): Promise<boolean> {
    let healed = false;
    for (const theater of theaters.list()) {
      if (theater.pathContext === null) continue;
      try {
        const resolved = await resolveTheaterPathContext(theater.realpath, theater.pathContext);
        if (resolved.relPath !== theater.pathContext) {
          theaters.setPathContext(theater.id, resolved.relPath);
          healed = true;
        }
      } catch {
        theaters.setPathContext(theater.id, null);
        healed = true;
      }
    }
    return healed;
  }

  async function restoreCodexWorkspaces(): Promise<void> {
    // durable lastOpenedAt 오름차순으로 순차 등록하면서 durable 타임스탬프를 그대로 보존한다.
    // register()가 매번 MRU를 갱신하므로 가장 최근에 열린 Theater가 마지막에 등록되어 codex
    // MRU가 되고, durable 타임스탬프 보존으로 listRegistrations()의 동순위(같은 밀리초) 모호성
    // 없이 getMru() 기반 라우트가 재시작 후에도 durable 최근성 순서를 유지한다.
    // 등록은 durable realpath로 한다. theater.path(심볼릭일 수 있음)를 다시 정규화하면 정지 중
    // 심볼릭 타깃이 바뀐 경우 theater.id와 다른 workspaceHash로 등록되어 hasWiki 판정이 깨진다.
    const ordered = [...theaters.list()].sort((left, right) => left.lastOpenedAt.localeCompare(right.lastOpenedAt));
    for (const theater of ordered) {
      try {
        await codex.registerWorkspace(theater.realpath, theater.lastOpenedAt, theater.id);
      } catch (error) {
        // 위키 지식 루트가 없는 Theater는 Codex 미보유 상태가 정상이므로 조용히 건너뛴다.
        if (!(error instanceof Error && error.message === "knowledge_root_missing")) {
          console.warn(`[fleet-console] Codex workspace restore skipped for Theater ${theater.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  function broadcastOperationChanged(node: OperationNode): void {
    if (operationSseSubscribers.size === 0) return;
    const sensitiveFields = [
      ...(pluginHost.sensitiveFieldsByPluginId.get(node.pluginId) ?? []),
      ...(pluginPayloadSanitizers.get(node.pluginId) ?? []),
    ];
    const sanitized = createSanitizedOpDto(node, { sensitiveFields });
    const data = encodeSseData("operation:changed", { operation: sanitized });
    for (const res of operationSseSubscribers) {
      res.write(data);
    }
  }

  function broadcastUpdateAvailable(): void {
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData("update:available", {});
    for (const res of operationSseSubscribers) {
      res.write(data);
    }
  }

  function persistDurableState(): void {
    try {
      durableStateStore.save({
        version: 2,
        theaters: theaters.list(),
        operations: operations.list(),
        groups: operations.listAllGroups(),
      });
    } catch (error) {
      console.warn(`[fleet-console] Durable state save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function stopServer(): Promise<void> {
    const current = server;
    const currentLoopback = loopbackServer;
    const currentLock = lockHandle;
    server = null;
    loopbackServer = null;
    lockHandle = null;
    activeLockFile = null;
    activeEndpoint = null;
    try {
      await Promise.all([
        closeHttpServer(current),
        closeHttpServer(currentLoopback),
      ]);
    } finally {
      await disposeConsoleResources(currentLock);
    }
  }

  const returnedServer: ConsoleServer = {
    host,
    port,
    async start(lockPaths) {
      if (server && lockHandle) return lockHandle.payload.endpoint;
      try {
        await rehydrateDurableState();
        await pluginHost.boot();
        await pluginClientAssets.prepare();
        const listenPlan = resolveConsolePortListenPlan();
        const result = await listenConsolePort(listenPlan);
        server = result.srv;
        loopbackServer = result.localLoopbackServer;
        portState = result.portState;
        lockHandle = lock.writeLock({ dir: lockPaths.dir, lockFile: lockPaths.lockFile, pid: process.pid, port: result.actualPort, endpoint: result.endpoint, version });
        activeLockFile = lockPaths.lockFile;
        activeEndpoint = result.endpoint;
      } catch (error) {
        await cleanupAfterFailedStart();
        throw error;
      }
      if (!activeEndpoint) throw new Error("Console endpoint unavailable");
      if (unsubscribeUpdateCheckChanges === null) {
        unsubscribeUpdateCheckChanges = updateCheck.onChange?.(() => {
          broadcastUpdateAvailable();
        }) ?? null;
      }
      updateCheck.start?.();
      void updateCheck.refresh();
      return activeEndpoint;
    },
    async stop() {
      await stopServer();
    },
    async registerCodexWorkspace(cwd: string) {
      const workspace = await codex.registerWorkspace(cwd);
      return workspace.id;
    },
  };

  function resolveConsolePortListenPlan(): ConsolePortListenPlan {
    if (deps.port !== undefined) {
      return {
        port,
        requestedPort: null,
        portMode: "dynamic",
        allowFallback: false,
      };
    }
    const options = consoleSettingsStore.load().general ?? {};
    if (options.consolePortMode === "static" && isValidConsoleStaticPort(options.consoleStaticPort)) {
      return {
        port: options.consoleStaticPort,
        requestedPort: options.consoleStaticPort,
        portMode: "static",
        allowFallback: true,
      };
    }
    return {
      port: DEFAULT_PORT,
      requestedPort: null,
      portMode: "dynamic",
      allowFallback: false,
    };
  }

  async function listenConsolePort(plan: ConsolePortListenPlan): Promise<ConsolePortListenResult> {
    try {
      return await listenOnce(plan.port, {
        requestedPort: plan.requestedPort,
        portMode: plan.portMode,
        portHonored: true,
      });
    } catch (error) {
      if (!plan.allowFallback || plan.requestedPort === null) throw error;
      return listenOnce(DEFAULT_PORT, {
        requestedPort: plan.requestedPort,
        portMode: "static",
        portHonored: false,
      });
    }
  }

  function listenOnce(portToBind: number, statePatch: Omit<ConsolePortRuntimeState, "effectivePort">): Promise<ConsolePortListenResult> {
    return new Promise((resolve, reject) => {
      const srv = createHttpServer(handleRequest, upgradeRegistry);
      const onError = (error: Error) => {
        reject(error);
      };
      srv.once("error", onError);
      srv.listen(portToBind, host, async () => {
        srv.off("error", onError);
        const address = srv.address();
        const actualPort = typeof address === "object" && address ? address.port : portToBind;
        const endpoint = `http://${host}:${actualPort}/`;
        try {
          const localLoopbackServer = await maybeStartLoopbackServer(host, actualPort, handleRequest, upgradeRegistry);
          resolve({
            srv,
            localLoopbackServer,
            actualPort,
            endpoint,
            portState: {
              ...statePatch,
              effectivePort: actualPort,
            },
          });
        } catch (err) {
          await closeHttpServer(srv);
          reject(err);
        }
      });
    });
  }
  return returnedServer;
}

function resolveBuiltInPluginDiscoveryRoots(packageRoot: string): { readonly builtInSourceRoot?: string; readonly builtInDistRoot: string } {
  const packageRootRepo = path.resolve(packageRoot, "..", "..");
  const sourceRoot = path.join(packageRootRepo, "runtime", "fleet-plugins");
  return {
    ...(fs.existsSync(sourceRoot) ? { builtInSourceRoot: sourceRoot } : {}),
    builtInDistRoot: path.join(packageRoot, "dist", "fleet-plugins"),
  };
}

function createHttpServer(
  handler: http.RequestListener,
  upgradeRegistry: UpgradeRegistry,
): http.Server {
  const srv = http.createServer(handler);
  srv.timeout = SERVER_TIMEOUT_MS;
  srv.keepAliveTimeout = SERVER_TIMEOUT_MS;
  srv.headersTimeout = SERVER_TIMEOUT_MS + 1000;
  srv.on("upgrade", (req, socket, head) => {
    const pathname = getPathname(req);
    if (upgradeRegistry.handle({ req, socket, head, pathname })) return;
    socket.destroy();
  });
  return srv;
}

async function maybeStartLoopbackServer(
  host: string,
  actualPort: number,
  handler: http.RequestListener,
  upgradeRegistry: UpgradeRegistry,
): Promise<http.Server | null> {
  if (isLoopbackHost(host) || isWildcardHost(host)) return null;
  const srv = createHttpServer(handler, upgradeRegistry);
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(actualPort, "127.0.0.1", () => {
      srv.off("error", reject);
      resolve();
    });
  });
  return srv;
}

function closeHttpServer(srv: http.Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!srv) {
      resolve();
      return;
    }
    srv.close(() => resolve());
    srv.closeAllConnections?.();
  });
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function isWildcardHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "0:0:0:0:0:0:0:0";
}

function getPathname(req: http.IncomingMessage): string {
  return readUrl(req).pathname;
}

function readUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://127.0.0.1");
}

function theaterFolderListStatus(error: TheaterFolderListError): number {
  if (error.code === "forbidden") return 403;
  if (error.code === "not_found") return 404;
  return 400;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasForbiddenUpdateApplyBodyKeys(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((key) => UPDATE_APPLY_FORBIDDEN_BODY_KEYS.has(key));
}

function isValidConsoleStaticPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_CONSOLE_STATIC_PORT && value <= MAX_CONSOLE_STATIC_PORT;
}

function sanitizeLaunchKind(value: unknown): OperationLaunchKind | null {
  if (!isPlainObject(value) || typeof value.id !== "string" || typeof value.type !== "string" || typeof value.title !== "string") return null;
  return {
    id: value.id,
    type: value.type,
    title: value.title,
    ...(typeof value.disabled === "boolean" ? { disabled: value.disabled } : {}),
    ...(typeof value.disabledReason === "string" ? { disabledReason: value.disabledReason } : {}),
  };
}

function requestHasBody(req: http.IncomingMessage): boolean {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string" && contentLength !== "0") return true;
  return req.headers["transfer-encoding"] !== undefined;
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, withSecurityHeaders({ "Content-Type": "application/json" }));
  res.end(JSON.stringify(body));
}

function writeJavaScript(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, withSecurityHeaders({ "Content-Type": "text/javascript; charset=utf-8" }));
  res.end(body);
}

function runAsyncHandler(handler: Promise<void>, res: http.ServerResponse): void {
  void handler.catch(() => {
    if (res.writableEnded) return;
    if (res.headersSent) {
      res.end();
      return;
    }
    writeJson(res, 500, { error: "Internal server error" });
  });
}

function runAsyncBooleanHandler(handler: Promise<boolean>, res: http.ServerResponse, fallback?: () => boolean): void {
  void handler.then((handled) => {
    if (!handled && !res.writableEnded) {
      if (fallback?.()) return;
      writeJson(res, 404, { error: "Not found" });
    }
  }).catch(() => {
    if (res.writableEnded) return;
    if (res.headersSent) {
      res.end();
      return;
    }
    writeJson(res, 500, { error: "Internal server error" });
  });
}

function validateHost(req: http.IncomingMessage, expectedPort: number): boolean {
  if (req.url?.startsWith("http://") || req.url?.startsWith("https://")) return false;
  const hostHeaderCount = req.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === "host").length;
  if (hostHeaderCount !== 1) return false;
  const hostHeader = req.headers.host;
  if (!hostHeader) return false;
  return hostHeader === `127.0.0.1:${expectedPort}`;
}

// 신규 terminal 라우트의 출처 경계. 브라우저 요청은 console origin과 일치해야 하고,
// Origin 헤더가 없는 비브라우저(CLI/도구) 호출은 허용한다(기존 register 채널과의 호환).
function isAllowedTerminalOrigin(req: http.IncomingMessage, expectedPort: number): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${expectedPort}`;
}

async function readPluginStorageJson(dataDir: string, pluginId: string, key: string): Promise<unknown> {
  const file = resolvePluginStorageFile(dataDir, pluginId, key);
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writePluginStorageJson(dataDir: string, pluginId: string, key: string, value: unknown): Promise<void> {
  const file = resolvePluginStorageFile(dataDir, pluginId, key);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(value), "utf8");
}

function resolvePluginStorageFile(dataDir: string, pluginId: string, key: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId) || !/^[a-z0-9][a-z0-9._-]*$/i.test(key)) {
    throw new Error("invalid_plugin_storage_key");
  }
  return path.join(dataDir, "plugins", pluginId, `${key}.json`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
