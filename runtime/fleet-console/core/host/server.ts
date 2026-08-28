import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

import { createInfraServices, ensureWorkspaceDirectory, getFleetDataDir, withDirectoryLock } from "@dotobokuri/core-infra";
import { createWikiWorkspaceResolver } from "@dotobokuri/fleet-wiki";
import { readLaunchVariantGroups } from "@fleet-console/sdk/operations/launch-variants";

import { buildApiCatalog, type ApiCatalogEntry } from "./api-catalog.js";
import { CONTROL_CHANGED_EVENT, CONTROL_HOLDER_EVENT_CHANNEL, CONTROL_RECLAIMED_EVENT, controlChangedSnapshot, controlReclaimedSnapshot, type ControlHolderSnapshot, type ControlReclaimedReason } from "./access-control-contract.js";
import { createAccessRegistry, createLoopbackListenerIdentity, expirePairingCookie, formatPairingCookie, formatSessionCookie, listenerAuthority, listenerOrigin, readPairingCookie, readSessionCookie, resolveListenerIdentity, type AccessAudience, type AccessClass, type AccessSession, type ListenerIdentity } from "./auth.js";
import { createPairedDeviceStore, PAIRED_DEVICE_LIMIT } from "./paired-devices.js";
import { listRemoteInterfaces, probeRemoteIdentity } from "./remote-discovery.js";
import type { ConsoleEnvironmentDiagnostics, ConsoleHealth, ConsoleObserverStatus, ConsoleTheaterFolderListResponse, ConsoleTheaterInfo, ConsoleUpdateApplyAcceptedResponse, ConsoleUpdateApplyError } from "./console-contract-types.js";
import { createCodexWorkspaceRouter } from "./codex/workspace-routes.js";
import { createCodexGateway } from "./codex/gateway.js";
import { createCodexKnowledgeWatcher } from "./codex/knowledge-watcher.js";
import { CODEX_CHANGED_EVENT, CODEX_WATCH_EVENT } from "./codex/contracts.js";
import type { CodexKnowledgeScope, CodexWatchState } from "./codex/contracts.js";
import { acknowledgmentMatches, createConsoleSettingsStore, effectiveRemoteAccessAdvertisedTuple, REMOTE_AUTO_PORT_ATTEMPTS, REMOTE_AUTO_PORT_MAX, REMOTE_AUTO_PORT_MIN, type ConsoleRemoteAccessSettings, type ConsoleThemeId, type RemoteAccessSettingsChange } from "./settings/settings-domain.js";
import { DESKTOP_FULLSCREEN_EVENT, desktopFullscreenSnapshot } from "./desktop-contract.js";
import { createDesktopFullscreenRouter, createDesktopShellRouter, emptyDesktopShell, type DesktopShellSnapshot } from "./desktop-contract.js";
import { DESKTOP_THEME_EVENT, DESKTOP_UPDATE_EVENT, desktopThemeSnapshot, emptyDesktopUpdateRequest, type DesktopUpdateRequestSnapshot } from "./desktop-contract.js";
import { createDesktopThemeRouter, createDesktopUpdateRouter } from "./desktop-contract.js";
import { createDeferredDeletionCoordinator, DeferredDeletionError, type DeferredDeletionReceipt } from "./deferred-deletion.js";
import { backupDurableStateV3, createConsoleDurableStateStore, emptyDurableConsoleState, readDurableStateVersion, STATE_VERSION, type DurableConsoleState } from "./durable-state.js";
import { createGlobalSettingsRouter } from "./settings/settings-domain.js";
import { createPluginSettingsRouter } from "./settings/settings-domain.js";
import { createSystemFontsRouter, createSystemFontsService, type SystemFontsService } from "./system-fonts.js";
import { createConsoleLock, type ConsoleLockHandle } from "./lock.js";
import { readDesktopProtocolEnvironment } from "./desktop-protocol.js";
import { createOperationsRouter } from "./operations/operations-domain.js";
import { createSanitizedOpDto } from "./operations/operations-domain.js";
import { createOperationStore } from "./operations/operations-domain.js";
import type { OperationNode } from "./operations/operations-domain.js";
import { migrateLegacyCaptures } from "./legacy-capture-migration.js";
import { createConsoleDataPaths } from "./paths.js";
import { createRemoteEndpointStore } from "./remote-endpoint.js";
import { createRemoteIdentityStore, fingerprintsMatch } from "./remote-identity.js";
import { encodeAccessLink, parseAccessLink, sanitizeAccessLabel } from "./access-link.js";
import { createRemoteHostStore, type RemoteHostRecord } from "./remote-hosts.js";
import { createRemoteJoinGuard, normalizeRemoteJoinSource } from "./remote-join-guard.js";
import { listLocalConsoles } from "./local-consoles.js";
import { createPluginClientAssets } from "./plugin-host/plugin-host.js";
import { createFleetPluginHost } from "./plugin-host/plugin-host.js";
import type { FleetPluginHostCapabilities, OperationCatalogPlugin, OperationLaunchCatalogProvider, OperationLaunchKind, OperationLaunchView } from "./plugin-host/plugin-host.js";
import { readFleetConsoleRelease, type FleetConsoleRelease } from "./release.js";
import { createConsoleReleaseNotesService, type ConsoleReleaseNotesService } from "./release-notes/release-notes.js";
import { ConsoleReleaseNotesUnavailableError, type ReleaseNotesLocale } from "./release-notes/release-notes.js";
import { RouteRegistry } from "./route-registry/registry.js";
import { UpgradeRegistry } from "./route-registry/registry.js";
import { encodeSseData, startSseKeepaliveLifecycle, withSecurityHeaders } from "./http-infra.js";
import { createStaticConsoleHandler } from "./static-console.js";
import { listTheaterFolders, TheaterFolderListError } from "./theaters/theater-domain.js";
import { createFolderGrantStore } from "./theaters/theater-domain.js";
import type { TheaterRegistration } from "./theaters/theater-domain.js";
import { TheaterRegistry } from "./theaters/theater-domain.js";
import { canonicalizeTheaterPathSync, workspaceHash } from "./theaters/theater-domain.js";
import { createConsoleUpdateApplyService, isManagedRuntimePackageRoot, type ConsoleUpdateApplyService } from "./update-apply.js";
import { IDLE_CONSOLE_UPDATE_PROGRESS, readConsoleUpdateProgress, type ConsoleUpdateProgressStatus } from "./update-progress.js";
import { createConsoleUpdateCheckService, type ConsoleUpdateCheckService } from "./update-check.js";

export interface ConsoleServerDeps {
  readonly host?: string;
  readonly port?: number;
  readonly version?: string;
  readonly codexCwd?: string;
  readonly dataDir?: string;
  readonly pluginHomeDir?: string;
  readonly agentRuntime?: unknown;
  readonly release?: FleetConsoleRelease;
  readonly releaseNotes?: ConsoleReleaseNotesService;
  readonly updateCheck?: ConsoleUpdateCheckService;
  readonly updateApply?: ConsoleUpdateApplyService;
  readonly systemFonts?: SystemFontsService;
  /** 테스트가 Auto 포트 후보를 결정적으로 주입하는 경계. 반환값은 [min, maxExclusive) 범위다. */
  readonly remoteRandomInt?: (min: number, maxExclusive: number) => number;
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
type PatchTheaterBody = { readonly order?: unknown };
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

/**
 * SSE 구독자는 이제 자기가 어느 리스너에서 왔는지를 들고 다닌다. 제어권 이벤트의 수신자가
 * 구독자마다 다르기 때문이다 — 보유자 정보는 루프백만, 회수 통지는 끊긴 세션 하나만 받는다.
 * 평면 Set으로 두면 원격 화면에 다른 기기의 이름이 실려 나간다.
 */
interface OperationSseSubscriber {
  readonly res: http.ServerResponse;
  readonly audience: AccessAudience;
  /** 원격 구독자의 세션 공개 이름. 루프백 구독자는 null이다. */
  readonly sessionHandle: string | null;
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
/** 위임 요청의 시효. 수행자인 셸은 곧 이 창을 재시작하므로, 그보다 오래 걸려 있을 이유가 없다. */
const DESKTOP_UPDATE_REQUEST_TTL_MS = 60_000;
const UPDATE_APPLY_FORBIDDEN_BODY_KEYS = new Set(["channel", "package", "packageName", "packageVersion", "packages", "targetVersion", "version"]);
const OPERATION_RENAMED_EVENT_CHANNEL = "operation:renamed";
export const PAIRING_IDENTITY_PATH = "/api/v1/pairing-identity";
export const PAIRING_IDENTITY = { product: "fleet-console", schemaVersion: 1, pairingProtocolVersion: 1 } as const;
export const SERVER_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: PAIRING_IDENTITY_PATH,
    summary: "Read the loopback runtime pairing identity.",
    category: "Observer",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "GET",
    path: "/api/v1/status",
    summary: "콘솔 관측 상태를 조회합니다.",
    category: "Observer",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "GET",
    path: "/api/v1/settings/api-catalog",
    summary: "백엔드 API 카탈로그를 조회합니다.",
    category: "Observer",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "GET",
    path: "/api/v1/updates/release-notes",
    summary: "Get the console release notes.",
    category: "Update",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "GET",
    path: "/api/v1/theaters",
    summary: "Theater 목록을 조회합니다.",
    category: "Observer",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/theaters",
    summary: "새 Theater를 등록합니다.",
    category: "Observer",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "PATCH",
    path: "/api/v1/theaters/:theaterId",
    summary: "Theater 표시 순서를 변경합니다.",
    category: "Observer",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "DELETE",
    path: "/api/v1/theaters/:theaterId",
    summary: "Theater와 소속 Operation을 제거합니다.",
    category: "Observer",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/deletions/:deletionId/restore",
    summary: "유예 중인 Operation 또는 Theater 삭제를 복구합니다.",
    category: "Observer",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/theaters/:theaterId/codex-workspace",
    summary: "Resolve the Codex workspace for a Theater.",
    category: "Observer",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/theaters/folder-listings",
    summary: "Theater 폴더 선택 목록을 조회합니다.",
    category: "Observer",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/theaters/folder-grants",
    summary: "Theater 폴더 접근 grant를 발급합니다.",
    category: "Observer",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "GET",
    path: "/api/v1/updates/progress",
    summary: "Read the outcome of the update this console just came back from.",
    category: "Update",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/updates/apply",
    summary: "Request console update application.",
    category: "Update",
    gate: "origin-strict",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/access-grants",
    summary: "Issue a single-use grant that opens a console session.",
    category: "Access",
    gate: "lock-token",
    transport: "http",
  },
  {
    method: "GET",
    path: "/api/v1/access-links",
    summary: "Report the remote listener, its identity, its unused links, and the devices it has paired.",
    category: "Access",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "DELETE",
    path: "/api/v1/access-links/:linkId",
    summary: "Revoke one unused remote access link.",
    category: "Access",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "DELETE",
    path: "/api/v1/access-sessions/:sessionHandle",
    summary: "End one open remote session, leaving its pairing intact.",
    category: "Access",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "DELETE",
    path: "/api/v1/paired-devices/:deviceId",
    summary: "Unpair one device so it cannot rejoin without a new access link.",
    category: "Access",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/remote-identity/rotations",
    summary: "Issue a new remote certificate, invalidating every link, pin, and session for the old one.",
    category: "Access",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/access-links",
    summary: "Create a remote access link for this console.",
    category: "Access",
    gate: "lock-token",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/join",
    summary: "Exchange a single-use grant for a pairing, or resume an existing pairing.",
    category: "Access",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "GET",
    path: "/api/v1/remote-hosts",
    summary: "List the other consoles this one can jump to.",
    category: "Access",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/remote-hosts",
    summary: "Remember another console from its access link, after confirming its certificate.",
    category: "Access",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "PATCH",
    path: "/api/v1/remote-hosts/:hostId",
    summary: "Rename a remembered console.",
    category: "Access",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "DELETE",
    path: "/api/v1/remote-hosts/:hostId",
    summary: "Forget a remembered console and its certificate pin.",
    category: "Access",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/remote-hosts/:hostId/probes",
    summary: "Check whether a remembered console answers and still presents its pinned certificate.",
    category: "Access",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "GET",
    path: "/api/v1/local-consoles",
    summary: "List the consoles running on this machine that this one can point a window at.",
    category: "Access",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "POST",
    path: "/api/v1/desktop/handoff",
    summary: "Hand the attached Desktop what it needs to open one remembered console, consuming any pending grant.",
    category: "Desktop",
    gate: "origin-write",
    transport: "http",
  },
  {
    method: "GET",
    path: "/api/v1/health",
    summary: "Check console status with the lock token.",
    category: "Health",
    gate: "lock-token",
    transport: "http",
  },
];

export const REMOTE_HOSTS_PATH = "/api/v1/remote-hosts";
export const LOCAL_CONSOLES_PATH = "/api/v1/local-consoles";
const REMOTE_HOST_HANDOFF_PATH = "/api/v1/desktop/handoff";

export function createConsoleServer(deps: ConsoleServerDeps = {}): ConsoleServer {
  const host = deps.host ?? DEFAULT_HOST;
  const port = deps.port ?? DEFAULT_PORT;
  const release = deps.release ?? readFleetConsoleRelease();
  // Validate and retain v1 provenance solely for lock ownership emission. It must not
  // influence channel, health, update, or CLI feature behavior.
  const desktop = readDesktopProtocolEnvironment();
  // 버전은 런타임에 package.json을 읽는 release.ts SSoT에서 해석한다(channel과 동일 경로).
  // 과거 빌드타임 상수(__PKG_VERSION__)는 tsup define에 주입된 적이 없어 항상 "0.0.0-dev"로
  // 폴백되는 죽은 경로였다. deps.version은 테스트 오버라이드용으로 유지한다.
  const version = deps.version ?? release.version;
  const channel = release.channel;
  // 한 번의 기동에만 유효한 지시다. 읽자마자 환경에서 지운다 — 남겨 두면 이 콘솔이 나중에
  // 띄우는 자식들까지 오래된 포트에 묶인다.
  const resumePort = takeConsoleResumePort(process.env);
  const lock = createConsoleLock({ hostname: () => host });
  const releaseNotes = deps.releaseNotes ?? createConsoleReleaseNotesService();
  const updateCheck = deps.updateCheck ?? createConsoleUpdateCheckService({ readRelease: () => release });
  const updateApply = deps.updateApply ?? createConsoleUpdateApplyService();
  const theaters = new TheaterRegistry();
  const operations = createOperationStore();
  const folderGrants = createFolderGrantStore();
  const infraServices = createInfraServices();
  // channel은 createConsoleDataPaths가 release SSoT로 자체 감지한다(hook 서브프로세스·fallback과 동일 경로).
  // 플러그인 fleet 루트: 명시 dataDir → (FLEET_DATA_DIR 부재 시) 콘솔 슬롯 override → getFleetDataDir.
  // Fleet 데이터 루트는 fleet-cli·Desktop과 공유하는 전역 상태라 채널 분기는 적용하지 않는다.
  //
  // FLEET_DATA_DIR이 루트의 정식 소유자다(getFleetDataDir이 읽는다). 콘솔 슬롯 override를 루트로
  // 승격시키는 아래 폴백은 그 변수가 없던 시절의 하위호환 경로다 — 콘솔 슬롯만 지정하고 격리를
  // 기대하던 실행이 조용히 실사용자 루트로 돌아가지 않게 남겨 둔다. 루트가 명시되면 슬롯은
  // 슬롯일 뿐이므로 루트를 참칭해서는 안 된다.
  const consoleSlotOverride = process.env.FLEET_CONSOLE_DATA_DIR ?? process.env.FLEET_CONSOLE_DIR;
  const fleetDataDir = deps.dataDir
    ?? (process.env.FLEET_DATA_DIR === undefined ? consoleSlotOverride : undefined)
    ?? getFleetDataDir();
  const durablePaths = createConsoleDataPaths({ fleetDataDir: deps.dataDir });
  const durableStateStore = createConsoleDurableStateStore({ paths: durablePaths });
  const consoleSettingsStore = createConsoleSettingsStore({ paths: durablePaths });
  const tryServeStaticConsole = createStaticConsoleHandler(release.packageRoot, {
    getActiveTheme: () => consoleSettingsStore.load().general?.theme ?? "instrument",
    getLiquidGlass: () => consoleSettingsStore.load().general?.liquidGlass ?? true,
  });
  const wikiWorkspaceResolver = createWikiWorkspaceResolver({
    ensureWorkspace: (cwd) => {
      const workspace = ensureWorkspaceDirectory(fleetDataDir, cwd);
      return { cwd: workspace.cwd, path: workspace.path };
    },
    withMigrationLock: (workspace, operation) => withDirectoryLock({
      lockDir: path.join(workspace.path, "knowledge.migration.lock"),
    }, operation),
  });
  const codexKnowledgeWatcher = createCodexKnowledgeWatcher({
    onChange: (workspaceId, scopes) => broadcastCodexChanged(workspaceId, scopes),
    onState: (workspaceId, state) => broadcastCodexWatchState(workspaceId, state),
  });
  const codex = createCodexGateway({
    cwd: deps.codexCwd ?? process.cwd(),
    host,
    version,
    getPort: () => lockHandle?.payload.port ?? port,
    resolveListener: (request) => listenerForRequest(request),
    wikiWorkspaceResolver,
    dataDir: durablePaths.dir,
    onKnowledgeRootResolved: (workspaceId, knowledgeRoot) => codexKnowledgeWatcher.watch(workspaceId, knowledgeRoot),
    onWorkspaceReleased: (workspaceId) => codexKnowledgeWatcher.unwatch(workspaceId),
  });
  const routeRegistry = new RouteRegistry();
  const upgradeRegistry = new UpgradeRegistry();
  // 리스너는 바인드 시점에 확정된다. 요청은 소켓의 로컬 주소로 자기 리스너를 찾고, 그
  // 리스너의 audience·Host·Origin만 통과 기준으로 삼는다.
  let listeners: readonly ListenerIdentity[] = [];
  let remoteServer: https.Server | null = null;
  let remoteFingerprint: string | null = null;
  let remoteReconcile: Promise<void> = Promise.resolve();
  let remoteLastError: string | null = null;
  // 리스너와 수명을 같이한다 — 영속되는 값이 아니라 지금 열려 있는 문에 대한 계량이다.
  const remoteJoinGuard = createRemoteJoinGuard();
  let boundPort: number | null = null;
  /**
   * 만료도 회수와 같은 신호를 낸다. prune은 다른 레지스트리 호출 안에서 도는 일이 많아
   * 브로드캐스트를 그 자리에서 부르면 listSessions -> prune으로 되돌아온다. 다음 틱으로
   * 미뤄 재진입을 끊는다.
   */
  let controlPruneNotifyQueued = false;
  /** 마지막으로 알린 보유자의 공개 이름. 바뀌지 않은 사실을 신호로 내보내지 않기 위한 기준이다. */
  let lastPublishedControlHolder: string | null = null;
  const access = createAccessRegistry({
    onSessionsPruned: () => {
      if (controlPruneNotifyQueued) return;
      controlPruneNotifyQueued = true;
      queueMicrotask(() => {
        controlPruneNotifyQueued = false;
        broadcastControlChanged();
      });
    },
  });
  const remoteIdentityStore = createRemoteIdentityStore(durablePaths.dir);
  const remoteHostStore = createRemoteHostStore(durablePaths.dir);
  const pairedDeviceStore = createPairedDeviceStore(durablePaths.dir);
  const remoteEndpointStore = createRemoteEndpointStore(durablePaths.dir);
  const pluginOperationTypes = new Set<string>();
  const pluginPayloadSanitizers = new Map<string, readonly string[]>();
  const pluginLaunchCatalogProviders = new Map<string, OperationLaunchCatalogProvider[]>();
  const pluginCleanupCallbacks = new Set<() => void | Promise<void>>();
  const pluginEventListeners = new Map<string, Set<(payload: unknown) => void>>();
  const operationSseSubscribers = new Set<OperationSseSubscriber>();
  const desktopThemeSseSubscribers = new Set<http.ServerResponse>();
  const desktopUpdateSseSubscribers = new Set<http.ServerResponse>();
  /**
   * 대기 중인 위임 요청. 리스너와 수명을 같이하는 휘발 상태다 — 셸이 앱을 재시작하면
   * 이 콘솔도 함께 내려가므로, 재기동 후까지 살아남아야 할 사실이 아니다.
   */
  let desktopUpdateRequest: DesktopUpdateRequestSnapshot = emptyDesktopUpdateRequest();
  /**
   * 걸어 둔 요청은 붙는 구독자마다 다시 들려준다. 그래서 시효가 없으면, 한참 뒤에 붙은
   * 셸이 사용자가 잊은 요청으로 앱을 재시작한다 — 요청은 눌린 그 순간의 것이다.
   */
  let desktopUpdateRequestedAt = 0;
  const pluginSseChannels = new Set<string>();

  /**
   * Theater 생명주기. 플러그인이 Theater마다 자기 저장소를 열고 닫으려면 이 순간들을
   * 알아야 한다 — 새 API를 내지 않고 기존 이벤트 채널로 낸다(구독 방식이 이미 있다).
   * realpath는 싣지 않는다: 절대 경로는 호스트 소유이고, 필요한 플러그인은
   * `paths.resolveTheaterPath`로 서버 안에서 스스로 푼다.
   */
  function publishTheaterLifecycle(event: "registered" | "forgotten" | "restored", theaterId: string): void {
    publishPluginEvent(`theater:${event}`, { theaterId });
  }

  function publishPluginEvent(channel: string, payload: unknown): void {
    for (const listener of pluginEventListeners.get(channel) ?? []) listener(payload);
    // 브라우저로 나가는 것은 플러그인이 명시적으로 올린 채널뿐이다. 모든 in-process
    // 이벤트를 흘리면 서버 내부 채널이 그대로 브라우저 계약이 되고, 그중 하나는
    // 언젠가 민감한 필드를 싣는다.
    if (!pluginSseChannels.has(channel) || operationSseSubscribers.size === 0) return;
    const data = encodeSseData(channel, payload);
    for (const subscriber of operationSseSubscribers) subscriber.res.write(data);
  }
  const deletionCoordinator = createDeferredDeletionCoordinator({
    operations,
    theaters,
    save: saveDurableState,
    publish: publishPluginEvent,
    unregisterTheaterWorkspaces: (theaterId) => {
      codex.unregisterTheaterWorkspaces(theaterId);
      publishTheaterLifecycle("forgotten", theaterId);
    },
    validateTheaterRestore: async (theater) => {
      try {
        const restoredRealpath = await fs.promises.realpath(theater.path);
        const stat = await fs.promises.stat(restoredRealpath);
        if (!stat.isDirectory() || restoredRealpath !== theater.realpath || workspaceHash(restoredRealpath) !== theater.id) {
          throw new Error("restore_conflict");
        }
      } catch {
        throw new DeferredDeletionError(409, "restore_parent_missing");
      }
    },
    registerTheaterWorkspace: async (theater) => {
      await codex.registerWorkspace(theater.realpath, theater.lastOpenedAt, theater.id);
      publishTheaterLifecycle("restored", theater.id);
    },
  });
  // 플러그인 capability는 기존 boolean 표면을 유지하되 실제 삭제는 receipt coordinator가 소유한다.
  function deleteOperationForPlugin(operationId: string): boolean {
    return deletionCoordinator.deleteOperation(operationId) !== null;
  }
  let desktopFullscreen = false;
  /**
   * 셸의 집 주소를 되돌려 받을 자격은 그것을 게시한 창에만 있다.
   *
   * 이 값은 루프백 주소다. 다른 사람의 화면에 흘러가면 거기서는 그 사람의 기계를 가리키고,
   * 같은 포트를 쓰는 전혀 다른 콘솔로 데려간다. 그래서 게시한 세션(원격) 또는 루프백 요청
   * 자신(local)에게만 되돌려 준다.
   *
   * 소유자별로 나눠 담는다. 한 칸만 두면 마지막에 게시한 창이 앞의 것을 지우므로, 원격 Desktop이
   * 붙는 순간 이 기계 앞 사람의 집 주소가 사라져 호스트 스위처에서 Home이 없어진다 — 두 창은
   * 서로 다른 기계를 가리키고 있어 덮어쓸 관계가 아니다.
   */
  const desktopShellsByOwner = new Map<string | "local", DesktopShellSnapshot>();
  // 창을 들고 있는 Desktop이 게시하는 호스트 목록. 브라우저 단독이면 비어 있다.
  let unsubscribeUpdateCheckChanges = updateCheck.onChange?.(() => {
    broadcastUpdateAvailable();
  }) ?? null;
  const pluginHostCapabilities: FleetPluginHostCapabilities = {
    operations: {
      list: () => operations.list(),
      get: (id) => operations.get(id),
      create: (input) => {
        if (input.id && deletionCoordinator.hasPendingOperation(input.id)) throw new Error("pending_deletion");
        const operation = operations.create(input);
        persistDurableState();
        return operation;
      },
      patch: (id, input) => {
        const before = operations.get(id);
        const operation = operations.patch(id, input);
        if (operation && before) {
          persistDurableState();
          // 브라우저가 볼 수 있는 투영이 실제로 달라졌을 때만 밀어낸다 — 민감 필드
          // (providerSession 등)만 바뀐 patch는 sanitized DTO가 같아 계속 침묵하고,
          // payload 모드 마커(예: chatMode)처럼 뷰 분기를 쥔 변화는 리로드 없이 도달한다.
          if (sanitizedOperationJson(before) !== sanitizedOperationJson(operation)) {
            broadcastOperationChanged(operation);
          }
        } else if (operation) {
          persistDurableState();
        }
        return operation;
      },
      delete: deleteOperationForPlugin,
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
      publish: publishPluginEvent,
      subscribe: (channel, listener) => {
        const listeners = pluginEventListeners.get(channel) ?? new Set<(payload: unknown) => void>();
        listeners.add(listener);
        pluginEventListeners.set(channel, listeners);
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) pluginEventListeners.delete(channel);
        };
      },
      /**
       * 이 채널의 publish를 브라우저 SSE 스트림으로도 내보낸다.
       *
       * 코어가 Operation 스트림을 소유하므로 플러그인은 두 번째 EventSource를 열지
       * 않고 같은 연결에 올라탄다 — 연결이 하나면 재접속·순서·생명주기도 하나다.
       */
      registerSseChannel: (channel: string) => {
        pluginSseChannels.add(channel);
        return () => {
          pluginSseChannels.delete(channel);
        };
      },
    },
    server: {
      origin: () => {
        const activePort = lockHandle?.payload.port ?? port;
        return activePort ? `http://127.0.0.1:${activePort}` : null;
      },
    },
    paths: {
      fleetDataDir,
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
      validateHost: isRequestHostAllowed,
      isTerminalAuthorized,
      isLockAuthorized,
      resolveTerminalSocketRole,
    },
    lifecycle: {
      registerCleanup: (cleanup) => {
        pluginCleanupCallbacks.add(cleanup);
        return () => pluginCleanupCallbacks.delete(cleanup);
      },
    },
  };
  // 번들 캐시가 durable dir(FLEET_CONSOLE_DIR 추종)로 이동해 번들 파일 위치 기준의 조상 탐색으로는
  // 콘솔 패키지를 찾지 못할 수 있다 — 플러그인 external(node-pty·ws) 해석용 패키지 루트를 명시로 전달한다.
  process.env.FLEET_CONSOLE_PACKAGE_ROOT = release.packageRoot;
  const pluginHost = createFleetPluginHost({
    ...resolveBuiltInPluginDiscoveryRoots(release.packageRoot),
    homeDir: deps.pluginHomeDir,
    bundleCacheDir: path.join(durablePaths.dir, "plugin-cache"),
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
  const globalSettingsRouter = createGlobalSettingsRouter({
    consoleSettingsStore,
    isAuthorized: isTerminalAuthorized,
    isRemoteAccessOwner: isLoopbackListener,
    readJsonBody,
    writeJson,
    onThemeChanged: broadcastDesktopThemeChanged,
    onRemoteAccessChanged: (change) => reconcileRemoteAccess(change),
  });
  const desktopThemeRouter = createDesktopThemeRouter({
    getTheme: () => consoleSettingsStore.load().general?.theme ?? "instrument",
    isAuthorized: isExactConsoleOrigin,
    writeJson,
    subscribe: (res, snapshot) => {
      res.writeHead(200, withSecurityHeaders({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      }));
      res.write(":connected\n\n");
      res.write(encodeSseData(DESKTOP_THEME_EVENT, snapshot));
      desktopThemeSseSubscribers.add(res);
      res.on("close", () => {
        desktopThemeSseSubscribers.delete(res);
      });
    },
  });
  const desktopUpdateRouter = createDesktopUpdateRouter({
    getUpdateRequest: () => readDesktopUpdateRequest(),
    isAuthorized: isExactConsoleOrigin,
    writeJson,
    subscribe: (res, snapshot) => {
      res.writeHead(200, withSecurityHeaders({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      }));
      res.write(":connected\n\n");
      res.write(encodeSseData(DESKTOP_UPDATE_EVENT, snapshot));
      desktopUpdateSseSubscribers.add(res);
      res.on("close", () => {
        desktopUpdateSseSubscribers.delete(res);
      });
    },
  });
  const desktopShellRouter = createDesktopShellRouter({
    getShell: (req) => {
      const owner = shellOwnerOf(req);
      return (owner === null ? undefined : desktopShellsByOwner.get(owner)) ?? emptyDesktopShell();
    },
    isAuthorized: isExactConsoleOrigin,
    readJsonBody,
    setShell: (req, snapshot) => {
      const owner = shellOwnerOf(req);
      if (owner === null) return;
      // homeOrigin이 비면 그 창은 더 이상 집을 주장하지 않는다 — 빈 스냅샷을 남기는 대신 지운다.
      if (snapshot.homeOrigin === null) desktopShellsByOwner.delete(owner);
      else desktopShellsByOwner.set(owner, snapshot);
    },
    writeJson,
    writeNoContent: (res) => { res.writeHead(204, withSecurityHeaders({})); res.end(); },
  });
  const desktopFullscreenRouter = createDesktopFullscreenRouter({
    getFullscreen: () => desktopFullscreen,
    isAuthorized: isExactConsoleOrigin,
    readJsonBody,
    setFullscreen: (fullscreen) => {
      desktopFullscreen = fullscreen;
      broadcastDesktopFullscreenChanged();
    },
    writeJson,
    writeNoContent,
  });
  const pluginSettingsRouter = createPluginSettingsRouter({
    consoleSettingsStore,
    isAuthorized: isTerminalAuthorized,
    readJsonBody,
    writeJson,
  });
  const systemFontsRouter = createSystemFontsRouter({
    systemFonts: deps.systemFonts ?? createSystemFontsService(),
    writeJson,
  });
  const codexWorkspaceRouter = createCodexWorkspaceRouter({
    getTheater: (theaterId) => theaters.get(theaterId),
    isAuthorized: isTerminalAuthorized,
    readJsonBody,
    resolveWorkspace: (theaterId, theaterRoot) => codex.resolveWorkspaceForTheater(theaterId, theaterRoot),
    writeJson,
  });
  const operationsRouter = createOperationsRouter({
    store: operations,
    isAuthorized: isTerminalAuthorized,
    readJsonBody,
    writeJson,
    persist: persistDurableState,
    deleteOperation: (operationId): DeferredDeletionReceipt | null => deletionCoordinator.deleteOperation(operationId),
    isPendingDeletion: (operationId) => deletionCoordinator.hasPendingOperation(operationId),
    getPluginSensitiveFields: (pluginId) => [
      ...(pluginHost.sensitiveFieldsByPluginId.get(pluginId) ?? []),
      ...(pluginPayloadSanitizers.get(pluginId) ?? []),
    ],
    resolveLaunchCatalog: resolveOperationCatalog,
    publishRenameEvent: (event) => pluginHostCapabilities.events.publish(OPERATION_RENAMED_EVENT_CHANNEL, event),
    broadcastOperationChanged,
    subscribeOperationSse: (req, res) => {
      res.writeHead(200, withSecurityHeaders({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      }));
      res.write(":connected\n\n");
      res.write(encodeSseData(DESKTOP_FULLSCREEN_EVENT, desktopFullscreenSnapshot(desktopFullscreen)));
      const listener = listenerForRequest(req);
      const audience: AccessAudience = listener?.audience ?? "local";
      const sessionHandle = listener === null || listener.audience === "local"
        ? null
        : access.resolveSession(readSessionCookie(req.headers, listener.port), listener.audience)?.handle ?? null;
      // 루프백은 붙는 순간 현재 보유자를 받는다 — 커튼은 세션이 열린 뒤에 새로고침한 화면에서도
      // 떠 있어야 하고, 이벤트만으로는 그 사이에 놓친 사실을 되찾을 수 없다.
      if (audience === "local") {
        res.write(encodeSseData(CONTROL_CHANGED_EVENT, controlChangedSnapshot(currentControlHolder())));
      }
      // 이 화면이 붙기 전에 시작된 감시는 이벤트로 다시 오지 않는다 — 지금 상태를 실어 보낸다.
      for (const entry of codexKnowledgeWatcher.snapshot()) {
        res.write(encodeSseData(CODEX_WATCH_EVENT, entry));
      }
      const subscriber: OperationSseSubscriber = { res, audience, sessionHandle };
      operationSseSubscribers.add(subscriber);
      startSseKeepaliveLifecycle(res, () => {
        operationSseSubscribers.delete(subscriber);
      });
    },
  });
  routeRegistry.register("/api/v1/operations", operationsRouter);
  routeRegistry.register("/api/v1/theaters", async (context) => {
    return codexWorkspaceRouter(context);
  });
  routeRegistry.register("/api/v1/settings", async (ctx) => {
    const { req, res, pathname } = ctx;
    if (pathname === "/api/v1/settings/api-catalog") {
      handleObserverApiCatalog(req, res);
      return true;
    }
    if (await pluginSettingsRouter(ctx)) return true;
    if (await systemFontsRouter(ctx)) return true;
    return globalSettingsRouter(ctx);
  });
  routeRegistry.register("/api/v1/desktop", async (context) => {
    if (await desktopShellRouter(context)) return true;
    if (await desktopFullscreenRouter(context)) return true;
    if (desktopUpdateRouter(context)) return true;
    return desktopThemeRouter(context);
  });
  routeRegistry.register("/plugin-runtime", handlePluginRuntimeRoute);

  // 요청과 업그레이드가 같은 Host 경계를 쓰도록 판정을 한 곳에 둔다.
  function isRequestHostAllowed(req: http.IncomingMessage): boolean {
    const listener = listenerForRequest(req);
    return listener !== null && validateHost(req, listenerAuthority(listener.host, listener.port, listener.secure), listener.secure);
  }

  /** 요청이 도착한 리스너. 등록되지 않은 소켓에서 온 요청은 어떤 게이트도 통과하지 못한다. */
  function listenerForRequest(req: http.IncomingMessage): ListenerIdentity | null {
    return resolveListenerIdentity(listeners, req.socket);
  }

  /**
   * 원격 리스너는 기본 거부다. 조인 문서와 조인 엔드포인트만 세션 없이 지나갈 수 있고,
   * 나머지는 모두 이 리스너에서 발급된 세션을 요구한다. 라우트마다 흩어진 게이트에 원격을
   * 맡기면 하나만 빠져도 통째로 열리므로, 판정을 라우팅 이전 한 곳에서 끝낸다.
   */
  function isRemoteRequestAdmitted(listener: ListenerIdentity, req: http.IncomingMessage, pathname: string): boolean {
    // 세션 없이 지나는 경로는 이 하나뿐이다. 페어링은 전용 앱으로만 이루어지고 브라우저는
    // 자기서명 인증서의 지문을 대조할 수 없으므로, 브라우저를 향한 안내 표면을 두지 않는다.
    if (pathname === "/api/v1/join") return true;
    const session = access.resolveSession(readSessionCookie(req.headers, listener.port), listener.audience);
    if (session === null) return false;
    // monitoring 자격은 보기만 한다. 등급이 사고 후 범위를 좁히려면 여기서 실제로 막혀야 한다.
    return session.access !== "monitoring" || isReadOnlyRequest(req);
  }

  /** 읽기로 볼 수 있는 것만. 터미널 업그레이드는 method가 GET이어도 쓰기다. */
  function isReadOnlyRequest(req: http.IncomingMessage): boolean {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    return String(req.headers.upgrade ?? "").toLowerCase() !== "websocket";
  }

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = getPathname(req);
    /**
     * 원격 판정은 어떤 분기보다 먼저 끝난다. Codex 게이트웨이는 자기만의 Host 검사만 하므로,
     * 그 조기 반환이 이 판정 위에 있으면 세션 없는 요청이 `Host: 127.0.0.1:<port>` 하나로
     * 원격 리스너를 통과해 Wiki 내용을 받아 간다(실측). 분기가 하나 늘 때마다 문이 하나 열리는
     * 구조를 두지 않으려면 판정이 라우팅 앞에 있어야 한다.
     */
    const listener = listenerForRequest(req);
    if (listener && listener.audience !== "local" && !isRemoteRequestAdmitted(listener, req, pathname)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (pathname === "/console/codex" || pathname.startsWith("/console/codex/")) {
      runAsyncBooleanHandler(codex.handle(req, res), res, () => tryServeStaticConsole(req, res, pathname));
      return;
    }
    // Host 게이트는 순서를 바꾸지 않는다 — Codex는 wildcard 바인드에서 더 넓은 host 집합을 쓰므로
    // 자기 게이트를 그대로 유지한다. 대신 같은 리스너 판정을 주입받아, 원격 리스너의 Host·Origin도
    // 그 게이트가 알고 있다.
    if (!isRequestHostAllowed(req)) {
      writeJson(res, 403, { error: "host_mismatch" });
      return;
    }
    if (pathname === PAIRING_IDENTITY_PATH) {
      handlePairingIdentity(req, res);
      return;
    }
    if (tryServeStaticConsole(req, res, pathname)) return;
    if (pathname === "/api/v1/health") {
      handleHealth(req, res);
      return;
    }
    if (pathname === "/api/v1/access-grants") {
      handleAccessGrantIssue(req, res);
      return;
    }
    if (pathname === "/api/v1/access-links") {
      if (req.method === "GET") handleRemoteAccessStatus(req, res);
      else handleAccessLinkIssue(req, res);
      return;
    }
    if (pathname.startsWith("/api/v1/access-links/")) {
      handleAccessLinkRevoke(req, res, pathname.slice("/api/v1/access-links/".length));
      return;
    }
    if (pathname.startsWith("/api/v1/access-sessions/")) {
      handleAccessSessionRevoke(req, res, pathname.slice("/api/v1/access-sessions/".length));
      return;
    }
    if (pathname.startsWith("/api/v1/paired-devices/")) {
      handlePairedDeviceRevoke(req, res, pathname.slice("/api/v1/paired-devices/".length));
      return;
    }
    if (pathname === "/api/v1/remote-identity/rotations") {
      runAsyncBooleanHandler(handleRemoteIdentityRotation(req, res), res);
      return;
    }
    if (pathname === "/api/v1/join") {
      runAsyncBooleanHandler(handleAccessJoin(req, res), res);
      return;
    }
    if (pathname === REMOTE_HOSTS_PATH || pathname.startsWith(`${REMOTE_HOSTS_PATH}/`)) {
      runAsyncBooleanHandler(handleRemoteHosts(req, res, pathname), res);
      return;
    }
    if (pathname === LOCAL_CONSOLES_PATH) {
      runAsyncBooleanHandler(handleLocalConsoles(req, res), res);
      return;
    }
    if (pathname === REMOTE_HOST_HANDOFF_PATH) {
      runAsyncBooleanHandler(handleRemoteHostHandoff(req, res), res);
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
    if (pathname === "/api/v1/environment") {
      handleEnvironmentDiagnostics(req, res);
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
    const restoreMatch = pathname.match(/^\/api\/v1\/deletions\/([^/]+)\/restore$/);
    if (restoreMatch) {
      runAsyncHandler(handleDeferredDeletionRestore(req, res, decodeURIComponent(restoreMatch[1] ?? "")), res);
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
    if (pathname === "/api/v1/updates/progress") {
      handleUpdateProgress(req, res);
      return;
    }
    if (pathname === "/api/v1/updates/apply") {
      runAsyncHandler(handleUpdateApply(req, res), res);
      return;
    }
    res.writeHead(404);
    res.end();
  }

  function handlePairingIdentity(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    // Discovery only: no process, path, owner, or durable-state data; no CORS/bearer change.
    writeJson(res, 200, PAIRING_IDENTITY);
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
        ...(payload.owner ? { owner: payload.owner } : {}),
        workspaceCount: operations.list().length,
      };
      writeJson(res, 200, body);
      return;
    }
    writeJson(res, 401, { error: "Unauthorized" });
  }

  // 조인 자격 발급. 로컬 자격이라도 링크와 같은 grant 문법을 거치게 해서, 세션을 여는
  // 경로가 하나로 유지되도록 한다. 락 토큰은 이미 프로세스 제어 권한이므로 로컬 세션으로의
  // 교환은 권한 확대가 아니라 축소다.
  function handleAccessGrantIssue(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const listener = listenerForRequest(req);
    if (!listener || !isLockAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const grant = access.issueGrant(listener.audience);
    writeJson(res, 201, { token: grant.token, audience: grant.audience, expiresAt: grant.expiresAt });
  }

  /**
   * 원격 리스너의 실제 상태. 설정값이 아니라 지금 열려 있는 리스너를 보고한다 — 켜 두었지만
   * 바인드에 실패한 경우를 설정 화면이 "켜짐"으로 오독하지 않게 한다.
   */
  function handleRemoteAccessStatus(req: http.IncomingMessage, res: http.ServerResponse): void {
    /**
     * 읽기는 루프백이라는 사실만 요구한다 — 형제인 remote-hosts GET과 같은 선례다. Origin까지
     * 요구하면 브라우저가 아닌 로컬 소비자(Desktop·진단 도구)가 함께 막힌다.
     *
     * 원격을 막는 것이 요점이다. 이 응답에는 인증서 지문, 열린 세션의 기기 이름, 미사용 링크,
     * 그리고 이 기계가 가진 모든 주소가 실린다 — 초대받은 손님이 볼 목록이 아니다.
     */
    if (!isLoopbackListener(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const remote = listeners.find((entry) => entry.audience === "remote");
    const sessions = access.listSessions("remote");
    writeJson(res, 200, {
      listener: {
        listening: remote !== undefined && remoteFingerprint !== null,
        origin: remote?.origin ?? null,
        lastError: remoteLastError,
      },
      publicReachability: "unverified",
      // 거절이 일어나고 있다는 사실 자체가 "지금 열어둘 만한가"의 판단 재료다.
      rejectedJoins: remoteJoinGuard.stats(),
      fingerprint: remoteFingerprint,
      // 발급 사실만 나간다 — 목록을 보는 것으로는 어떤 링크도 다시 쓸 수 없다.
      links: access.listGrants("remote"),
      /**
       * 화면이 보는 단위는 페어링이다. 접속은 그 페어링의 현재 상태로 접혀 들어간다 — 끊어도
       * 사라지지 않는 줄과 끊으면 사라지는 줄이 한 표에 섞이면 무엇을 회수하는지 알 수 없다.
       */
      devices: pairedDeviceStore.list("remote").map((device) => {
        const open = sessions.find((session) => session.pairingId === device.id) ?? null;
        return {
          id: device.id,
          device: device.device,
          access: device.access,
          pairedAt: device.pairedAt,
          lastSeenAt: Math.max(device.lastSeenAt, open?.lastSeenAt ?? 0),
          sessionHandle: open?.handle ?? null,
        };
      }),
      interfaces: listRemoteInterfaces(),
    });
  }

  function handleAccessLinkRevoke(req: http.IncomingMessage, res: http.ServerResponse, rawId: string): void {
    if (req.method !== "DELETE") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isAccessAdminAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (!access.revokeGrant(decodeHandle(rawId))) {
      writeJson(res, 404, { error: "link_not_found" });
      return;
    }
    res.writeHead(204, withSecurityHeaders({}));
    res.end();
  }

  /**
   * 지금 붙어 있는 접속 하나를 끊는다. 페어링은 건드리지 않는다 — 제어를 되찾는 일과 그 기기를
   * 손님 목록에서 지우는 일은 다른 결정이고, 다른 버튼이다. 끊긴 기기는 자기 페어링 쿠키로
   * 다시 붙어 제어를 되가져올 수 있고, 이 기계의 화면은 그때 다시 커튼을 올린다.
   */
  function handleAccessSessionRevoke(req: http.IncomingMessage, res: http.ServerResponse, rawHandle: string): void {
    if (req.method !== "DELETE") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isAccessAdminAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const handle = decodeHandle(rawHandle);
    if (!access.revokeSessionByHandle(handle)) {
      // 이미 만료된 보유자를 향한 회수다. 404로만 끝내면 화면은 유령 보유자를 계속 띄운 채
      // 남으므로, 사라졌다는 사실을 여기서 다시 알려 스스로 정리되게 한다.
      broadcastControlChanged(true);
      writeJson(res, 404, { error: "session_not_found" });
      return;
    }
    // 세션이 사라지면 그 세션이 게시한 집 주소도 가리킬 주인이 없다. 남겨 두면 handle이
    // 재사용되지 않는 이상 되살아나지는 않지만, 오래 뜬 서버에서 계속 쌓이기만 한다.
    desktopShellsByOwner.delete(handle);
    // 순서가 있다: 끊긴 쪽이 먼저 자기 안내를 받고, 그 다음 이 기계의 화면이 커튼을 걷는다.
    endSessionStreams(handle, "reclaimed");
    broadcastControlChanged();
    res.writeHead(204, withSecurityHeaders({}));
    res.end();
  }

  /**
   * 페어링 하나를 영구히 거둔다. 접속을 끊는 것과 달리 이쪽은 되돌아올 길까지 없앤다 —
   * 그 기기는 새 액세스 링크를 받기 전에는 다시 붙지 못한다.
   */
  function handlePairedDeviceRevoke(req: http.IncomingMessage, res: http.ServerResponse, rawId: string): void {
    if (req.method !== "DELETE") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isAccessAdminAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const removed = pairedDeviceStore.revoke(decodeHandle(rawId));
    if (!removed) {
      writeJson(res, 404, { error: "paired_device_not_found" });
      return;
    }
    // 자격을 거두면서 그 자격으로 열려 있던 접속을 남겨 두면, 회수는 다음 요청까지만 참이다.
    const closed = access.listSessions("remote").filter((session) => session.pairingId === removed.id);
    access.revokeSessionsByPairing(removed.id);
    for (const session of closed) {
      desktopShellsByOwner.delete(session.handle);
      endSessionStreams(session.handle, "reclaimed");
    }
    broadcastControlChanged();
    res.writeHead(204, withSecurityHeaders({}));
    res.end();
  }

  /**
   * 신원 갱신. 새 인증서를 발급하고 리스너를 그 인증서로 다시 연다. 옛 지문을 실은 링크와
   * 그 지문으로 고정한 Desktop 핀은 이 순간 전부 무효가 되므로, 미사용 링크와 열린 세션도
   * 함께 걷어낸다 — 남겨 두면 붙을 수 없는 자격이 목록에 남는다.
   *
   * 페어링도 같이 간다. 페어링은 회수 전까지 사는 자격이지만, 그 기기가 이 콘솔을 알아보는
   * 근거였던 지문이 방금 바뀌었다 — 붙을 수 없는 손님을 목록에 남기는 것은 사실이 아니다.
   *
   * 공표한 포트도 여기서 놓는다. 어차피 아무도 이 주소로 돌아오지 못하는 순간이므로, 포트를
   * 붙들고 있을 이유가 없다 — 그리고 이것이 남이 쥔 포트에서 빠져나오는 유일한 길이다.
   * 이 버튼은 이미 "모두 새 링크를 받아야 한다"는 뜻이고, 새 링크는 새 주소를 싣고 나간다.
   */
  async function handleRemoteIdentityRotation(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!isAccessAdminAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    /**
     * 살아 있는 리스너가 없어도 설정이 켜져 있으면 갱신은 성립해야 한다. 리스너가 열리지
     * 못한 상태야말로 이 버튼이 가장 필요한 자리다 — 공표한 포트를 남이 쥐고 있을 때 그것을
     * 놓는 유일한 길이 여기이고, 리스너를 조건으로 걸면 그 길이 자기 자신에 막힌다.
     */
    const configured = consoleSettingsStore.load().general?.remoteAccess;
    const advertisedHost = listeners.find((entry) => entry.audience === "remote")?.host
      ?? (configured?.enabled === true ? effectiveRemoteAccessAdvertisedTuple(configured).host : null);
    if (!advertisedHost) {
      writeJson(res, 409, { error: "remote_access_disabled" });
      return true;
    }
    await remoteIdentityStore.rotate(advertisedHost);
    access.revokeGrants("remote");
    pairedDeviceStore.revokeAll("remote");
    remoteEndpointStore.forget();
    await reconcileRemoteIdentity();
    if (remoteFingerprint === null) {
      writeJson(res, 500, { error: remoteLastError ?? "remote_listener_failed" });
      return true;
    }
    writeJson(res, 200, { fingerprint: remoteFingerprint });
    return true;
  }


  /**
   * 원격 액세스 링크. 주소·자격·신원·이름을 하나의 봉투에 담아 `fleet://join?code=`로 실어
   * 나른다. 봉투는 인코딩이지 암호가 아니다 — 붙여넣은 문자열을 눈으로 읽어서는 사설 주소가
   * 보이지 않지만, 그 문자열을 가진 쪽은 언제든 풀어 볼 수 있다. 그러므로 이 링크는 가려진
   * 주소가 아니라 자격 그 자체로 다루고, 신뢰하는 경로로만 건넨다. 이 스킴을 여는 주체는
   * Fleet Desktop 하나뿐이다.
   */
  function handleAccessLinkIssue(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isAccessAdminAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const requestedAccess = readAccessClass(req);
    if (requestedAccess === null) {
      writeJson(res, 400, { error: "invalid_access_class" });
      return;
    }
    const remote = listeners.find((entry) => entry.audience === "remote");
    if (!remote || !remoteFingerprint) {
      writeJson(res, 409, { error: "remote_access_disabled" });
      return;
    }
    const grant = access.issueGrant("remote", requestedAccess);
    const link = encodeAccessLink({ endpoint: remote.origin, token: grant.token, fingerprint: remoteFingerprint, label: consoleLabel() });
    writeJson(res, 201, { id: grant.id, link, access: grant.access, expiresAt: grant.expiresAt, fingerprint: remoteFingerprint });
  }

  /**
   * 조인에는 두 갈래가 있다. 링크를 처음 쓰는 기기는 1회용 grant를 내밀고, 그 교환으로
   * 페어링이 생긴다. 이미 페어링된 기기는 아무것도 내밀지 않고 자기 쿠키만 들고 온다 —
   * 제어권을 회수당했든, 유휴로 끊겼든, 콘솔이 재시작했든, 돌아오는 길은 이 두 번째 갈래다.
   *
   * 페어링이 세션과 갈라져 있어야 그 길이 존재한다. 자격이 곧 세션이면 세션을 끊는 모든
   * 행위가 자격까지 지우고, 상대는 새 링크를 받기 전에는 돌아올 수 없다.
   */
  async function handleAccessJoin(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    const listener = listenerForRequest(req);
    if (!listener) {
      writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    // 루프백은 이 기계 앞에 앉은 사람이라 예산을 두지 않는다. 인터넷을 향한 문만 계량한다.
    if (listener.audience !== "remote") return performAccessJoin(req, res, listener);
    const source = normalizeRemoteJoinSource(req.socket.remoteAddress);
    const verdict = remoteJoinGuard.begin(source);
    if (verdict !== "ok") {
      // 본문을 읽기 전에 끝낸다 — 거절의 값이 요청의 값보다 싸야 예산이 뜻을 가진다.
      res.writeHead(verdict === "throttled" ? 429 : 503, withSecurityHeaders({
        "Content-Type": "application/json",
        "Retry-After": String(remoteJoinGuard.retryAfterSeconds(source)),
      }));
      res.end(JSON.stringify({ error: verdict === "throttled" ? "too_many_attempts" : "busy" }));
      return true;
    }
    let paired = false;
    try {
      paired = await performAccessJoin(req, res, listener);
    } finally {
      remoteJoinGuard.settle(source, paired ? "paired" : "rejected");
    }
    return true;
  }

  /** 조인 본체. 반환값은 "페어링에 성공했는가"이며, 응답은 이 안에서 끝난다. */
  async function performAccessJoin(req: http.IncomingMessage, res: http.ServerResponse, listener: ListenerIdentity): Promise<boolean> {
    const body = await readJsonBody<{ readonly token?: unknown; readonly device?: unknown }>(req);
    const token = isPlainObject(body) && typeof body.token === "string" ? body.token : null;
    const device = isPlainObject(body) ? sanitizeDeviceName(body.device) : null;
    const joined = token === null
      ? resumePairedDevice(req, listener, device)
      : pairFromGrant(listener, token, device);
    if ("error" in joined) {
      /**
       * 페어링만 내밀었는데 거절당했다면 그 쿠키는 이제 아무것도 열지 못한다 — 회수되었거나,
       * 신원이 갱신되었거나, 이 콘솔이 그 기기를 애초에 모른다. 지워 주지 않으면 그 기기는
       * 시도할 때마다 죽은 값을 다시 보낸다.
       */
      if (token === null && joined.status === 401) {
        res.writeHead(401, withSecurityHeaders({
          "Content-Type": "application/json",
          "Set-Cookie": expirePairingCookie({ secure: listener.secure, port: listener.port }),
        }));
        res.end(JSON.stringify({ error: joined.error }));
        return false;
      }
      writeJson(res, joined.status, { error: joined.error });
      return false;
    }
    /**
     * 등급을 가리지 않고 알린다. 원격 접속이 하나뿐이므로 monitoring 조인도 앞선 보유자를
     * 대신하고, 그때 커튼은 걷혀야 한다. 실제로 바뀌지 않은 사실은 브로드캐스트가 걸러낸다.
     */
    if (listener.audience === "remote") broadcastControlChanged();
    // 평문 http 리스너에 Secure를 붙이면 브라우저가 쿠키를 버린다.
    const cookies = [formatSessionCookie(joined.session, { secure: listener.secure, port: listener.port })];
    if (joined.pairingSecret !== null) cookies.push(formatPairingCookie(joined.pairingSecret, { secure: listener.secure, port: listener.port }));
    res.writeHead(204, withSecurityHeaders({ "Set-Cookie": cookies }));
    res.end();
    return true;
  }

  interface JoinAccepted {
    readonly session: AccessSession;
    /** 새 페어링이거나 만료 창을 다시 민 기존 페어링. 페어링이 없는 조인에서는 null이다. */
    readonly pairingSecret: string | null;
  }

  interface JoinRejected {
    readonly status: number;
    readonly error: string;
  }

  function pairFromGrant(listener: ListenerIdentity, token: string, device: string | null): JoinAccepted | JoinRejected {
    /**
     * 자격을 소모하기 전에 판정한다. consumeGrant는 성공 여부와 무관하게 토큰을 지우므로,
     * 뒤에서 거절하면 1회용 링크만 태우고 아무도 붙지 못한다.
     */
    const pending = access.peekGrant(token, listener.audience);
    /**
     * 상한에 걸린 조인은 grant를 태우지 않는다 — 자리를 비운 뒤 같은 링크가 아직 통해야 한다.
     * 다만 되살아나는 것은 링크 문자열뿐이다. 셸이 들고 있던 자격은 handoff가 한 번만 넘기므로,
     * 목록에서 그 콘솔을 다시 여는 길로는 돌아올 수 없고 링크를 다시 붙여넣어야 한다.
     */
    if (pending !== null && listener.audience === "remote" && pairedDeviceStore.list("remote").length >= PAIRED_DEVICE_LIMIT) {
      return { status: 409, error: "paired_device_limit" };
    }
    const grant = access.consumeGrant(token, listener.audience);
    if (!grant) return { status: 401, error: "unauthorized" };
    // 루프백은 페어링을 만들지 않는다 — 이 리스너에는 애초에 세션 게이트가 없다.
    if (listener.audience !== "remote") {
      return { session: access.openSession(listener.audience, grant.access, device, null), pairingSecret: null };
    }
    const paired = pairedDeviceStore.pair({ audience: listener.audience, access: grant.access, device });
    if (!paired) return { status: 409, error: "paired_device_limit" };
    // 거절이 끝난 뒤에 자리를 비운다 — 받지도 못할 조인이 앞사람을 내보내서는 안 된다.
    supersedeRemoteSessions(null);
    return {
      session: access.openSession(listener.audience, grant.access, device, paired.device.id),
      pairingSecret: paired.secret,
    };
  }

  function resumePairedDevice(req: http.IncomingMessage, listener: ListenerIdentity, device: string | null): JoinAccepted | JoinRejected {
    const secret = readPairingCookie(req.headers, listener.port);
    const paired = pairedDeviceStore.resolve(secret, listener.audience);
    if (!paired || secret === null) return { status: 401, error: "unauthorized" };
    /**
     * 자기 페어링이 두고 간 접속은 축출이 아니라 자기 자신의 잔상이므로 안내 없이 걷는다 —
     * 창을 다시 여는 것만으로 "다른 기기가 이어받았습니다"를 자기 화면에 띄울 수는 없다.
     */
    supersedeRemoteSessions(paired.id);
    return {
      // 등급은 페어링이 정한다 — 재개가 monitoring을 full로 올릴 수 없어야 한다.
      session: access.openSession(listener.audience, paired.access, device ?? paired.device, paired.id),
      // 받은 비밀값을 그대로 다시 실어 만료 창을 민다. 서버는 해시만 알므로 이 값은 여기서만 나온다.
      pairingSecret: secret,
    };
  }

  /**
   * 원격 접속은 한 번에 하나다. 이 콘솔은 하나의 화면이고 하나의 터미널이므로, 둘이 동시에
   * 붙으면 커튼은 "누가" 몰고 있는지 하나로 말하지 못하고 회수 버튼의 대상도 갈라진다.
   *
   * 그래서 새 조인이 앞선 접속을 대신한다. 거절하지 않는 이유는, 거절이 자기 기기를 되찾는
   * 길까지 막기 때문이다 — 앞의 접속이 유휴로 남아 있거나 셸이 두고 간 잔상일 때 주인은
   * 자기 콘솔 앞에 가서 그 줄을 끊기 전에는 돌아올 수 없었다. 페어링은 이미 주인이 승인한
   * 자격이고, 그 자격을 거둘 자리는 여전히 기기 목록의 회수 버튼이다.
   *
   * 세션을 열기 전에 부른다 — 열고 나서 걷으면 방금 연 접속이 자기 자신에 걸린다.
   * `ownPairingId`가 두고 간 접속은 축출이 아니므로 안내 없이 걷는다.
   */
  function supersedeRemoteSessions(ownPairingId: string | null): void {
    for (const session of access.listSessions("remote")) {
      if (!access.revokeSessionByHandle(session.handle)) continue;
      // 세션이 사라지면 그 세션이 게시한 집 주소도 가리킬 주인이 없다.
      desktopShellsByOwner.delete(session.handle);
      /**
       * 자기 페어링이 두고 간 접속에는 안내를 보내지 않는다 — 축출이 아니라 자기 자신의
       * 잔상이므로. 건너뛰는 것은 안내뿐이고 스트림은 그 사정과 무관하게 닫힌다.
       */
      const displaced = session.pairingId === null || session.pairingId !== ownPairingId;
      endSessionStreams(session.handle, displaced ? "superseded" : null);
    }
  }

  /**
   * 건너갈 수 있는 다른 콘솔들의 목록은 이 기계 앞에 앉은 사람의 것이다. 원격에서 붙은 세션에는
   * 보이지도 고쳐지지도 않는다 — 남의 콘솔 주소와 지문이 원격 화면으로 새 나갈 이유가 없다.
   */
  /** 루프백 요청은 전부 같은 기계이므로 하나로 본다. 원격은 세션 단위로 가른다. */
  function shellOwnerOf(req: http.IncomingMessage): string | "local" | null {
    const listener = listenerForRequest(req);
    if (listener === null) return null;
    if (listener.audience === "local") return "local";
    return access.resolveSession(readSessionCookie(req.headers, listener.port), listener.audience)?.handle ?? null;
  }

  function isLoopbackListener(req: http.IncomingMessage): boolean {
    return listenerForRequest(req)?.audience === "local";
  }

  function isRemoteHostWriteAuthorized(req: http.IncomingMessage): boolean {
    return isLoopbackListener(req) && (isLockAuthorized(req) || isExactConsoleOrigin(req));
  }

  /**
   * 원격을 관리하는 자리는 이 기계 앞이다. 자격을 발급하고, 목록을 읽고, 남의 세션을 끊고,
   * 신원을 갈아 끼우는 일은 초대받은 쪽이 할 일이 아니다.
   *
   * `isExactConsoleOrigin`만으로는 이 경계가 서지 않는다 — 그 함수는 요청이 도착한 리스너의
   * origin과 대조하므로, 원격 브라우저가 원격 origin으로 보내면 그대로 통과한다. 루프백
   * 판정을 함께 요구해야 카탈로그가 이미 선언해 둔 gate가 런타임에서도 참이 된다.
   */
  function isAccessAdminAuthorized(req: http.IncomingMessage): boolean {
    return isLoopbackListener(req) && (isLockAuthorized(req) || isExactConsoleOrigin(req));
  }

  /**
   * 터미널 소켓의 등급. 제어를 쥔 원격이 있는 동안 이 기계 앞에서 열리는 터미널은 관전이다.
   *
   * 클라이언트가 스스로 정하게 두면 새로고침 한 번이 제어를 되가져간다 — 새 연결은 언제나
   * control로 시작하고 attach는 앞의 소켓을 밀어내므로, 원격은 말없이 관전자로 내려가고
   * 화면은 여전히 그 기기가 몰고 있다고 말한다. 판정을 서버에 두면 그 경합 자체가 없다.
   *
   * 원격 쪽 요청은 그대로 control이다. full 세션은 하나뿐이고 monitoring은 애초에 업그레이드에
   * 닿지 못하므로, 원격에서 오는 티켓 요청의 주인은 지금 제어를 쥔 그 기기뿐이다.
   */
  function resolveTerminalSocketRole(req: http.IncomingMessage): "control" | "viewer" {
    if (!isLoopbackListener(req)) return "control";
    return access.hasSession("remote", "full") ? "viewer" : "control";
  }

  async function handleRemoteHosts(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
    const rest = pathname.slice(REMOTE_HOSTS_PATH.length).replace(/^\//u, "");
    if (rest.length === 0) {
      if (req.method === "GET") {
        if (!isLoopbackListener(req)) {
          writeJson(res, 401, { error: "unauthorized" });
          return true;
        }
        writeJson(res, 200, { hosts: remoteHostStore.list() });
        return true;
      }
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "Method not allowed" });
        return true;
      }
      if (!isRemoteHostWriteAuthorized(req)) {
        writeJson(res, 401, { error: "unauthorized" });
        return true;
      }
      await addRemoteHost(req, res);
      return true;
    }

    const [id, action] = rest.split("/");
    if (!isRemoteHostWriteAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const host = remoteHostStore.find(decodeHandle(id ?? ""));
    if (!host) {
      writeJson(res, 404, { error: "remote_host_unknown" });
      return true;
    }
    if (action === "probes" && req.method === "POST") {
      writeJson(res, 200, await describeReachability(host));
      return true;
    }
    if (action !== undefined) {
      writeJson(res, 404, { error: "remote_host_unknown" });
      return true;
    }
    if (req.method === "DELETE") {
      remoteHostStore.forget(host.id);
      writeNoContent(res);
      return true;
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody<{ readonly label?: unknown }>(req);
      const label = isPlainObject(body) && typeof body.label === "string" ? body.label : "";
      const renamed = remoteHostStore.rename(host.id, label);
      if (!renamed) {
        writeJson(res, 400, { error: "remote_host_label_invalid" });
        return true;
      }
      writeJson(res, 200, { host: renamed });
      return true;
    }
    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  /**
   * 링크 없이 갈 수 있는 지름길. 여기 적힌 루프백 주소는 "이 요청이 도착한 리스너와 같은 기계"를
   * 뜻하므로, 원격 리스너에는 절대 내주지 않는다 — 원격에서 받은 127.0.0.1은 다른 기계다.
   */
  async function handleLocalConsoles(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!isLoopbackListener(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    writeJson(res, 200, { consoles: await listLocalConsoles() });
    return true;
  }

  async function addRemoteHost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJsonBody<{ readonly link?: unknown }>(req);
    if (!isPlainObject(body) || typeof body.link !== "string") {
      writeJson(res, 400, { error: "pairing_target_invalid" });
      return;
    }
    let link;
    try {
      link = parseAccessLink(body.link);
    } catch {
      writeJson(res, 400, { error: "pairing_target_invalid" });
      return;
    }
    // 자기 자신을 목록에 넣으면 스위처가 제자리를 가리킨다.
    if (listeners.some((entry) => entry.origin === link.origin)) {
      writeJson(res, 409, { error: "remote_host_is_self" });
      return;
    }
    // 자격을 보내기 전에 그 주소가 정말 그 인증서를 내미는지 먼저 확인한다.
    const probe = await probeRemoteIdentity(link.hostname, link.port, link.fingerprint);
    if (probe.state === "unreachable") {
      writeJson(res, 502, { error: "remote_host_unreachable" });
      return;
    }
    if (probe.state === "mismatch") {
      writeJson(res, 409, { error: "remote_host_fingerprint_mismatch" });
      return;
    }
    // 탐침은 6초까지 끌 수 있고, 그 사이 요청자가 사라질 수 있다(창의 취소가 요청을 끊는다).
    // 기억한다는 것은 목록에 남기고 1회용 자격을 예약한다는 뜻이므로, 아무도 받아 가지 않을
    // 짝짓기를 남기지 않는다 — 취소가 진짜로 멈추려면 이 판정이 여기 있어야 한다.
    if (res.writableEnded || res.destroyed) return;
    writeJson(res, 201, { host: remoteHostStore.remember(link) });
  }

  async function describeReachability(host: RemoteHostRecord): Promise<{ readonly reachable: boolean; readonly trusted: boolean }> {
    const probe = await probeRemoteIdentity(host.hostname, host.port, host.fingerprint);
    return { reachable: probe.state !== "unreachable", trusted: probe.state === "match" };
  }

  /**
   * Desktop이 창을 그 호스트로 보내기 직전에 필요한 것을 한 번에 가져간다. 1회용 자격은 이
   * 호출로 소진되므로, 링크 하나가 두 창을 열 수는 없다.
   */
  async function handleRemoteHostHandoff(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!isRemoteHostWriteAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await readJsonBody<{ readonly origin?: unknown }>(req);
    const origin = isPlainObject(body) && typeof body.origin === "string" ? body.origin : "";
    const handoff = remoteHostStore.takeHandoff(origin);
    if (!handoff) {
      writeJson(res, 404, { error: "remote_host_unknown" });
      return true;
    }
    writeJson(res, 200, {
      origin: handoff.host.origin,
      hostname: handoff.host.hostname,
      port: handoff.host.port,
      fingerprint: handoff.host.fingerprint,
      token: handoff.token,
    });
    return true;
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
    const canonicalCwd = canonicalizeTheaterPathSync(cwd);
    if (deletionCoordinator.hasPendingTheater(workspaceHash(canonicalCwd))) {
      writeJson(res, 409, { error: "pending_deletion" });
      return;
    }
    const theater = await theaters.register(cwd);
    await codex.registerWorkspace(theater.realpath, undefined, theater.id);
    publishTheaterLifecycle("registered", theater.id);
    persistDurableState();
    writeJson(res, 200, toTheaterInfo(theater, true));
  }

  async function handleObserverTheaterItem(req: http.IncomingMessage, res: http.ServerResponse, theaterId: string): Promise<void> {
    if (req.method !== "PATCH" && req.method !== "DELETE") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody<PatchTheaterBody>(req);
      if (!isPlainObject(body) || typeof body.order !== "number" || !Number.isInteger(body.order) || body.order < 0) {
        writeJson(res, 400, { error: "invalid_theater_order" });
        return;
      }
      const theater = theaters.setOrder(theaterId, body.order);
      if (!theater) {
        writeJson(res, 404, { error: "theater_not_found" });
        return;
      }
      persistDurableState();
      writeJson(res, 200, toTheaterInfo(theater, true));
      return;
    }
    const deletion = deletionCoordinator.deleteTheater(theaterId);
    writeJson(res, 200, { ok: true, deletion });
  }

  async function handleDeferredDeletionRestore(req: http.IncomingMessage, res: http.ServerResponse, deletionId: string): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const restored = await deletionCoordinator.restore(deletionId);
      migrateLegacyCaptureState();
      writeJson(res, 200, restored);
    } catch (error) {
      if (error instanceof DeferredDeletionError) {
        writeJson(res, error.status, { error: error.message });
        return;
      }
      throw error;
    }
  }

  function handleStatus(req: http.IncomingMessage, res: http.ServerResponse): void {
    const theaterId = readUrl(req).searchParams.get("theaterId");
    const payload: ConsoleObserverStatus = {
      name: consoleLabel(),
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
    writeJson(res, 200, { version, routes: buildApiCatalog(pluginHost.apiCatalog) });
  }

  function handleEnvironmentDiagnostics(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (channel !== "local") {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (!activeLockFile) {
      writeJson(res, 503, { error: "console_not_ready" });
      return;
    }
    const payload: ConsoleEnvironmentDiagnostics = {
      channel: "local",
      version,
      effectivePort: portState.effectivePort,
      dataDir: durablePaths.dir,
      lockFile: activeLockFile,
    };
    res.setHeader("Cache-Control", "no-store");
    writeJson(res, 200, payload);
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

  /**
   * 업데이트가 끝났는지 말해 줄 수 있는 것은 그 업데이트를 겪은 프로세스가 아니다 —
   * 그 프로세스는 이미 죽었다. 답하는 쪽은 **다음 세대의 데몬**이고, 근거는 워커가
   * 디스크에 남긴 기록이다. 그래서 이 라우트는 자기 메모리를 읽지 않는다.
   */
  function handleUpdateProgress(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    let progress: ConsoleUpdateProgressStatus;
    try {
      progress = readConsoleUpdateProgress(durablePaths.dir);
    } catch {
      progress = IDLE_CONSOLE_UPDATE_PROGRESS;
    }
    writeJson(res, 200, progress);
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
    // 원격에서 누른 손은 이 기계 앞에 없다. 이 콘솔을 내리는 일은 그 자리에 앉아 있는
    // 사람의 화면까지 함께 내리므로, 원격 리스너로 들어온 요청은 그 사실을 읽고 나서만
    // 진행한다. 보안 관문이 아니라 고의성의 표식이다 — 관문은 이미 세션이 지켰다.
    if (!isLoopbackListener(req) && (body === null || body.acknowledgeHostRestart !== true)) {
      writeJson(res, 409, { error: "host_restart_confirmation_required" });
      return;
    }
    // 이 트리를 제자리에서 고칠 수 없는 설치 레이아웃이라면, 업데이트를 거절하는 대신
    // 창을 들고 있는 셸에게 넘긴다. 거절은 사용자를 아무 데도 데려가지 않았다.
    if (isManagedRuntimePackageRoot(release.packageRoot)) {
      publishDesktopUpdateRequest({ requestedVersion: freshStatus.latestVersion, requestId: crypto.randomUUID() });
      const delegated: ConsoleUpdateApplyAcceptedResponse = { status: "delegated" };
      writeJson(res, 202, delegated);
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
        fromVersion: version,
        lockFile: activeLockFile,
        targetVersion: freshStatus.latestVersion,
      });
    } catch (error) {
      updateApplyInFlight = false;
      const updateError: ConsoleUpdateApplyError = error instanceof Error && error.message === "managed_runtime_update_requires_relaunch"
        ? "managed_runtime_update_requires_relaunch"
        : "update_worker_unavailable";
      writeJson(res, 503, { error: updateError });
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
    const listener = listenerForRequest(req);
    if (!listener) return false;
    // Origin 검증으로 WS 경로와 동일한 출처 경계를 terminal 라우트에 적용한다.
    return isAllowedTerminalOrigin(req, listener.origin);
  }

  function isLockAuthorized(req: http.IncomingMessage): boolean {
    const token = lockHandle?.payload.token;
    return !!token && req.headers.authorization === `Bearer ${token}`;
  }

  // 카탈로그 gate 레이블은 "origin-strict"로 개명됐지만 이 함수 이름은 별도 정리 범위.
  function isExactConsoleOrigin(req: http.IncomingMessage): boolean {
    const listener = listenerForRequest(req);
    return listener !== null && req.headers.origin === listener.origin;
  }

  function listTheaterInfos(): readonly ConsoleTheaterInfo[] {
    return theaters.list().map((theater) => toTheaterInfo(theater, true));
  }

  function toTheaterInfo(theater: TheaterRegistration, hasWiki: boolean): ConsoleTheaterInfo {
    return {
      id: theater.id,
      label: theater.label,
      createdAt: theater.registeredAt,
      lastOpenedAt: theater.lastOpenedAt,
      ...(theater.order !== undefined ? { order: theater.order } : {}),
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
    // 원격 리스너를 남겨 두면 콘솔이 내려간 뒤에도 포트가 열려 있는 것처럼 보인다.
    const closingRemote = remoteServer;
    remoteServer = null;
    remoteFingerprint = null;
    listeners = [];
    boundPort = null;
    access.revokeAllSessions();
    await closeHttpServer(closingRemote);
    const cleanupResults = await Promise.allSettled([...pluginCleanupCallbacks].map((cleanup) => cleanup()));
    for (const result of cleanupResults) {
      if (result.status === "rejected") {
        console.warn(`[fleet-console] Plugin cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
    await pluginHost.cleanup();
    codexKnowledgeWatcher.disposeAll();
    pluginCleanupCallbacks.clear();
    pluginEventListeners.clear();
    currentLock?.release();
  }

  async function rehydrateDurableState(): Promise<void> {
    let state: DurableConsoleState;
    let restored = false;
    const loadedVersion = readDurableStateVersion(durablePaths.stateFile);
    try {
      state = durableStateStore.load();
      theaters.restore(state.theaters);
      operations.replace(state.operations);
      operations.replaceGroups(state.groups ?? []);
      restored = true;
    } catch (error) {
      console.warn(`[fleet-console] Durable state restore skipped: ${error instanceof Error ? error.message : String(error)}`);
      state = emptyDurableConsoleState();
      theaters.restore([]);
      operations.replace([]);
      operations.replaceGroups([]);
    }
    deletionCoordinator.load(state.deletionTombstones ?? []);
    // 지원하는 구버전을 실제로 복원한 경우에만 sanitizer의 단계형 이주를 현재 버전으로 확정한다.
    // 알 수 없는 버전이나 복원 실패를 빈 v4 상태로 덮으면 재시도할 원본 자체를 잃는다.
    if (restored && (loadedVersion === 1 || loadedVersion === 2 || loadedVersion === 3)) {
      if (loadedVersion === 3) backupDurableStateV3(durablePaths.stateFile);
      persistDurableState();
    }
    // 퇴역한 Carrier 스토어 파일(carriers.json·carrier-subagent.json·carriers.json.lock)은
    // 그대로 둔다. `~/.fleet`는 CLI와 Console이 공유하는 데이터 루트라, 업그레이드 전 호스트가
    // 아직 그 스토어를 소유한 채 돌고 있을 수 있다. 특히 carriers.json.lock은 withDirectoryLock이
    // 점유하는 잠금 디렉터리여서, 지우면 임계 구역 안의 레거시 프로세스 옆으로 두 번째 writer가
    // 들어온다. 아무도 읽지 않는 파일을 치우는 정돈은 그 위험을 살 만한 값이 아니다.
    // Legacy captures/ → state.json providerSession one-shot migration (best-effort).
    // Runs after durable load so save preserves tombstones already restored into the coordinator.
    migrateLegacyCaptureState();
    try {
      deletionCoordinator.sweepExpired();
    } catch (error) {
      console.warn(`[fleet-console] Expired deletion sweep deferred: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Codex WorkspaceRegistry는 인메모리이므로 durable Theater를 메타데이터만 복원한다.
    await restoreCodexWorkspaces();
  }

  function migrateLegacyCaptureState(): void {
    migrateLegacyCaptures({
      consoleDataDir: durablePaths.dir,
      operations,
      // 삭제 유예 중인 Operation은 live store에 없으므로 tombstone에서 flatten해 넘긴다.
      tombstonedOperations: deletionCoordinator.list().flatMap((tombstone) => (
        tombstone.kind === "operation" ? [tombstone.operation] : tombstone.operations
      )),
      save: () => saveDurableState(deletionCoordinator.list()),
    });
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
      await codex.registerWorkspace(theater.realpath, theater.lastOpenedAt, theater.id);
      publishTheaterLifecycle("restored", theater.id);
    }
  }

  // patch 브로드캐스트 게이트가 쓰는 "브라우저가 보는 모양" — broadcastOperationChanged와 같은
  // 새니타이즈 규칙을 공유해야 민감 필드 전용 patch가 조용히 남는다. ts는 모든 patch가 건드리는
  // 축이라 비교에서 뺀다 — 남기면 게이트가 항상 열려 게이트가 아니게 된다.
  function sanitizedOperationJson(node: OperationNode): string {
    const sensitiveFields = [
      ...(pluginHost.sensitiveFieldsByPluginId.get(node.pluginId) ?? []),
      ...(pluginPayloadSanitizers.get(node.pluginId) ?? []),
    ];
    const { ts: _ts, ...rest } = createSanitizedOpDto(node, { sensitiveFields });
    return JSON.stringify(rest);
  }

  function broadcastOperationChanged(node: OperationNode): void {
    if (operationSseSubscribers.size === 0) return;
    const sensitiveFields = [
      ...(pluginHost.sensitiveFieldsByPluginId.get(node.pluginId) ?? []),
      ...(pluginPayloadSanitizers.get(node.pluginId) ?? []),
    ];
    const sanitized = createSanitizedOpDto(node, { sensitiveFields });
    const data = encodeSseData("operation:changed", { operation: sanitized });
    for (const subscriber of operationSseSubscribers) {
      subscriber.res.write(data);
    }
  }

  /**
   * 이벤트는 힌트다 — 변한 범위만 싣고 내용은 싣지 않는다. 원격 세션도 이 채널을 받으므로
   * 경로·본문이 실리면 안 되고, workspaceId(12-hex 해시)와 범위 이름만 나간다.
   */
  function broadcastCodexChanged(workspaceId: string, scopes: readonly CodexKnowledgeScope[]): void {
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData(CODEX_CHANGED_EVENT, { workspaceId, scopes });
    for (const subscriber of operationSseSubscribers) {
      subscriber.res.write(data);
    }
  }

  function broadcastCodexWatchState(workspaceId: string, state: CodexWatchState): void {
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData(CODEX_WATCH_EVENT, { workspaceId, state });
    for (const subscriber of operationSseSubscribers) {
      subscriber.res.write(data);
    }
  }

  function broadcastUpdateAvailable(): void {
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData("update:available", {});
    for (const subscriber of operationSseSubscribers) {
      subscriber.res.write(data);
    }
  }

  function broadcastDesktopFullscreenChanged(): void {
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData(DESKTOP_FULLSCREEN_EVENT, desktopFullscreenSnapshot(desktopFullscreen));
    for (const subscriber of operationSseSubscribers) subscriber.res.write(data);
  }

  /**
   * 제어를 쥔 원격. full 등급 세션만 보유자가 된다 — monitoring은 명령을 실행하지 못하므로
   * 그 접속으로 화면을 덮으면 아무것도 못 하는 관전자 때문에 콘솔이 잠긴다.
   *
   * 상한이 1이므로 목록에서 가장 먼저 나오는 하나가 곧 보유자다.
   */
  function currentControlHolder(): ControlHolderSnapshot | null {
    for (const session of access.listSessions("remote")) {
      if (session.access !== "full") continue;
      return { handle: session.handle, device: session.device, openedAt: session.openedAt };
    }
    return null;
  }

  /**
   * 보유자 변화는 이 기계 앞에 앉은 사람에게만 간다. 원격은 다른 세션의 존재를 알 이유가 없다.
   *
   * `resend`는 사실이 그대로일 때도 프레임을 한 번 더 내보낸다. 유령 보유자를 향한 회수처럼
   * 서버는 아무것도 바뀌지 않았는데 화면만 틀린 것을 그리고 있는 자리에만 쓴다.
   */
  function broadcastControlChanged(resend = false): void {
    /**
     * 실제로 보유자가 바뀐 경우에만 알린다.
     *
     * 이 함수는 원격 세션이 오가는 모든 자리에서 불리는데, 그중에는 제어를 쥔 적 없는
     * monitoring 세션의 조인·만료·회수도 있다. 그때까지 신호로 세면 터미널이 통째로 끊겼다
     * 다시 붙으며 scrollback을 재생한다 — 아무것도 바뀌지 않았는데 화면이 깜빡인다.
     *
     * "없음"도 하나의 사실이므로 null끼리도 같은 것으로 본다. 옛 비교는 `undefined`와 `null`을
     * 견주어 보유자가 없는 동안의 모든 호출을 프레임으로 만들었다 — 걸름이 가장 필요한 상태에서
     * 걸러 내지 못한 셈이다.
     */
    const holder = currentControlHolder();
    const handle = holder?.handle ?? null;
    if (!resend && handle === lastPublishedControlHolder) return;
    lastPublishedControlHolder = handle;
    /**
     * 플러그인 쪽이 먼저다. 이미 열려 있는 터미널 소켓은 티켓 발급 시점의 등급을 그대로
     * 들고 있으므로, 화면이 새 사실을 그리기 전에 전송이 그 사실에 맞춰져야 한다.
     *
     * 구독자가 없어도 보낸다 — 이 신호의 수신자는 브라우저가 아니라 서버 안의 플러그인이다.
     */
    publishPluginEvent(CONTROL_HOLDER_EVENT_CHANNEL, { holder });
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData(CONTROL_CHANGED_EVENT, controlChangedSnapshot(holder));
    for (const subscriber of operationSseSubscribers) {
      if (subscriber.audience !== "local") continue;
      subscriber.res.write(data);
    }
  }

  /**
   * 이 세션으로 열려 있던 구독을 끝낸다. 세션이 죽어도 이미 열린 SSE는 스스로 끝나지 않으므로,
   * 남겨 두면 자격을 잃은 기기가 다음 브로드캐스트부터 Operation 갱신을 계속 받는다 — 이
   * 스트림에는 요청마다 걸리는 세션 게이트가 없다. 끊는 시점을 상대의 새로고침에 맡길 수 없다.
   * 그쪽 화면이 스스로 물러나 주기를 기다리는 것은 규약을 지키는 클라이언트에만 성립하는
   * 가정이고, 이 리스너는 인터넷을 향해 있다.
   *
   * 안내는 그 위에 얹힌다. 쿠키는 이미 무효라 다음 요청이 401이 되는데, SPA가 떠 있는 동안에는
   * 그 401을 아무도 마주치지 않는다 — 이 이벤트가 원격 화면에 안내를 띄우는 유일한 신호다.
   * 사유를 함께 싣는 이유는, 주인이 되찾은 것과 다른 기기가 이어받은 것이 그 화면 앞에 앉은
   * 사람에게 서로 다른 일을 뜻하기 때문이다.
   *
   * `reason`이 null이면 닫기만 하고 아무것도 말하지 않는다. 닫는 일과 알리는 일을 가르는 것이
   * 이 인자의 존재 이유다 — 둘을 하나로 두면 안내를 건너뛰는 자리가 정리까지 함께 건너뛴다.
   */
  function endSessionStreams(handle: string, reason: ControlReclaimedReason | null): void {
    if (operationSseSubscribers.size === 0) return;
    const data = reason === null ? null : encodeSseData(CONTROL_RECLAIMED_EVENT, controlReclaimedSnapshot(reason));
    for (const subscriber of [...operationSseSubscribers]) {
      if (subscriber.sessionHandle !== handle) continue;
      operationSseSubscribers.delete(subscriber);
      if (data !== null) subscriber.res.write(data);
      subscriber.res.end();
    }
  }

  function broadcastDesktopThemeChanged(theme: ConsoleThemeId): void {
    if (desktopThemeSseSubscribers.size === 0) return;
    const data = encodeSseData(DESKTOP_THEME_EVENT, desktopThemeSnapshot(theme));
    for (const res of desktopThemeSseSubscribers) {
      res.write(data);
    }
  }

  function readDesktopUpdateRequest(): DesktopUpdateRequestSnapshot {
    if (desktopUpdateRequest.requestId === null) return desktopUpdateRequest;
    if (Date.now() - desktopUpdateRequestedAt <= DESKTOP_UPDATE_REQUEST_TTL_MS) return desktopUpdateRequest;
    desktopUpdateRequest = emptyDesktopUpdateRequest();
    return desktopUpdateRequest;
  }

  function publishDesktopUpdateRequest(snapshot: DesktopUpdateRequestSnapshot): void {
    desktopUpdateRequestedAt = Date.now();
    desktopUpdateRequest = snapshot;
    if (desktopUpdateSseSubscribers.size === 0) return;
    const data = encodeSseData(DESKTOP_UPDATE_EVENT, snapshot);
    for (const res of desktopUpdateSseSubscribers) {
      res.write(data);
    }
  }

  function persistDurableState(): void {
    try {
      saveDurableState(deletionCoordinator.list());
    } catch (error) {
      console.warn(`[fleet-console] Durable state save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function saveDurableState(deletionTombstones: ReturnType<typeof deletionCoordinator.list>): void {
    durableStateStore.save({
      version: STATE_VERSION,
      theaters: theaters.list(),
      operations: operations.list(),
      groups: operations.listAllGroups(),
      deletionTombstones,
    });
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
    deletionCoordinator.dispose();
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
        lockHandle = lock.writeLock({ dir: lockPaths.dir, lockFile: lockPaths.lockFile, pid: process.pid, port: result.actualPort, endpoint: result.endpoint, version, ...(desktop ? { owner: desktop.owner } : {}) });
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

  /**
   * 업데이트가 방금 이 콘솔을 갈아 끼웠다면, 열려 있던 화면은 옛 주소를 계속 두드리고 있다.
   * 그 주소를 되찾는 것이 "같은 자리로 돌아온다"는 약속의 전부다.
   *
   * 다만 이것은 **바인드할 포트**일 뿐, 사용자가 요청한 포트가 아니다. 보고되는 portMode와
   * requestedPort를 건드리면 설정 화면이 "요청한 포트를 쓰지 못했습니다"라고 말하게 되는데,
   * 사용자는 그런 포트를 요청한 적이 없다. 그리고 사용자가 고정 포트를 지정해 두었다면
   * 그쪽이 이긴다 — 명시된 설정이 복귀 편의보다 앞선다.
   */
  function resolveConsolePortListenPlan(): ConsolePortListenPlan {
    const plan = resolveConfiguredConsolePortListenPlan();
    if (resumePort === null || plan.portMode !== "dynamic") return plan;
    return { ...plan, port: resumePort, allowFallback: true };
  }

  function resolveConfiguredConsolePortListenPlan(): ConsolePortListenPlan {
    if (deps.port !== undefined) {
      return {
        port,
        requestedPort: null,
        portMode: "dynamic",
        allowFallback: false,
      };
    }
    if (channel === "local") {
      return {
        port: DEFAULT_PORT,
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

  /**
   * 설정 변경을 살아 있는 리스너에 반영한다. 재시작을 요구하면 사용자는 켜자마자 링크를
   * 만들 수 없고, 그 실패는 설정이 저장되지 않은 것처럼 보인다. 전환은 직렬화한다 —
   * 두 저장이 겹치면 같은 포트에 두 번 바인드하려 든다.
   */
  function reconcileRemoteAccess(change: RemoteAccessSettingsChange): Promise<void> {
    return queueRemoteReconcile(() => {
      const { previous, next } = change;
      const previousAdvertised = effectiveRemoteAccessAdvertisedTuple(previous);
      const nextAdvertised = effectiveRemoteAccessAdvertisedTuple(next);
      const publicChanged = previousAdvertised.host !== nextAdvertised.host || previousAdvertised.port !== nextAdvertised.port;
      const localChanged = previous.listenAddress !== next.listenAddress || previous.listenPort.value !== next.listenPort.value;
      const explicitDisable = previous.enabled && !next.enabled && !publicChanged && !localChanged;
      if (publicChanged) return () => reconcilePublicEndpointChange(next);
      if (explicitDisable) return stopRemoteAccessForDisable;
      if (localChanged) return () => reconcileLocalEndpointChange(next);
      if (!previous.enabled && next.enabled) return restartRemoteAccess;
      return null;
    });
  }

  /** 인증서가 바뀌었을 때. 주소는 같으므로 위 판정으로는 재기동되지 않는다. */
  function reconcileRemoteIdentity(): Promise<void> {
    return queueRemoteReconcile(() => restartRemoteAccess);
  }

  function queueRemoteReconcile(plan: () => (() => Promise<void>) | null): Promise<void> {
    remoteReconcile = remoteReconcile.then(async () => {
      if (consoleResourcesDisposed || boundPort === null) return;
      const action = plan();
      if (action) await action();
    }).catch(() => undefined);
    return remoteReconcile;
  }

  async function restartRemoteAccess(): Promise<void> {
    await stopRemoteAccess();
    remoteLastError = null;
    await startRemoteAccessGuarded(boundPort!);
  }

  async function stopRemoteAccessForDisable(): Promise<void> {
    await stopRemoteAccess();
    access.revokeGrants("remote");
  }

  async function reconcileLocalEndpointChange(next: ConsoleRemoteAccessSettings): Promise<void> {
    await stopRemoteAccess();
    remoteLastError = null;
    if (next.enabled) await startRemoteAccessGuarded(boundPort!);
  }

  async function reconcilePublicEndpointChange(next: ConsoleRemoteAccessSettings): Promise<void> {
    await stopRemoteAccess();
    access.revokeGrants("remote");
    pairedDeviceStore.revokeAll("remote");
    remoteEndpointStore.forget();
    if (next.enabled) {
      remoteLastError = null;
      await startRemoteAccessGuarded(boundPort!);
    }
  }

  /**
   * 원격 리스너는 선택 기능이므로 그 실패가 콘솔을 못 뜨게 해서는 안 된다.
   *
   * 저장된 주소는 어제 붙어 있던 인터페이스의 것이다. 노트북이 망을 옮기면 그 주소는 사라지고
   * 바인드는 EADDRNOTAVAIL로 끝나는데, 그것이 기동을 함께 무너뜨리면 사용자는 설정을 고칠
   * 화면조차 열 수 없다. 실패는 상태로 남기고 콘솔은 계속 뜬다.
   */
  async function startRemoteAccessGuarded(actualPort: number): Promise<void> {
    try {
      await startRemoteAccessIfEnabled(actualPort);
    } catch (error) {
      remoteLastError = remoteAccessErrorCode(error);
      await stopRemoteAccess();
    }
  }

  /**
   * 만료를 알아채는 시계. prune은 누가 레지스트리를 건드릴 때만 도는데, 유휴로 만료되는
   * 세션은 정의상 아무도 건드리지 않는다 — 쓸어 주는 쪽이 없으면 커튼이 사라진 기기를
   * 몇 시간이고 띄운 채 남는다. 원격 리스너가 열려 있는 동안에만 돈다.
   */
  const CONTROL_EXPIRY_SWEEP_MS = 60_000;
  let controlExpirySweep: ReturnType<typeof setInterval> | null = null;

  function startControlExpirySweep(): void {
    if (controlExpirySweep !== null) return;
    controlExpirySweep = setInterval(() => access.prune(), CONTROL_EXPIRY_SWEEP_MS);
    // 이 타이머가 프로세스를 붙잡아 두지 않게 한다.
    controlExpirySweep.unref();
  }

  function stopControlExpirySweep(): void {
    if (controlExpirySweep === null) return;
    clearInterval(controlExpirySweep);
    controlExpirySweep = null;
  }

  async function stopRemoteAccess(): Promise<void> {
    stopControlExpirySweep();
    const closing = remoteServer;
    remoteServer = null;
    remoteFingerprint = null;
    listeners = listeners.filter((entry) => entry.audience !== "remote");
    // A listener stop ends live sessions, but unused grants remain valid unless public identity changes.
    access.revokeSessions("remote");
    for (const owner of desktopShellsByOwner.keys()) {
      if (owner !== "local") desktopShellsByOwner.delete(owner);
    }
    // 원격을 끄면 보유자도 사라진다. 알리지 않으면 커튼이 아무도 없는 콘솔 위에 남는다 —
    // 신원 갱신도 리스너를 다시 여는 경로라 이 자리를 지난다.
    broadcastControlChanged();
    await closeHttpServer(closing);
  }

  /**
   * 원격 리스너는 listenAddress/listenPort에 바인드한다. LAN-only는 그 tuple을 그대로 공표하고,
   * 명시적으로 Public endpoint를 켠 경우에만 advertisedHost/advertisedPort를 Host·Origin·링크·쿠키·인증서에 쓴다.
   *
   * Custom listen port는 정확히 한 번만 시도하고 대체하지 않는다. Auto는 저장된 concrete 값을
   * 먼저 시도한 뒤 EADDRINUSE/EADDRNOTAVAIL에 한해서만 다른 무작위 후보를 최대 12회까지 시험한다.
   * 단 그 대체는 아직 아무 주소도 공표하지 않았을 때뿐이다 — 한 번 공표한 뒤에는 포트가 잠깐
   * 막혔다는 이유로 다른 포트로 옮기지 않는다. 옮기면 링크가 알려 준 주소가 사라지고, LAN-only에서는
   * 그 포트가 곧 공표 tuple이라 전 기기의 페어링이 주인의 행위 없이 해제된다. 그 자리는 실패로 남기고
   * 주인이 포트를 비우거나 신원을 회전해 스스로 결정하게 한다.
   * Public mode의 새 후보는 확인이 필요한 split route라 리스너를 닫고 비활성화한다. LAN-only에서는
   * 새 후보 자체가 공표 tuple이므로 즉시 저장하고 같은 리스너를 정상 활성화한다.
   */
  async function startRemoteAccessIfEnabled(_actualPort: number): Promise<void> {
    const configured = consoleSettingsStore.load().general?.remoteAccess;
    if (configured?.enabled !== true || configured.listenAddress === "") return;
    if (configured.publicEndpointEnabled && !acknowledgmentMatches(configured, configured.acknowledgment)) return;
    const advertised = effectiveRemoteAccessAdvertisedTuple(configured);
    const previousIdentity = remoteIdentityStore.read();
    const identity = await remoteIdentityStore.ensure(advertised.host);
    const storedEndpoint = remoteEndpointStore.read();
    /**
     * 판정과 취소는 bind보다 먼저 끝난다. `ensure()`는 회전한 인증서를 이미 디스크에 남기므로,
     * bind가 실패해 취소를 건너뛰면 다음 기동에서는 그 새 인증서가 곧 previousIdentity가 되어
     * 변화가 감지되지 않는다 — 사라진 인증서에 묶인 페어링이 목록에만 살아남는다.
     *
     * 공표한 뒤에는 포트가 미끄러지지 않으므로(위 startConfiguredRemoteListener) 실제로 열릴 포트는
     * 이 시점에 이미 configured의 값으로 정해져 있고, 아직 공표 전이라면 포트 축 자체가 판정에 없다.
     */
    const publicIdentityChanged = previousIdentity === null || !fingerprintsMatch(previousIdentity.fingerprint, identity.fingerprint)
      || (storedEndpoint !== null && storedEndpoint.advertisedPort !== advertised.port);
    if (publicIdentityChanged) {
      access.revokeGrants("remote");
      access.revokeSessions("remote");
      pairedDeviceStore.revokeAll("remote");
      remoteEndpointStore.forget();
    }
    // 취소가 돌았다면 기억된 엔드포인트도 함께 지워졌다 — 지킬 주소가 없으므로 Auto는 다시 고를 수 있다.
    const started = await startConfiguredRemoteListener(configured, identity, storedEndpoint !== null && !publicIdentityChanged);
    const effectiveConfigured = started.port === configured.listenPort.value
      ? configured
      : { ...configured, listenPort: { ...configured.listenPort, value: started.port } };
    const effectiveAdvertised = effectiveRemoteAccessAdvertisedTuple(effectiveConfigured);
    // 소유권을 먼저 옮긴다 — 아래 내구성 쓰기가 실패하면 가드가 stopRemoteAccess를 부르는데,
    // 그때 remoteServer가 비어 있으면 이미 열린 소켓이 프로세스가 끝날 때까지 포트를 쥔 채 남는다.
    remoteServer = started.server;
    const listener: ListenerIdentity = {
      audience: "remote",
      host: effectiveAdvertised.host,
      port: effectiveAdvertised.port,
      origin: remoteOrigin(effectiveAdvertised.host, effectiveAdvertised.port),
      secure: true,
      bindAddress: started.address,
      bindPort: started.port,
    };
    listeners = [...listeners, listener];
    remoteFingerprint = identity.fingerprint;
    remoteEndpointStore.remember({ listenPort: started.port, advertisedPort: effectiveAdvertised.port });
    startControlExpirySweep();
  }

  async function startConfiguredRemoteListener(configured: ConsoleRemoteAccessSettings, identity: { readonly certificatePem: string; readonly privateKeyPem: string }, published: boolean): Promise<{ readonly server: https.Server; readonly address: string; readonly port: number }> {
    if (configured.listenPort.mode === "custom") {
      try {
        return await startRemoteListener({ identity, bindHost: configured.listenAddress, port: configured.listenPort.value, handler: handleRequest, upgradeRegistry, isHostAllowed: isRequestHostAllowed, isAdmitted: remoteAdmission });
      } catch (error) {
        if (errorCodeOf(error) === "EADDRINUSE") throw codedRemoteError("FLEET_CUSTOM_PORT_UNAVAILABLE", error);
        throw error;
      }
    }
    const attempted = new Set<number>();
    while (attempted.size < REMOTE_AUTO_PORT_ATTEMPTS) {
      const candidate = attempted.size === 0 ? configured.listenPort.value : nextRemoteAutoPort(attempted);
      attempted.add(candidate);
      try {
        const started = await startRemoteListener({ identity, bindHost: configured.listenAddress, port: candidate, handler: handleRequest, upgradeRegistry, isHostAllowed: isRequestHostAllowed, isAdmitted: remoteAdmission });
        if (candidate === configured.listenPort.value) return started;
        if (published) {
          // 여기까지 왔다면 공표한 포트가 막혀 다른 후보가 열린 것이다. 그 주소를 취하면
          // 기기가 받은 주소가 조용히 무효가 되므로, 열린 소켓을 닫고 주인에게 넘긴다.
          await closeHttpServer(started.server);
          throw codedRemoteError("FLEET_REMOTE_PORT_UNAVAILABLE");
        }
        const updated = { ...configured, listenPort: { mode: "auto" as const, value: candidate }, acknowledgment: null };
        if (configured.publicEndpointEnabled) {
          await closeHttpServer(started.server);
          consoleSettingsStore.update((current) => ({ ...current, general: { ...current.general, remoteAccess: { ...updated, enabled: false } } }));
          throw codedRemoteError("FLEET_ACKNOWLEDGMENT_REQUIRED");
        }
        try {
          consoleSettingsStore.update((current) => ({ ...current, general: { ...current.general, remoteAccess: updated } }));
        } catch (error) {
          // 아직 소유권이 넘어가기 전이라 바깥 정리가 이 소켓을 닫지 못한다. 여기서 닫지 않으면
          // 대체 포트를 프로세스가 끝날 때까지 쥔 채 남는다.
          await closeHttpServer(started.server);
          throw error;
        }
        return started;
      } catch (error) {
        const code = errorCodeOf(error);
        if (code === "FLEET_ACKNOWLEDGMENT_REQUIRED" || code === REMOTE_PORT_UNAVAILABLE) throw error;
        if (code !== "EADDRINUSE" && code !== "EADDRNOTAVAIL") throw error;
      }
    }
    throw codedRemoteError("FLEET_AUTO_PORT_EXHAUSTED");
  }

  function remoteOrigin(hostname: string, port: number): string {
    return listenerOrigin(hostname, port, true);
  }

  function remoteAdmission(req: http.IncomingMessage): boolean {
    const resolved = listenerForRequest(req);
    return resolved === null || resolved.audience === "local" || isRemoteRequestAdmitted(resolved, req, getPathname(req));
  }

  function nextRemoteAutoPort(attempted: ReadonlySet<number>): number {
    const randomInt = deps.remoteRandomInt ?? crypto.randomInt;
    // 주입된 RNG도 같은 값을 계속 돌려줄 수 있다. 무한 재추첨 대신 bounded draw 뒤에 순차
    // fallback으로 아직 시도하지 않은 값을 보장한다 — bind attempt 수는 바깥 Set이 12로 제한한다.
    for (let draw = 0; draw < REMOTE_AUTO_PORT_ATTEMPTS; draw += 1) {
      const candidate = randomInt(REMOTE_AUTO_PORT_MIN, REMOTE_AUTO_PORT_MAX + 1);
      if (!attempted.has(candidate)) return candidate;
    }
    for (let candidate = REMOTE_AUTO_PORT_MIN; candidate <= REMOTE_AUTO_PORT_MAX; candidate += 1) {
      if (!attempted.has(candidate)) return candidate;
    }
    throw codedRemoteError("FLEET_AUTO_PORT_EXHAUSTED");
  }

  function listenOnce(portToBind: number, statePatch: Omit<ConsolePortRuntimeState, "effectivePort">): Promise<ConsolePortListenResult> {
    return new Promise((resolve, reject) => {
      const srv = createHttpServer(handleRequest, upgradeRegistry, isRequestHostAllowed);
      const onError = (error: Error) => {
        reject(error);
      };
      srv.once("error", onError);
      srv.listen(portToBind, host, async () => {
        srv.off("error", onError);
        const address = srv.address();
        const actualPort = typeof address === "object" && address ? address.port : portToBind;
        const endpoint = `http://${host}:${actualPort}/`;
        // 게이트가 참조할 리스너 신원은 실제 바인드 포트가 정해진 뒤에만 확정된다.
        listeners = [createLoopbackListenerIdentity(actualPort)];
        boundPort = actualPort;
        try {
          await startRemoteAccessGuarded(actualPort);
          const localLoopbackServer = await maybeStartLoopbackServer(host, actualPort, handleRequest, upgradeRegistry, isRequestHostAllowed);
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

/**
 * 발급 요청이 고른 등급. 아는 이름 둘만 받는다.
 *
 * 모르는 값을 기본값으로 흘려보내면 그 기본값이 넓은 쪽이라 오타 하나가 좁히려던 발급을 넓힌다.
 * 등급은 발급자가 고르는 것이지 파서가 메우는 것이 아니므로, 읽지 못한 값은 `null`로 돌려
 * 호출자가 거절하게 한다. 값이 아예 없는 것은 고르지 않은 것이라 종전대로 `full`이다.
 */
function readAccessClass(req: http.IncomingMessage): AccessClass | null {
  const requested = new URL(req.url ?? "/", "http://localhost").searchParams.get("access");
  if (requested === null || requested === "full") return "full";
  return requested === "monitoring" ? "monitoring" : null;
}

/** 기기 이름은 사람이 자기 기기를 알아보는 단서일 뿐이다 — 표시 가능한 짧은 문자열로 자른다. */
function sanitizeDeviceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 48);
  return cleaned.length > 0 ? cleaned : null;
}

/** 링크를 받는 쪽 목록에 뜨는 이름. 기계 이름이 사람이 자기 콘솔을 알아보는 가장 짧은 단서다. */
function consoleLabel(): string {
  return sanitizeAccessLabel(os.hostname().replace(/\.local$/iu, "")) || "Fleet Console";
}


/** 경로에서 온 이름은 그대로 비교하지 않는다 — 디코드 실패는 존재하지 않는 이름으로 본다. */
function decodeHandle(raw: string): string {
  if (raw.includes("/")) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/** 원격 바인드 실패 사유를 안전한 코드로만 표면화한다 — 주소·경로는 밖으로 내보내지 않는다. */
function remoteAccessErrorCode(error: unknown): string {
  const code = errorCodeOf(error);
  if (code === "FLEET_AUTO_PORT_EXHAUSTED") return "auto_port_exhausted";
  if (code === "FLEET_ACKNOWLEDGMENT_REQUIRED") return "acknowledgment_required";
  if (code === "FLEET_CUSTOM_PORT_UNAVAILABLE") return "custom_port_unavailable";
  if (code === REMOTE_PORT_UNAVAILABLE) return "remote_port_unavailable";
  if (code === "EADDRNOTAVAIL") return "bind_address_unavailable";
  if (code === "EADDRINUSE") return "custom_port_unavailable";
  if (code === "EACCES") return "bind_permission_denied";
  return "remote_listener_failed";
}


function codedRemoteError(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code), { code, cause });
}

function errorCodeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
}

function isAddressInUse(error: unknown): boolean {
  return errorCodeOf(error) === "EADDRINUSE";
}

/**
 * 공표한 포트를 열지 못한 실패는 다른 바인드 실패와 결이 다르다 — 주소는 멀쩡하고, 막힌 것은
 * 이미 손님에게 알려 준 한 지점이다. 그래서 사용자에게 나가는 안내도 달라야 한다.
 */
const REMOTE_PORT_UNAVAILABLE = "FLEET_REMOTE_PORT_UNAVAILABLE";

function remotePortUnavailable(cause: unknown): Error {
  return Object.assign(new Error("remote_port_unavailable"), { code: REMOTE_PORT_UNAVAILABLE, cause });
}

function resolveBuiltInPluginDiscoveryRoots(packageRoot: string): { readonly builtInSourceRoot?: string; readonly builtInDistRoot: string } {
  const packageRootRepo = path.resolve(packageRoot, "..", "..");
  const sourceRoot = path.join(packageRootRepo, "runtime", "fleet-plugins");
  return {
    ...(fs.existsSync(sourceRoot) ? { builtInSourceRoot: sourceRoot } : {}),
    builtInDistRoot: path.join(packageRoot, "dist", "fleet-plugins"),
  };
}

/**
 * 업그레이드는 요청 경로와 같은 Host 경계를 먼저 통과해야 한다. 업그레이드 핸들러는
 * 거절을 바이트 없이 소켓 파기로만 표현하므로, 거절 사유를 밖에서 구분할 수 없다.
 * 순서(호스트 판정 → 레지스트리 위임)를 계약으로 고정하려고 접합부를 분리해 둔다.
 */
export function createUpgradeListener(deps: {
  readonly isHostAllowed: (req: http.IncomingMessage) => boolean;
  readonly upgradeRegistry: Pick<UpgradeRegistry, "handle">;
  /** 업그레이드도 요청과 같은 인가를 거친다 — 원격에서는 세션 없이 소켓을 붙일 수 없다. */
  readonly isAdmitted?: (req: http.IncomingMessage) => boolean;
}): (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    if (!deps.isHostAllowed(req) || deps.isAdmitted?.(req) === false) {
      socket.destroy();
      return;
    }
    const pathname = getPathname(req);
    if (deps.upgradeRegistry.handle({ req, socket, head, pathname })) return;
    socket.destroy();
  };
}

/**
 * 원격 리스너. 루프백과 달리 TLS를 쓰고, 링크가 실어 나른 지문이 이 인증서를 가리킨다.
 * 같은 핸들러를 공유하지만 요청은 소켓 주소로 자기 리스너를 찾으므로 경계가 섞이지 않는다.
 */
async function startRemoteListener(input: {
  readonly identity: { readonly certificatePem: string; readonly privateKeyPem: string };
  readonly bindHost: string;
  readonly port: number;
  readonly handler: http.RequestListener;
  readonly upgradeRegistry: UpgradeRegistry;
  readonly isHostAllowed: (req: http.IncomingMessage) => boolean;
  readonly isAdmitted: (req: http.IncomingMessage) => boolean;
}): Promise<{ readonly server: https.Server; readonly address: string; readonly port: number }> {
  const srv = https.createServer({ cert: input.identity.certificatePem, key: input.identity.privateKeyPem }, input.handler);
  srv.timeout = SERVER_TIMEOUT_MS;
  srv.keepAliveTimeout = SERVER_TIMEOUT_MS;
  srv.headersTimeout = SERVER_TIMEOUT_MS + 1000;
  srv.on("upgrade", createUpgradeListener({ isHostAllowed: input.isHostAllowed, upgradeRegistry: input.upgradeRegistry, isAdmitted: input.isAdmitted }));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    srv.once("error", onError);
    srv.listen(input.port, input.bindHost, () => {
      srv.off("error", onError);
      resolve();
    });
  });
  // 설정이 DNS 이름을 받으므로, 게이트가 비교할 주소는 바인드가 끝난 뒤 소켓에서 읽는다.
  const address = srv.address();
  return { server: srv, address: typeof address === "object" && address ? address.address : input.bindHost, port: typeof address === "object" && address ? address.port : input.port };
}

function createHttpServer(
  handler: http.RequestListener,
  upgradeRegistry: UpgradeRegistry,
  isHostAllowed: (req: http.IncomingMessage) => boolean,
): http.Server {
  const srv = http.createServer(handler);
  srv.timeout = SERVER_TIMEOUT_MS;
  srv.keepAliveTimeout = SERVER_TIMEOUT_MS;
  srv.headersTimeout = SERVER_TIMEOUT_MS + 1000;
  srv.on("upgrade", createUpgradeListener({ isHostAllowed, upgradeRegistry }));
  return srv;
}

async function maybeStartLoopbackServer(
  host: string,
  actualPort: number,
  handler: http.RequestListener,
  upgradeRegistry: UpgradeRegistry,
  isHostAllowed: (req: http.IncomingMessage) => boolean,
): Promise<http.Server | null> {
  if (isLoopbackHost(host) || isWildcardHost(host)) return null;
  const srv = createHttpServer(handler, upgradeRegistry, isHostAllowed);
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(actualPort, "127.0.0.1", () => {
      srv.off("error", reject);
      resolve();
    });
  });
  return srv;
}

/**
 * 리스너를 닫는 유일한 방법. `close()`만 부르면 **열려 있는 연결이 끝날 때까지** 완료되지
 * 않는데, SSE 스트림과 원격 창의 소켓은 스스로 끝나지 않는다 — 그래서 연결도 함께 끊는다.
 * 이것을 빠뜨린 리스너 하나가 프로세스 전체의 종료를 막는다.
 */
function closeHttpServer(srv: http.Server | https.Server | null): Promise<void> {
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

const CONSOLE_RESUME_PORT_ENV = "FLEET_CONSOLE_RESUME_PORT";

export function takeConsoleResumePort(env: NodeJS.ProcessEnv): number | null {
  const raw = env[CONSOLE_RESUME_PORT_ENV];
  delete env[CONSOLE_RESUME_PORT_ENV];
  if (raw === undefined) return null;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

function isValidConsoleStaticPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_CONSOLE_STATIC_PORT && value <= MAX_CONSOLE_STATIC_PORT;
}

function sanitizeLaunchKind(value: unknown): OperationLaunchKind | null {
  if (!isPlainObject(value) || typeof value.id !== "string" || typeof value.type !== "string" || typeof value.title !== "string") return null;
  const variants = readLaunchVariantGroups(value.variants);
  const launchViews = readLaunchViews(value.launchViews);
  return {
    id: value.id,
    type: value.type,
    title: value.title,
    ...(typeof value.disabled === "boolean" ? { disabled: value.disabled } : {}),
    ...(typeof value.disabledReason === "string" ? { disabledReason: value.disabledReason } : {}),
    ...(variants.length > 0 ? { variants } : {}),
    ...(launchViews.length > 0 ? { launchViews } : {}),
  };
}

/**
 * 이 실행 종류가 태어날 수 있는 표면. SDK의 브라우저 sanitizer와 같은 규칙이다 — 모르는 이름은
 * 버리고, `terminal` 하나만 남는 선언은 선택지가 아니므로 생략과 같게 접는다.
 */
function readLaunchViews(value: unknown): readonly OperationLaunchView[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<OperationLaunchView>();
  for (const entry of value) {
    if (entry === "terminal" || entry === "chat") seen.add(entry);
  }
  return seen.has("chat") ? [...seen] : [];
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

function writeNoContent(res: http.ServerResponse): void {
  res.writeHead(204, withSecurityHeaders({}));
  res.end();
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

/**
 * Host는 리스너가 실제로 바인드한 주소와만 일치해야 한다. 허용 집합을 요청 Host나 DNS에서
 * 유도하면 DNS rebinding으로 이 경계가 무너지므로, 비교 대상은 언제나 구성으로 정해진 리터럴이다.
 */
function validateHost(req: http.IncomingMessage, expectedHostPort: string, secure?: boolean): boolean {
  if (req.url?.startsWith("http://") || req.url?.startsWith("https://")) return false;
  const hostHeaderCount = req.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === "host").length;
  if (hostHeaderCount !== 1) return false;
  const hostHeader = req.headers.host;
  if (!hostHeader) return false;
  // 같은 권위의 두 표기를 하나로 본다. 기본 포트를 적은 형태와 생략한 형태는 URL 규격상 같은 곳이고,
  // 어느 쪽만 받으면 그 표기를 쓰는 클라이언트가 통째로 막힌다. 다른 포트는 그대로 구분한다.
  return stripDefaultPort(hostHeader, secure) === stripDefaultPort(expectedHostPort, secure);
}

function stripDefaultPort(authority: string, secure?: boolean): string {
  if (secure === undefined) return authority;
  const suffix = secure ? ":443" : ":80";
  return authority.endsWith(suffix) ? authority.slice(0, -suffix.length) : authority;
}

// 신규 terminal 라우트의 출처 경계. 브라우저 요청은 console origin과 일치해야 하고,
// Origin 헤더가 없는 비브라우저(CLI/도구) 호출은 허용한다(기존 register 채널과의 호환).
function isAllowedTerminalOrigin(req: http.IncomingMessage, expectedOrigin: string): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return origin === expectedOrigin;
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
