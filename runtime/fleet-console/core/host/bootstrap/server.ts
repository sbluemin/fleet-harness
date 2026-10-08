import { resolveConsoleFonts } from "../../../features/settings/host/settings-domain.js";
import { createRemoteHostsRoutes } from "../../../features/remote-access/host/host-routes.js";
import { createWorkspaceActions } from "../../../features/workspace/host/actions.js";
import { createOperationArchiveStorage, archiveEvent, archiveSessionNodes, OperationArchiveError } from "../../../features/workspace/host/operation-archive-storage.js";
import { createOperationArchiveCoordinator } from "../../../features/workspace/host/operation-archive.js";
import { createOperationArchiveRouter, OPERATION_ARCHIVE_API_CATALOG } from "../../../features/workspace/host/operation-archive-routes.js";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { createBrowserDesktopRouter } from "../../../features/browser/host/desktop-routes.js";
import { createComputerUseRouter } from "../../../features/computer-use/host/routes.js";
import { createPluginAgentHost } from "../../../features/execution/host/agent/plugin-agent.js";
import { createRemoteAdminRoutes } from "../../../features/remote-access/host/admin-routes.js";
import { createPairingRoutes } from "../../../features/remote-access/host/pairing-routes.js";
import { createUpdatesRoutes } from "../../../features/updates/host/routes.js";
import { createWorkspaceRoutes } from "../../../features/workspace/host/routes.js";
import { createMcpHttpTransport } from "../transport/mcp-http.js";
import { createConsoleRuntimeContext } from "../transport/runtime-context.js";
import type { RequestLifetime } from "../../../features/execution/host/context.js";
import { CORE_AGENT_SENSITIVE_FIELDS, startConsoleExecution } from "./execution.js";

import { createAiGatewaySettingsStore, resolveAiGatewaySelection } from "@fleet-console/ai-gateway";
import { reclaimLegacyTrees } from "@fleet-console/agent-runtime/fleet";
import { renderConsoleAgentCliPlugin } from "../../../features/execution/host/agent/host-hooks.js";
import { createLaunchPromptNamespace } from "../../../features/execution/host/agent/launch-prompt-namespace.js";
import { adoptLegacyWorkspaces, ensureWorkspaceDirectory, getFleetDataDir, withDirectoryLock } from "@fleet-console/infra";
import { readLaunchVariantGroups } from "@fleet-console/sdk/operations/launch-variants";
import { OPERATION_GROUP_REMOVED_EVENT_CHANNEL, OPERATION_GROUPED_EVENT_CHANNEL, OPERATION_LAUNCH_CHANGED_EVENT_CHANNEL, readOperationLaunch, withSubagentSpawn, withUserQuestions, type OperationLaunchChangedEvent } from "@fleet-console/sdk/operations";
import type { ConsoleExperimentSettings } from "@fleet-console/sdk/settings";
import { readConsoleQuotaSnapshot } from "../../../features/ai-gateway/host/gateway-loadout.js";
import { createModelRosterHost } from "../../../features/ai-gateway/host/model-roster.js";
import { createConsoleControl } from "../../../features/console-use/host/console-control.js";
import { createLaunchKeyLedger } from "../../../features/console-use/host/launch-keys.js";
import { createConsoleUseMcpHost, type ConsoleUseActions } from "../../../features/console-use/host/console-use.js";
import { createPluginAdmiralMcpHost } from "../plugin-host/mcp.js";

import { CuaDriverInstaller, createCuaComputerUsePlatform, createMacOSComputerUsePlatform } from "@fleet-console/computer-use";
import { DESKTOP_BROWSER_EVENT, DESKTOP_BROWSER_EVENTS_PATH, DESKTOP_BROWSER_PATH, DESKTOP_BROWSER_RELAY_PATH, DESKTOP_BROWSER_VIEW_HEADER, DESKTOP_WINDOW_COMMAND_EVENT, type DesktopWindowCommand } from "@fleet-console/protocol/desktop";
import { createOwnedProcessRegistry, pruneConsoleExitRecords, type OwnedProcessRegistry } from "@fleet-console/lifecycle";
import { CONSOLE_LIFECYCLE_WIRE, CONSOLE_STOP_REQUEST_PATH, CONSOLE_STOP_REQUEST_REVISION, OWNED_GROUP_TERM_GRACE_MS } from "@fleet-console/protocol/lifecycle";
import { DesktopEngine } from "../../../features/browser/host/desktop-engine.js";
import { createBrowserMcpHost } from "../../../features/browser/host/mcp.js";
import { createBrowserRouter } from "../../../features/browser/host/routes.js";
import { createBrowserScreenshotStore } from "../../../features/browser/host/screenshot-store.js";
import { BrowserService, GLOBAL_BROWSER_OWNER_ID, type BrowserAvailability } from "../../../features/browser/host/service.js";
import { ComputerUseService } from "../../../features/computer-use/host/computer-use.js";
import { createComputerUseMcpHost } from "../../../features/computer-use/host/mcp.js";
import { createUseRequestBroker } from "../../../features/console-use/host/use-requests.js";
import { resolveAgentCliBinary } from "../../../features/execution/host/agent/agent-cli-paths.js";
import type { OperationNode } from "../../../features/execution/host/operations/operations-domain.js";
import { createOperationStore, createOperationsRouter, createSanitizedOpDto } from "../../../features/execution/host/operations/operations-domain.js";
import { stripConsoleInternalEnv } from "../../../features/execution/host/terminal/launch-env.js";
import { CONTROL_CHANGED_EVENT, CONTROL_HOLDER_EVENT_CHANNEL, CONTROL_RECLAIMED_EVENT, controlChangedSnapshot, controlReclaimedSnapshot, type ControlHolderSnapshot, type ControlReclaimedReason } from "../../../features/remote-access/host/access-control-contract.js";
import { parseAccessLink, sanitizeAccessLabel } from "../../../features/remote-access/host/access-link.js";
import { createAccessRegistry, createLoopbackListenerIdentity, listenerAuthority, listenerOrigin, readPairingCookie, readSessionCookie, resolveListenerIdentity, type AccessAudience, type AccessClass, type ListenerIdentity } from "../../../features/remote-access/host/auth.js";
import { createPairedDeviceStore } from "../../../features/remote-access/host/paired-devices.js";
import { probeRemoteIdentity } from "../../../features/remote-access/host/remote-discovery.js";
import { createRemoteEndpointStore } from "../../../features/remote-access/host/remote-endpoint.js";
import { createRemoteHostStore, type RemoteHostRecord } from "../../../features/remote-access/host/remote-hosts.js";
import { createRemoteIdentityStore, fingerprintsMatch } from "../../../features/remote-access/host/remote-identity.js";
import { createRemoteJoinGuard } from "../../../features/remote-access/host/remote-join-guard.js";
import { createAgentOptionsService, createTheaterSystemPromptService } from "../../../features/settings/host/agent-options.js";
import { REMOTE_AUTO_PORT_ATTEMPTS, REMOTE_AUTO_PORT_MAX, REMOTE_AUTO_PORT_MIN, acknowledgmentMatches, createConsoleSettingsStore, createGlobalSettingsRouter, createPluginSettingsRouter, effectiveRemoteAccessAdvertisedTuple, readExperimentSettings, type ConsoleRemoteAccessSettings, type ConsoleThemeId, type RemoteAccessSettingsChange } from "../../../features/settings/host/settings-domain.js";
import { createConsoleReleaseNotesService, type ConsoleReleaseNotesService } from "../../../features/updates/host/release-notes/release-notes.js";
import { createConsoleUpdateApplyService, type ConsoleUpdateApplyService } from "../../../features/updates/host/update-apply.js";
import { createConsoleUpdateCheckService, type ConsoleUpdateCheckService } from "../../../features/updates/host/update-check.js";
import { DeferredDeletionError, createDeferredDeletionCoordinator, type DeferredDeletionReceipt } from "../../../features/workspace/host/deferred-deletion.js";
import { deletionOperations, STATE_VERSION, backupDurableStateV3, backupDurableStateV4, createConsoleDurableStateStore, readDurableStateVersion, type DurableConsoleState } from "../../../features/workspace/host/durable-state.js";
import { migrateLegacyCaptures } from "../../../features/workspace/host/legacy-capture-migration.js";
import type { TheaterRegistration } from "../../../features/workspace/host/theaters/theater-domain.js";
import { TheaterFolderListError, TheaterRegistry, canonicalizeTheaterPathSync, createFolderGrantStore, workspaceHash } from "../../../features/workspace/host/theaters/theater-domain.js";
import type { FleetPluginHostCapabilities, OperationCatalogPlugin, OperationLaunchCatalogProvider, OperationLaunchKind, OperationLaunchView } from "../plugin-host/plugin-host.js";
import { createFleetPluginHost, createPluginClientAssets } from "../plugin-host/plugin-host.js";
import { DESKTOP_FULLSCREEN_EVENT, DESKTOP_SHELL_UPDATE_COMMAND_EVENT, DESKTOP_SHELL_UPDATE_EVENT, DESKTOP_SHELL_EVENT, DESKTOP_THEME_EVENT, DESKTOP_UPDATE_EVENT, createDesktopFullscreenRouter, createDesktopShellUpdateRouter, createDesktopShellRouter, createDesktopThemeRouter, createDesktopUpdateRouter, createDesktopWindowCommandRouter, desktopFullscreenSnapshot, desktopThemeSnapshot, emptyDesktopShell, emptyDesktopShellUpdate, emptyDesktopShellUpdateCommand, emptyDesktopUpdateRequest, type DesktopShellSnapshot, type DesktopUpdateRequestSnapshot } from "../shell/desktop-contract.js";
import { readDesktopProtocolEnvironment } from "../shell/desktop-protocol.js";
import { createConsoleServeLifecycle, type ConsoleServeLifecycle } from "./serve-lifecycle.js";
import { createAgentProcessSpawner } from "./agent-process.js";
import { createSystemFontsRouter, createSystemFontsService, type SystemFontsService } from "../shell/system-fonts.js";
import { buildApiCatalog, type ApiCatalogEntry } from "../transport/api-catalog.js";
import type { ConsoleEnvironmentDiagnostics, ConsoleHealth, ConsoleObserverStatus, ConsoleTheaterInfo } from "../transport/console-contract-types.js";
import { CONSOLE_SECURITY_HEADERS, encodeSseData, isLoopbackRemoteAddress, startSseKeepaliveLifecycle, withSecurityHeaders } from "../transport/http-infra.js";
import { RouteRegistry, UpgradeRegistry } from "../transport/route-registry/registry.js";
import { createRemoteSessionBindings } from "../transport/remote-session-bindings.js";
import { createStaticConsoleHandler } from "../transport/static-console.js";
import type { DesktopShellUpdateCommandKind, DesktopShellUpdateCommandSnapshot, DesktopShellUpdateSnapshot } from "../shell/desktop-contract.js";
import { listLocalConsoles } from "./local-consoles.js";
import { createConsoleLock, type ConsoleLockHandle } from "./lock.js";
import { createConsoleDataPaths } from "./paths.js";
import { CONSOLE_FAILURE_LOG_FILE, createConsoleFailureLog } from "./failure-log.js";
import { readFleetConsoleRelease, type FleetConsoleRelease } from "./release.js";

export interface ConsoleServerDeps {
  readonly host?: string;
  readonly port?: number;
  readonly version?: string;
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
  /**
   * The instance's lifecycle state owner. `serve` passes the one its signal handlers and deadline share; without it the
   * server keeps its own, so every stop request still runs one shutdown.
   */
  readonly lifecycle?: ConsoleServeLifecycle;
  /**
   * The process groups this instance owns. `serve` passes the one its shutdown deadline ends; without it the server keeps
   * its own, so every agent CLI still starts in a registered group of its own.
   */
  readonly ownedProcesses?: OwnedProcessRegistry;
}

export interface ConsoleServer {
  readonly host: string;
  readonly port: number;
  start(lockPaths: { readonly dir: string; readonly lockFile: string }): Promise<string>;
  stop(): Promise<void>;
}

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
  /**
   * 바인드 실패 시 port 0으로 물러설 근거. 두 경우는 보고가 다르다:
   * - "requested": 사용자가 고정 포트를 요청했으나 쓰지 못했다 — 설정 화면이 그 사실을 알려야 한다.
   * - "resume": 업데이트 복귀용 옛 포트를 되찾지 못했다 — 사용자는 아무 포트도 요청하지 않았으므로
   *   동적 모드 보고(requestedPort null, portHonored true)를 그대로 유지한다.
   */
  readonly fallback: "none" | "requested" | "resume";
}

/** Operation 스트림에 실리는 브라우저 상태 프레임의 이름. 화면은 이 채널로 탭·주소·조작 여부를 듣는다. */
const BROWSER_STATE_EVENT = "browser:state";

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
  /** 네이티브 Operation 뷰는 Desktop 창 안의 페이지지만 Desktop 셸 권한을 갖지 않는다. */
  readonly client: "desktop" | "browser" | "operation-browser";
}

/** 화면을 든 클라이언트의 종류 — Desktop 창은 Electron 표기를 단 UA 로 온다(클라이언트의 셸 표식과 같은 판정). */
function clientKindOf(req: http.IncomingMessage): OperationSseSubscriber["client"] {
  const agent = req.headers["user-agent"];
  return typeof agent === "string" && /\bElectron\//u.test(agent) ? "desktop" : "browser";
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
/** 루프백 접속은 원격 세션 수명으로 끝나지 않는다. */
const LOCAL_REQUEST_LIFETIME: RequestLifetime = { isLive: () => true, touch: () => true };
const ENDED_REQUEST_LIFETIME: RequestLifetime = { isLive: () => false, touch: () => false };
const MAX_BODY_BYTES = 1024 * 1024;
/** 위임 요청의 시효. 수행자인 셸은 곧 이 창을 재시작하므로, 그보다 오래 걸려 있을 이유가 없다. */
const DESKTOP_UPDATE_REQUEST_TTL_MS = 60_000;
const OPERATION_RENAMED_EVENT_CHANNEL = "operation:renamed";
const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";
const OPERATION_RESTORED_EVENT_CHANNEL = "operation:restored";
/** 브라우저 스트림의 제거 프레임 — 삭제 유예에 들어간 Operation 의 id 만 싣는다. */
const OPERATION_REMOVED_SSE_EVENT = "operation:removed";
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
    path: "/api/v1/updates/check",
    summary: "Re-check the registry for a newer console version now, bypassing the cached result.",
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
  { method: "GET", path: "/api/v1/computer-use", summary: "Read local Computer Use status.", category: "Settings", gate: "loopback", transport: "http" },
  { method: "POST", path: "/api/v1/computer-use/install", summary: "Install a Fleet-managed Cua Driver after local request.", category: "Settings", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/computer-use/stop", summary: "Stop Computer Use and revoke session access.", category: "Settings", gate: "origin-strict", transport: "http" },
  { method: "GET", path: "/api/v1/desktop/computer-capture", summary: "Read the window Computer Use is capturing.", category: "Desktop", gate: "loopback", transport: "http" },
  { method: "GET", path: "/api/v1/operation-use", summary: "List the Operations currently using Console, the computer, or the browser.", category: "Observer", gate: "loopback", transport: "http" },
  { method: "GET", path: "/api/v1/browser", summary: "Read whether the Operation Browser can open for the attached Fleet Desktop, and why not otherwise.", category: "Settings", gate: "origin-write", transport: "http" },
  { method: "GET", path: "/api/v1/browser/operations/:operationId/state", summary: "Read an Operation's browser tab state; later changes arrive on the Operation event stream.", category: "Console Execution", gate: "origin-write", transport: "http" },
  { method: "GET", path: "/api/v1/browser/operations/:operationId/screenshot", summary: "Capture the active tab of an Operation's browser.", category: "Console Execution", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/browser/operations/:operationId/tabs", summary: "Create, close or select a tab in an Operation's browser.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/operations/:operationId/navigate", summary: "Navigate an Operation's browser tab as the user.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/operations/:operationId/viewport", summary: "Set the viewport preset or size of an Operation's browser.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/operations/:operationId/interrupt", summary: "Interrupt the agent's in-flight browser calls for an Operation.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/operations/:operationId/inspect", summary: "Describe the page element under a viewport coordinate.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "GET", path: "/api/v1/browser/operations/:operationId/favicon", summary: "Serve a tab's favicon through the Console (the page CSP allows no external images).", category: "Console Execution", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/browser/operations/:operationId/place", summary: "Tell the Desktop shell where an Operation's native browser view sits in the window.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "GET", path: DESKTOP_BROWSER_PATH, summary: "Read the native browser views and pending CDP commands the hosting Desktop shell must apply; other shells read an empty set.", category: "Desktop", gate: "origin-strict", transport: "http" },
  { method: "GET", path: DESKTOP_BROWSER_EVENTS_PATH, summary: "Stream native browser view snapshots to the attached Desktop shells; only the hosting shell receives views.", category: "Desktop", gate: "origin-strict", transport: "sse" },
  { method: "POST", path: DESKTOP_BROWSER_RELAY_PATH, summary: "Return CDP results, events, and view sizes from the hosting Desktop shell's native browser views.", category: "Desktop", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/operations/:operationId/paste", summary: "Put the panel's screenshot on this machine's clipboard and press paste in a terminal Operation's CLI.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "GET", path: "/api/v1/browser/import-sources", summary: "List the Google Chrome profiles on the attached Desktop whose cookies can be imported into an Operation's browser.", category: "Console Execution", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/browser/operations/:operationId/import", summary: "Import cookies from a Google Chrome profile on the attached Desktop into an Operation's browser session.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/operations/:operationId/profile", summary: "Choose whether an Operation's browser uses a temporary session or the persistent profile; open tabs close.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/operations/:operationId/clear-profile", summary: "Erase the persistent browser profile's cookies and site storage on the attached Desktop.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "GET", path: "/api/v1/browser/global/state", summary: "Read the Console-wide Fleet Browser tab state; later changes arrive on the Operation event stream.", category: "Console Execution", gate: "origin-write", transport: "http" },
  { method: "GET", path: "/api/v1/browser/global/screenshot", summary: "Capture the active tab of the Console-wide Fleet Browser.", category: "Console Execution", gate: "origin-write", transport: "http" },
  { method: "GET", path: "/api/v1/browser/global/favicon", summary: "Serve a Fleet Browser tab's favicon through the Console.", category: "Console Execution", gate: "origin-write", transport: "http" },
  { method: "POST", path: "/api/v1/browser/global/tabs", summary: "Create, close or select a tab in the Console-wide Fleet Browser.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/global/navigate", summary: "Navigate a Fleet Browser tab as the user.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/global/viewport", summary: "Set the viewport preset or size of the Fleet Browser.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/global/place", summary: "Tell the Desktop shell where the Fleet Browser floating sheet sits in the window.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/global/inspect", summary: "Describe the page element under a Fleet Browser viewport coordinate.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/global/profile", summary: "Choose whether the Fleet Browser uses a temporary session or the persistent profile.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/global/import", summary: "Import cookies from a Google Chrome profile on the attached Desktop into the Fleet Browser's current session.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/global/clear-profile", summary: "Erase the persistent browser profile's cookies and site storage on the attached Desktop.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/global/restore-closed-tabs", summary: "Restore previously closed tabs after reconnection in the Fleet Browser.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/global/dismiss-closed-tabs", summary: "Dismiss the suggestion to restore closed tabs in the Fleet Browser.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  { method: "POST", path: "/api/v1/browser/shortcuts", summary: "Update active Console shortcut bindings for Desktop native view forwarding.", category: "Console Execution", gate: "origin-strict", transport: "http" },
  {
    method: "GET",
    path: "/api/v1/health",
    summary: "Check console status with the lock token.",
    category: "Health",
    gate: "lock-token",
    transport: "http",
  },
  {
    method: "POST",
    path: CONSOLE_STOP_REQUEST_PATH,
    summary: "Ask the Console to stop itself with the lock token.",
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
  const theaters = new TheaterRegistry();
  // 그룹 이동·삭제는 서버 안 플러그인에도 사건이다 — 목표 같은 플러그인이 연결 항목을 따라 옮기거나 비운다.
  const operations = createOperationStore({
    onGroupChanged: (event) => publishPluginEvent(OPERATION_GROUPED_EVENT_CHANNEL, event),
    onGroupRemoved: (event) => publishPluginEvent(OPERATION_GROUP_REMOVED_EVENT_CHANNEL, event),
    // 전역 Fleet 브라우저의 소유자 id는 Operation이 가질 수 없다 — 그 이름의 Operation이 생기면 그 에이전트가 사람의 탭에 닿는다.
    isReserved: (id) => id === GLOBAL_BROWSER_OWNER_ID || archiveStorage.entries().some((entry) => entry.operation.id === id || entry.operation.childSessions?.some((child) => child.id === id)) || deletionCoordinator.hasPendingOperation(id),
    assertRelationMutable: (id) => operationArchive.assertMutable(id),
  });
  const folderGrants = createFolderGrantStore();
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
  const updateApply = deps.updateApply ?? createConsoleUpdateApplyService({ fleetDataDir, failureLogName: CONSOLE_FAILURE_LOG_FILE });
  const recordFailure = createConsoleFailureLog(durablePaths.dir);
  // Every long-lived child this instance starts on purpose (agent CLIs, the Computer Use broker) leads a group registered here.
  const ownedProcesses = deps.ownedProcesses ?? createOwnedProcessRegistry();
  const updateCheck = deps.updateCheck ?? createConsoleUpdateCheckService({
    readRelease: () => release,
    onLookupFailure: (error) => recordFailure("update_check_failed", error),
  });
  const durableStateStore = createConsoleDurableStateStore({ paths: durablePaths });
  const archiveStorage = createOperationArchiveStorage({ directory: durablePaths.dir, stateStore: durableStateStore });
  let stopForArchive: ((operation: OperationNode) => Promise<void>) | null = null;
  let purgeCoreOperation: ((operation: OperationNode) => void) | null = null;
  let resumeArchivedOperation: ConsoleUseActions["resume"];
  const consoleSettingsStore = createConsoleSettingsStore({ paths: durablePaths });
  // Agent 실행 옵션은 Console 설정 파일의 한 섹션이다. 옛 자리(Fleet 루트의 settings.json)는
  // 인스턴스를 가리지 않는 한 벌이었으므로 이 슬롯으로 한 번 승계한다.
  const agentOptions = createAgentOptionsService({ store: consoleSettingsStore, legacyDirs: [fleetDataDir] });
  const theaterSystemPrompts = createTheaterSystemPromptService(agentOptions, (id) => theaters.get(id) !== null);
  const tryServeStaticConsole = createStaticConsoleHandler(release.packageRoot, {
    getActiveTheme: () => consoleSettingsStore.load().general?.theme ?? "instrument",
    getLegacyGlassOff: () => consoleSettingsStore.load().general?.liquidGlass === false,
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
   * 세션 종료는 보유자 변화일 수 있으므로 제어 신호를 낸다. 종료 신호는 다른 레지스트리 호출 안에서
   * 도는 일이 많아(prune) 브로드캐스트를 그 자리에서 부르면 listSessions -> prune으로 되돌아온다.
   * 다음 틱으로 미뤄 재진입을 끊고, 같은 틱의 여러 종료를 한 번으로 합친다.
   */
  let controlEndNotifyQueued = false;
  /** 마지막으로 알린 보유자의 공개 이름. 바뀌지 않은 사실을 신호로 내보내지 않기 위한 기준이다. */
  let lastPublishedControlHolder: string | null = null;
  /** 원격 세션마다 그 세션으로 입장한 응답·업그레이드 소켓. 세션이 끝나면 여기서 한꺼번에 닫는다. */
  // access는 아래에서 만든다. 묶기는 요청이 들어온 뒤에만 일어나므로 그때는 이미 있다.
  const remoteSessionBindings = createRemoteSessionBindings({ isLive: (handle) => access.isSessionLive(handle), onFailure: recordFailure });
  /** 원격 입장 판정이 요청마다 정한 세션. 오래 사는 채널이 그 요청이 입장한 세션을 나중에 다시 묻는 자리다. */
  const remoteRequestSessions = new WeakMap<http.IncomingMessage, string>();
  const access = createAccessRegistry({
    /**
     * 원격 세션이 끝나는 모든 길(회수·대체·언페어링·만료·리스너 종료)이 이 한 자리를 지난다.
     * 순서가 있다: 회수 안내를 실을 Operation 스트림을 먼저 우아하게 닫고, 그 세션이 남긴 셸 상태를
     * 잊고, 그 다음 그 세션으로 열린 나머지 연결(다른 SSE·채팅/터미널 WebSocket·진행 중 요청)을
     * transport에서 파기한다. 안내를 쓰고 끝낸 응답은 파기 대상에서 빠지므로 마지막 프레임이 잘리지 않는다.
     * 한 세션의 실패가 나머지 정리를 막지 않는다.
     */
    onSessionsEnded: (ended) => {
      for (const { handle, notice } of ended) {
        try { endSessionStreams(handle, notice); } catch (error) { recordFailure("session_stream_end_failed", error); }
        try { forgetShellOwner(handle); } catch (error) { recordFailure("session_shell_forget_failed", error); }
        remoteSessionBindings.closeSession(handle);
      }
      if (controlEndNotifyQueued) return;
      controlEndNotifyQueued = true;
      queueMicrotask(() => {
        controlEndNotifyQueued = false;
        // reconcile은 이 제어 갱신에서 한 번만 한다.
        try { broadcastControlChanged(); } catch (error) { recordFailure("session_end_notification_failed", error); }
      });
    },
  });
  const remoteIdentityStore = createRemoteIdentityStore(durablePaths.dir);
  const remoteHostStore = createRemoteHostStore(durablePaths.dir);
  const pairedDeviceStore = createPairedDeviceStore(durablePaths.dir);
  const remoteEndpointStore = createRemoteEndpointStore(durablePaths.dir);
  const pluginOperationTypes = new Set<string>(["agent"]);
  const executionApiCatalog: ApiCatalogEntry[] = [];
  let coreLaunchKinds: OperationLaunchCatalogProvider = () => [];
  // 실행 기능이 서야 생긴다. 그 전의 별칭 고정은 받은 값을 돌려준다.
  let ensureClaudeNativeModels: (() => Promise<void>) | undefined;
  let resolveClaudeExecutable: (() => Promise<string | undefined>) | undefined;
  const executionCleanupCallbacks = new Set<() => void | Promise<void>>();
  const pluginPayloadSanitizers = new Map<string, readonly string[]>();
  const pluginLaunchCatalogProviders = new Map<string, OperationLaunchCatalogProvider[]>();
  const pluginCleanupCallbacks = new Set<() => void | Promise<void>>();
  const pluginEventListeners = new Map<string, Set<(payload: unknown) => void>>();
  const experimentListeners = new Set<(settings: ConsoleExperimentSettings) => void>();
  const operationSseSubscribers = new Set<OperationSseSubscriber>();
  const desktopThemeSseSubscribers = new Set<http.ServerResponse>();
  const desktopUpdateSseSubscribers = new Set<http.ServerResponse>();
  /**
   * 셸 자신의 갱신 — 상태는 셸이 게시하고 창이 읽으며, 명령은 창이 보내고 셸이 읽는다. 두 방향 모두
   * 소유자별로 갈라 담는다. 원격 Desktop이 붙어 있으면 두 창은 서로 다른 기계의 앱을 말하고 있다.
   */
  const desktopShellUpdateCommandSseSubscribers = new Map<http.ServerResponse, string>();
  /** 창 조작 명령 구독 — 응답마다 그 셸의 주인. 명령은 걸어 두지 않으므로 지금 붙은 셸만 듣는다. */
  const desktopWindowCommandSseSubscribers = new Map<http.ServerResponse, string>();
  /** 셸의 브라우저 스냅샷 구독 — 응답마다 그 셸의 주인(루프백은 "local", 원격은 세션 공개 이름). */
  const desktopBrowserSseSubscribers = new Map<http.ServerResponse, string>();
  /**
   * Operation 브라우저의 엔진 — 창을 든 Fleet Desktop 안의 실제 Chromium 뷰. 어느 Desktop 이 이 콘솔을 보든(이 기계의
   * 창이든, 원격에서 건너온 창이든) 붙을 수 있고, 뷰는 그중 호스트 하나의 창에만 산다. 호스트가 아닌 셸은 빈 스냅샷을
   * 받는다 — 그 창에는 뷰가 없어야 한다.
   */
  const desktopEngine = new DesktopEngine({
    publish: (snapshot, host) => {
      if (desktopBrowserSseSubscribers.size === 0) return;
      settleRemoteExpiry();
      const full = encodeSseData(DESKTOP_BROWSER_EVENT, snapshot);
      const empty = encodeSseData(DESKTOP_BROWSER_EVENT, { generation: snapshot.generation, views: [], commands: [] });
      for (const [res, owner] of desktopBrowserSseSubscribers) if (!res.destroyed) res.write(owner === host ? full : empty);
    },
    log: (message) => process.stdout.write(`[fleet-browser] ${message}\n`),
  });
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
  const pluginTheaterFlags = new Map<string, (theaterId: string) => boolean>();

  /**
   * Theater 생명주기. 플러그인이 Theater마다 자기 저장소를 열고 닫으려면 이 순간들을
   * 알아야 한다 — 새 API를 내지 않고 기존 이벤트 채널로 낸다(구독 방식이 이미 있다).
   * realpath는 싣지 않는다: 절대 경로는 호스트 소유이고, 필요한 플러그인은
   * `paths.resolveTheaterPath`로 서버 안에서 스스로 푼다.
   */
  function publishTheaterLifecycle(event: "registered" | "forgotten" | "restored", theaterId: string): void {
    publishPluginEvent(`theater:${event}`, { theaterId });
  }
  // 브라우저도 같은 순간을 들어야 한다 — 다른 창·API·Console Use가 잊거나 되돌린 Theater는 이 스트림이
  // 아니면 다음 재수화까지 사이드바에 남는다. 싣는 것은 theaterId뿐이라 그대로 내보낸다.
  for (const channel of ["theater:registered", "theater:forgotten", "theater:restored"]) pluginSseChannels.add(channel);

  function publishPluginEvent(channel: string, payload: unknown, isolateListeners = false): void {
    for (const listener of pluginEventListeners.get(channel) ?? []) {
      if (!isolateListeners) listener(payload);
      else try { listener(payload); } catch (error) { recordFailure("operation_lifecycle_listener_failed", error); }
    }
    // 브라우저로 나가는 것은 플러그인이 명시적으로 올린 채널뿐이다. 모든 in-process
    // 이벤트를 흘리면 서버 내부 채널이 그대로 브라우저 계약이 되고, 그중 하나는
    // 언젠가 민감한 필드를 싣는다.
    if (!pluginSseChannels.has(channel) || operationSseSubscribers.size === 0) return;
    const data = encodeSseData(channel, payload);
    for (const subscriber of operationSseSubscribers) writeOperationSse(subscriber, data);
  }
  // 멱등 기동 키 원장 — 살아 있는 키는 Operation, 유예 중인 키는 tombstone 에서 읽고, purge 는 흔적을 지우기 전에 선기록한다.
  const launchKeys = createLaunchKeyLedger({
    directory: path.join(durablePaths.dir, "console-use"),
    operations: () => [...operations.list(), ...archiveStorage.entries().map((entry) => entry.operation)],
    tombstoned: () => deletionCoordinator.list().flatMap(deletionOperations),
  });
  const deletionCoordinator = createDeferredDeletionCoordinator({
    operations,
    theaters,
    save: saveDurableState,
    archives: () => archiveStorage.entries(),
    assertMutable: (id) => operationArchive.assertMutable(id),
    beforePurge: (purged, tombstone) => {
      if (!purgeCoreOperation) throw new OperationArchiveError(503, "archive_recovery_required");
      launchKeys.recordPurged(purged);
      for (const operation of purged.flatMap(archiveSessionNodes)) purgeCoreOperation(operation);
      if (tombstone.kind === "theater") theaterSystemPrompts.purge(tombstone.targetId);
    },
    // 삭제·복원은 화면 사건이기도 하다. 누른 창은 스스로 다시 조회하지만 다른 창과 에이전트가 닫은
    // 경우는 이 스트림이 유일한 길이다 — 안 흘리면 그 Operation 은 다음 재수화까지 화면에 남는다.
    // in-process 채널은 전체 노드를 싣기에 그대로 내보내지 않고, 제거는 id 만·복원은 정화된 DTO 로 낸다.
    publish: (channel, payload) => {
      if (channel === "operation:purged") { operationArchive.flushEvents(); return; }
      publishPluginEvent(channel, payload);
      const event = payload as { readonly operationId?: unknown; readonly operation?: unknown };
      if (channel === OPERATION_DELETED_EVENT_CHANNEL && typeof event.operationId === "string") broadcastOperationRemoved(event.operationId);
      else if (channel === OPERATION_RESTORED_EVENT_CHANNEL && event.operation && typeof event.operation === "object") {
        const operation = event.operation as OperationNode;
        // 복원된 자식은 내부 수명 이벤트만 낸다. 화면은 부모의 childSessions에서 파생한다.
        if (!operation.parentOperationId) broadcastOperationChanged(operation);
      }
    },
    unregisterTheaterWorkspaces: (theaterId) => {
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
      publishTheaterLifecycle("restored", theater.id);
    },
  });
  const pendingClusterRemoved = new Set<string>();
  const operationArchive = createOperationArchiveCoordinator({
    operations, storage: archiveStorage,
    snapshot: () => snapshotDurableState(deletionCoordinator.list()),
    theaterExists: (id) => !!theaters.get(id),
    pendingDeletion: (id) => deletionCoordinator.hasPendingOperation(id),
    stop: async (operation) => {
      if (!stopForArchive) throw new OperationArchiveError(503, "archive_stop_failed");
      await stopForArchive(operation);
    },
    use: async (id, intent) => {
      if (intent === "resume") {
        const result = await resumeArchivedOperation?.(id);
        if (!result?.ok) throw new OperationArchiveError(409, result && !result.ok ? result.error : "archive_stop_failed");
      } else if (intent === "open" || intent === "activate") publishPluginEvent("operation:reveal", { operationId: id, reason: "", at: Date.now() });
    },
    publish: (event) => {
      for (const node of archiveSessionNodes(event.operation)) {
        if (event.channel === "operation:purged") {
          if (!purgeCoreOperation) throw new OperationArchiveError(503, "archive_recovery_required");
          launchKeys.recordPurged([node]);
          purgeCoreOperation(node);
        }
        publishPluginEvent(event.channel, { eventId: `${event.eventId}:${node.id}`, operationId: node.id, theaterId: node.theaterId, pluginId: node.pluginId, type: node.type,
          ...(event.channel === "operation:restored" ? { operation: node } : {}) }, true);
        if (event.channel === "operation:archived") pendingClusterRemoved.add(node.id);
      }
    },
    publishChanged: publishArchiveChanged,
  });
  for (const channel of ["operation:archive-changed", "operation:cluster-changed", "operation:purged"]) pluginSseChannels.add(channel);
  // 플러그인 capability는 기존 boolean 표면을 유지하되 실제 삭제는 receipt coordinator가 소유한다.
  function deleteOperationForPlugin(operationId: string): boolean {
    if (operations.getChild(operationId)) return false;
    return deletionCoordinator.deleteOperation(operationId) !== null;
  }
  function deleteChildForPlugin(id: string, requesterPluginId?: string): boolean {
    const found = operations.getChild(id);
    if (!found) return false;
    // 요청 플러그인이 없는 호출은 코어 실행 호스트의 롤백·정리뿐이다 — 플러그인 표면은 plugin-host 가 늘 호출 플러그인을 묶는다.
    const before = operations.list();
    operations.deleteChild(id, requesterPluginId);
    try { persistDurableState(); } catch (error) { operations.replace(before); throw error; }
    publishPluginEvent(OPERATION_DELETED_EVENT_CHANNEL, { operationId: id, pluginId: null, type: "agent" });
    publishPluginEvent("operation:purged", { operationId: id, pluginId: null, type: "agent" });
    broadcastOperationChanged(operations.get(found.parent.id)!);
    return true;
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
  const desktopShellUpdatesByOwner = new Map<string | "local", DesktopShellUpdateSnapshot>();
  /**
   * 걸어 둔 명령은 붙는 구독자마다 다시 들려주므로 시효가 있어야 한다 — 없으면 한참 뒤에 붙은 셸이
   * 사용자가 잊은 명령으로 앱을 재시작한다. Console 위임 요청과 같은 이유, 같은 시효다.
   */
  const desktopShellUpdateCommandsByOwner = new Map<string | "local", { readonly snapshot: DesktopShellUpdateCommandSnapshot; readonly at: number }>();
  // 창을 들고 있는 Desktop이 게시하는 호스트 목록. 브라우저 단독이면 비어 있다.
  let unsubscribeUpdateCheckChanges = updateCheck.onChange?.(() => {
    broadcastUpdateAvailable();
  }) ?? null;
  // MCP 로스터가 읽는 선별. 설정 화면이 쓰는 자리와 **같은 파일**이어야 한다 — 자리가
  // 갈리면 사용자가 켠 모델이 위임 로스터에 영영 나타나지 않는다. 같은 파일을 두 스토어가
  // 보지만 락과 승계 표식(목적지 파일의 존재)이 같아 서로를 덮지 않는다.
  const gatewaySettings = createAiGatewaySettingsStore({
    dataDir: durablePaths.dir,
    legacyDirs: [fleetDataDir, path.join(durablePaths.dir, "plugins", "terminal")],
  });
  const mcpHttp = createMcpHttpTransport(() => pluginHostCapabilities.server.origin());
  const consoleAgentOwners = new Set<string>();
  // 플러그인이 등록한 서브에이전트 호출 판단(redirectAgentCalls). 플러그인 id마다 하나다.
  const agentCallRedirects = new Map<string, (operationId: string) => string | null>();
  const consoleControl = createConsoleControl({ pluginAvailable: (pluginId) => consoleAgentOwners.has(pluginId), launchKeys, directory: path.join(durablePaths.dir, "console-use"), operations: () => operations.list(), resolveOperation: operations.get, theaters: () => theaters.list().map((theater) => ({ id: theater.id, name: path.basename(theater.realpath) })) });
  let computerCaptureTarget: { id: string; pid: number; windowId: number; processStartedAt: number; title: string; operationId: string } | null = null;
  const COMPUTER_CAPTURE_STATE_EVENT = "computer-capture:state";
  let computerCaptureWatch: ReturnType<typeof setTimeout> | null = null;
  let lastComputerCaptureSnapshot: string | null = null;
  const computerUseDirectory = path.join(fleetDataDir, "computer-use");
  const computerUseInstaller = new CuaDriverInstaller(computerUseDirectory);
  const computerUseRuntime = {
    resolveCodex: () => resolveAgentCliBinary({ cliCommand: "codex", env: process.env, userPaths: {} }).resolved ?? null,
    childEnv: () => stripConsoleInternalEnv(process.env),
    spawnProcess: (request: Parameters<typeof ownedProcesses.spawn>[0]) => ownedProcesses.spawn(request),
  };
  const computerUsePlatforms = {
    "sky-computer-use": createMacOSComputerUsePlatform(computerUseRuntime),
    "cua-driver": createCuaComputerUsePlatform(computerUseDirectory, computerUseRuntime),
  };
  const computerUse = new ComputerUseService({
    onCaptureTarget: (target) => {
      const operationId = target ? computerUseMcp.operationIdForOwner(target.owner) : null;
      if (!target || !operationId || !operations.get(operationId)) computerCaptureTarget = null;
      else if (computerCaptureTarget?.pid === target.pid && computerCaptureTarget.windowId === target.windowId
        && computerCaptureTarget.processStartedAt === target.processStartedAt && computerCaptureTarget.operationId === operationId) {
        computerCaptureTarget = { ...computerCaptureTarget, title: target.title };
      } else {
        computerCaptureTarget = { pid: target.pid, windowId: target.windowId, processStartedAt: target.processStartedAt, title: target.title, operationId, id: crypto.randomUUID() };
      }
      broadcastComputerCapture();
      watchComputerCapture();
    },
    platform: computerUsePlatforms[readExperimentSettings({ load: consoleSettingsStore.readSnapshot }).computerUseBackend],
    directory: computerUseDirectory,
    onFailure: recordFailure,
    diagnostic: (event) => (event.outcome === "unknown" || (event.outcome === "error" && event.error !== "computer_use_app_closed") ? process.stderr : process.stdout).write(`[fleet-computer-use] ${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`),
    enabled: () => readExperimentSettings({ load: consoleSettingsStore.readSnapshot }).computerUse,
    localControl: () => !access.hasSession("remote", "full") && !access.hasSession("remote", "monitoring"),
    onActiveOwnerChange: () => scheduleOperationUseBroadcast(),
  });
  // 패널 안 허용 요청 — 콘솔 사용과 컴퓨터 사용이 같은 브로커를 나눠 쓴다. 메모리 전용이라 재시작하면 비어 있다.
  const useRequests = createUseRequestBroker({ onChange: () => scheduleOperationUseBroadcast() });
  const computerUseMcp = createComputerUseMcpHost({
    transport: mcpHttp.transport,
    onFailure: recordFailure,
    service: computerUse,
    requests: useRequests,
    operations: () => operations.list(),
    resolveOperation: operations.get,
    experimentEnabled: () => readExperimentSettings(consoleSettingsStore).computerUse,
    language: () => { const value = consoleSettingsStore.load().general?.language; return value === "en" || value === "ko" ? value : null; },
  });
  const browserService = new BrowserService({
    enabled: () => true,
    availability: browserAvailability,
    log: (message) => process.stdout.write(`[fleet-browser] ${message}\n`),
    desktop: desktopEngine,
    defaultProfile: {
      // 미기동 Browser의 실패 정리도 상태를 읽는다. lock 패자의 정리가 설정 승계를 쓰면 안 된다.
      read: () => consoleSettingsStore.readSnapshot().browser?.defaultProfile ?? null,
      write: (profile) => { consoleSettingsStore.update((current) => ({ ...current, browser: profile === null ? {} : { defaultProfile: profile } })); },
    },
  });
  /**
   * 브라우저 상태는 Operation 스트림을 함께 탄다 — 패널이 자기 스트림을 따로 열면 그 연결이 화면의 연결 예산
   * (origin 당 여섯)을 먹고, 다 차는 순간 그 화면에서 나가는 모든 요청이 조용히 큐에 갇힌다.
   * 뷰를 가진 Desktop 창에만 보낸다: 브라우저는 그 창에서만 열리고, 다른 화면에는 그릴 자리가 없다.
   */
  browserService.onState((state) => {
    // driving 이 바뀌면 operation-use 의 browser 배열이 바뀐다 — 스냅샷을 다시 흘린다(변한 게 없으면 스킵).
    scheduleOperationUseBroadcast();
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData(BROWSER_STATE_EVENT, state);
    for (const subscriber of operationSseSubscribers) if (subscriber.client === "desktop") writeOperationSse(subscriber, data);
  });
  // 스크린샷은 Console 호스트에 놓인다 — 뷰를 그리는 Desktop 은 원격일 수 있어도 도구를 부르는 에이전트는
  // 언제나 이 기계에서 돌기 때문이다.
  const browserScreenshots = createBrowserScreenshotStore({
    dataDir: durablePaths.dir,
    log: (message) => process.stdout.write(`[fleet-browser] ${message}\n`),
  });
  const browserMcp = createBrowserMcpHost({
    transport: mcpHttp.transport,
    onFailure: recordFailure,
    service: browserService,
    screenshots: browserScreenshots,
    operations: () => operations.list(),
    resolveOperation: operations.get,
    language: () => { const value = consoleSettingsStore.load().general?.language; return value === "en" || value === "ko" ? value : null; },
  });
  const consoleUseActivity = new Map<string, number>();
  const CONSOLE_REVEAL_EVENT_CHANNEL = "operation:reveal";
  pluginSseChannels.add(CONSOLE_REVEAL_EVENT_CHANNEL);
  // 제스처 채널 — 호출자·도구·대상·시각만. 읽은 내용은 싣지 않는다.
  const CONSOLE_CALL_EVENT_CHANNEL = "console-use:call";
  pluginSseChannels.add(CONSOLE_CALL_EVENT_CHANNEL);
  // 에이전트가 닫으면 사람 화면에도 되돌리기 배너가 서야 한다 — 저자와 함께.
  const OPERATION_CLOSING_EVENT_CHANNEL = "operation:closing";
  pluginSseChannels.add(OPERATION_CLOSING_EVENT_CHANNEL);
  const listOperationUse = () => {
    const experiments = readExperimentSettings(consoleSettingsStore);
    const consoleOperations: string[] = [];
    for (const [id] of consoleUseActivity) {
      const operation = operations.get(id);
      if (!operation) continue;
      // 「이번 작업만」 허가로 쓰는 중이어도 사용 중이다.
      if ((operation.payload.consoleUse as { enabled?: boolean } | undefined)?.enabled === true || useRequests.granted(id, "console")) consoleOperations.push(id);
    }
    const owner = computerUse.activeOwner();
    const computerOperation = owner && experiments.computerUse ? computerUseMcp.operationIdForOwner(owner) : null;
    const browserOperations = browserService.status().operations.filter((id) => !!operations.get(id) && browserService.state(id).driving);
    return { console: consoleOperations, computer: computerOperation, browser: browserOperations };
  };
  /**
   * Console Use 확장면 중 서버가 소유하는 묶음 — Operation 저장소(이름·액센트·그룹), 삭제 유예(닫기), 사용 목록,
   * 화면 사건(보이기). 재개·뷰·대화·분석가는 실행층이 같은 객체에 채운다(`ctx.consoleActions`).
   */
  const consoleActions = createWorkspaceActions({ operations, deletionCoordinator, archive: operationArchive.archive, listOperationUse, patchOperation: (id, input) => pluginHostCapabilities.operations.patch(id, input), publishPluginEvent, persistDurableState, broadcastGroupRemoved, broadcastGroupChanged, broadcastOperationChanged });
  // 실행 라우트가 시작될 때 채워진다. 플러그인은 그 뒤에 부팅하며, 동일한 sleep 동작을 공유한다.
  let sleepOperation: ConsoleUseActions["sleep"];
  const consoleUse = createConsoleUseMcpHost({
    surface: consoleActions,
    onCall: (event) => publishPluginEvent(CONSOLE_CALL_EVENT_CHANNEL, event),
    onOperationUse: (operationId, active) => {
      const count = Math.max(0, (consoleUseActivity.get(operationId) ?? 0) + (active ? 1 : -1));
      if (count) consoleUseActivity.set(operationId, count);
      else consoleUseActivity.delete(operationId);
      scheduleOperationUseBroadcast();
    },
    control: consoleControl,
    requests: useRequests,
    transport: mcpHttp.transport,
    onFailure: recordFailure,
    theaters: () => theaters.list().map((theater) => ({ id: theater.id, name: path.basename(theater.realpath) })),
    operations: () => operations.list(),
    resolveOperation: operations.get,
    // `auto`는 브라우저가 푸는 값이라 호스트는 못박은 경우에만 답한다.
    language: () => { const value = consoleSettingsStore.load().general?.language; return value === "en" || value === "ko" ? value : null; },
  });
  // 플러그인 MCP 도구의 호출자 — Console Use 와 같은 규칙으로 세션 라벨(`<operationId>` 또는 `chat:<operationId>`)을 Operation 으로 푼다.
  const pluginMcp = createPluginAdmiralMcpHost(mcpHttp.transport, {
    onFailure: recordFailure,
    resolveCaller: (label) => {
      const operationId = label.startsWith("chat:") ? label.slice(5) : label;
      return operations.get(operationId) ? { kind: "operation", operationId } : null;
    },
  });
  const pluginHostCapabilities: FleetPluginHostCapabilities = {
    agent: { createSession: () => Promise.reject(new Error("Agent execution requires a plugin context")) },
    consoleUse,
    mcpTransport: mcpHttp.transport,
    admiralMcp: {
      connect: () => pluginMcp.connect(),
      register: () => { throw new Error("Plugin MCP registration requires a plugin context"); },
    },
    operations: {
      describe: operationArchive.describe,
      listArchived: operationArchive.listArchived,
      archive: operationArchive.archive,
      access: operationArchive.access,
      restore: operationArchive.restore,
      undoArchive: operationArchive.undoArchive,
      previewPurge: operationArchive.previewPurge,
      purge: operationArchive.purge,
      isTransitioning: operationArchive.isTransitioning,
      list: () => operations.list(),
      get: (id) => operations.get(id),
      create: (input) => {
        if (input.id && deletionCoordinator.hasPendingOperation(input.id)) throw new Error("pending_deletion");
        const operation = operations.create(input);
        persistDurableState();
        broadcastOperationChanged(operation);
        return operation;
      },
      createChild: (input) => {
        const existing = operations.getChild(input.childSessionId);
        const before = existing ? null : operations.list();
        const child = operations.createChild(input);
        if (before) {
          try { persistDurableState(); } catch (error) { operations.replace(before); throw error; }
          broadcastOperationChanged(operations.get(input.parentOperationId)!);
        }
        return child;
      },
      patch: (id, input) => {
        archiveStorage.assertReady();
        const parentId = operations.getChild(id)?.parent.id;
        const before = operations.get(parentId ?? id);
        const launchBefore = launchJson(id);
        const operation = operations.patch(id, input);
        if (operation && before) {
          persistDurableState();
          // 브라우저가 볼 수 있는 투영이 실제로 달라졌을 때만 밀어낸다 — 민감 필드
          // (providerSession 등)만 바뀐 patch는 sanitized DTO가 같아 계속 침묵하고,
          // payload 모드 마커(예: chatMode)처럼 뷰 분기를 쥔 변화는 리로드 없이 도달한다.
          const changed = operations.get(parentId ?? id)!;
          if (sanitizedOperationJson(before) !== sanitizedOperationJson(changed)) {
            broadcastOperationChanged(changed);
          }
          // 플러그인 서버는 브라우저 SSE 를 듣지 못한다 — 세션 좌표·표면이 바뀐 때만 id 힌트를 낸다. 저장은 이미 끝났으니
          // 구독자의 예외가 이 patch 를 부른 실행 경로로 새지 않게 격리한다.
          if (launchBefore !== launchJson(id)) {
            publishPluginEvent(OPERATION_LAUNCH_CHANGED_EVENT_CHANNEL, { operationId: id, parentOperationId: parentId ?? null } satisfies OperationLaunchChangedEvent, true);
          }
        } else if (operation) {
          persistDurableState();
        }
        return operation;
      },
      delete: deleteOperationForPlugin,
      deleteChild: deleteChildForPlugin,
      reorder: (input) => consoleActions.reorder!(input),
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
      // 그룹 — 사이드바가 Operation 을 묶는 그 그룹을 플러그인 목록으로 연다. 사람의 PATCH 와 같은 길(영속 + 방송).
      groups: {
        list: (theaterId) => (theaterId ? operations.listGroups(theaterId) : operations.listAllGroups()),
        get: (id) => operations.listAllGroups().find((group) => group.id === id) ?? null,
        create: (input) => { const group = operations.createGroup(input); persistDurableState(); broadcastGroupChanged(group); return group; },
        patch: (id, input) => { const group = operations.updateGroup(id, input); if (group) { persistDurableState(); broadcastGroupChanged(group); } return group; },
        delete: (id) => {
          const existing = operations.listAllGroups().find((group) => group.id === id);
          if (!existing || operations.list().some((node) => node.groupId === id)) return false;
          const deleted = operations.deleteGroup(id);
          if (deleted) { persistDurableState(); broadcastGroupRemoved(id, existing.theaterId); }
          return deleted;
        },
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
      consoleDataDir: durablePaths.dir,
      pluginDataDir: (pluginId) => path.join(durablePaths.dir, "plugins", pluginId),
      resolveTheaterPath: (theaterId) => theaters.get(theaterId)?.realpath ?? null,
      listTheaterIds: () => theaters.list().map((theater) => theater.id),
      canonicalizeTheaterPath: canonicalizeTheaterPathSync,
      workspaceHash,
      ensureWorkspaceDirectory: (cwd: string) => {
        const workspace = ensureWorkspaceDirectory(durablePaths.dir, cwd);
        return { path: workspace.path, id: workspaceHash(workspace.cwd) };
      },
      withDirectoryLock: <T,>(lockDir: string, operation: () => T): T => withDirectoryLock({ lockDir }, operation),
    },
    theaterFlags: {
      register: (flag: string, resolve: (theaterId: string) => boolean) => {
        pluginTheaterFlags.set(flag, resolve);
        return () => {
          if (pluginTheaterFlags.get(flag) === resolve) pluginTheaterFlags.delete(flag);
        };
      },
    },
    // 플러그인의 모델 좌표 해석. Gateway 설정 파일을 플러그인이 직접 열지 않도록 같은 파일의 로스터 투영만 내준다.
    models: createModelRosterHost({ readSettings: gatewaySettings.read, ensureClaudeNativeModels: async () => { await ensureClaudeNativeModels?.(); } }),
    experiments: {
      read: () => readExperimentSettings(consoleSettingsStore),
      subscribe: (listener) => {
        experimentListeners.add(listener);
        return () => {
          experimentListeners.delete(listener);
        };
      },
    },
    storage: {
      readJson: (pluginId, key) => readPluginStorageJson(durablePaths.dir, pluginId, key),
      writeJson: (pluginId, key, value) => writePluginStorageJson(durablePaths.dir, pluginId, key, value),
    },
    http: {
      writeJson,
      readJsonBody,
      securityHeaders: (extra) => ({ ...CONSOLE_SECURITY_HEADERS, ...(extra ?? {}) }),
    },
    security: {
      validateHost: isRequestHostAllowed,
      isTerminalAuthorized,
      isLockAuthorized,
      resolveTerminalSocketRole,
      isWriteAdmitted,
      expectedOrigin: expectedOriginFor,
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
    registerAdmiralMcp: (pluginId, tools) => pluginMcp.register(pluginId, tools),
    contributeConsoleUse: (pluginId, tools) => consoleUse.forPlugin(pluginId).contribute!(tools),
    // A plugin's child leads a group this Console owns and ends however the Console ends; spawn is all a plugin gets.
    spawnOwnedProcess: (pluginId, request) => {
      const child = ownedProcesses.spawn({
        command: request.command,
        args: request.args,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        env: request.env ?? process.env,
        stdin: request.stdin ?? "pipe",
        owner: `plugin:${pluginId}`,
      });
      return Object.assign(child, { killGroup: (signal?: NodeJS.Signals) => ownedProcesses.killGroup(child, signal) });
    },
    // Console 제어 — `console_launcher`·`console_operation` send 가 지나는 길 그대로, 호출자는 그 플러그인. 시트를 거치지 않는다.
    consoleControlFor: (pluginId) => ({
      request: async (input) => {
        consoleAgentOwners.add(pluginId);
        // 전달이 끝날 때까지 기다린다 — 결과는 남지 않는다. 멈춘 전달이 플러그인을 붙잡지 않게 시한을 둔다(전달 자체는 계속된다).
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("request_timeout")), 20_000); });
        try { return await Promise.race([consoleControl.request({ kind: "plugin", pluginId }, input), timeout]); }
        finally { clearTimeout(timer); }
      },
      observe: (operationId) => consoleControl.observe(operationId),
      subscribeTurnEnds: (listener) => consoleControl.subscribeTurnEnds({ kind: "plugin", pluginId }, listener),
      launchState: (input) => { consoleAgentOwners.add(pluginId); return consoleControl.launchKeyState({ kind: "plugin", pluginId }, input.theaterId, input.key); },
      reserveLaunchKeys: (input) => { consoleAgentOwners.add(pluginId); consoleControl.reserveLaunchKeys({ kind: "plugin", pluginId }, input.theaterId, input.keys); },
      launchKeyUsage: () => consoleControl.launchKeyUsage({ kind: "plugin", pluginId }),
      sleep: async (operationId, options) => {
        if (!operations.get(operationId)) return { ok: false, error: "unknown_operation" };
        const observation = consoleControl.observe(operationId);
        if (!observation || !sleepOperation) return { ok: false, error: "capability_unavailable" };
        if (observation.lifecycle === "dormant") return { ok: false, error: "already_dormant" };
        // 터미널의 답 대기와 백그라운드 작업은 interrupt 로 풀 수 없다 — 호출자가 종결을 결정했을 때만 그대로 재운다.
        const endsPendingWork = options?.endPendingWork === true && ((observation.surface === "terminal" && observation.activity === "awaiting") || observation.activity === "background");
        if (observation.activity !== "idle" && !endsPendingWork) return { ok: false, error: "not_idle" };
        return sleepOperation(operationId);
      },
      // 다음 기동 정책만 남긴다. 세션 스냅샷을 고치거나 떠 있는 프로세스를 중단하지 않는다.
      // 플러그인 operations.patch와 같은 영속 경로를 탄다. 저장소 patch만 호출하면 재시작 뒤 정책이 사라진다.
      setSubagentSpawn: (operationId, policy) => {
        if (policy !== "blocked" && policy !== "default") return;
        const node = operations.get(operationId);
        if (!node) return;
        const next = withSubagentSpawn(node.payload, policy);
        if (next === node.payload) return;
        pluginHostCapabilities.operations.patch(operationId, { payload: next });
      },
      // 서브에이전트 정책과 같은 영속 경로. 살아 있는 채팅은 이 값을 호출마다 읽는다.
      setUserQuestions: (operationId, policy) => {
        if (policy !== "blocked" && policy !== "default") return;
        const node = operations.get(operationId);
        if (!node) return;
        const next = withUserQuestions(node.payload, policy);
        if (next === node.payload) return;
        pluginHostCapabilities.operations.patch(operationId, { payload: next });
      },
      // 떠 있는 채팅의 모델·강도 — 채팅 화면의 메뉴와 같은 길. 적용되면 실행 호스트가 세션 좌표(payload)를 고친다.
      // 서브에이전트 호출의 거절 사유 — 플러그인마다 한 자리. 실행 기능의 hook 응답이 호출마다 읽는다.
      redirectAgentCalls: (reason) => {
        agentCallRedirects.set(pluginId, reason);
        return () => { if (agentCallRedirects.get(pluginId) === reason) agentCallRedirects.delete(pluginId); };
      },
      setCoordinates: (operationId, input) => consoleControl.coordinates({ kind: "plugin", pluginId }, operationId, input),
      coordinates: (operationId) => consoleControl.readCoordinates(operationId),
      // 전사 — 좌표 바꾸기와 같은 소유 규칙(이 플러그인이 띄운 Operation 이나 그 자식)을 Console 제어가 따진다.
      transcript: (operationId, input, signal) => consoleControl.transcript({ kind: "plugin", pluginId }, operationId, input, signal),
    }),
    createAgentHost: (pluginId) => {
      const agent = createPluginAgentHost({ baseUrl: () => { const origin = pluginHostCapabilities.server.origin(); return origin ? `${origin}/api/v1/ai-gateway` : null; }, consoleUse: consoleUse.forPlugin(pluginId), computerUseMcp, resolveExecutablePath: async () => {
        // 채팅과 같은 정책이다 — 설치된 Claude Code를 못 풀면 SDK 동봉본으로 폴백하지 않고 실패한다.
        const executable = await resolveClaudeExecutable?.();
        if (!executable) throw new Error("agent_cli_unavailable");
        return executable;
      } });
      consoleAgentOwners.add(pluginId);
      return { ...agent, dispose: async () => { consoleAgentOwners.delete(pluginId); await agent.dispose(); } };
    },
  });
  const pluginClientAssets = createPluginClientAssets({ plugins: pluginHost.plugins, skipped: pluginHost.skipped });
  async function resolveOperationCatalog(): Promise<{ readonly plugins: readonly OperationCatalogPlugin[] }> {
    const result: OperationCatalogPlugin[] = [{ id: "terminal", title: "Agent", kinds: await coreLaunchKinds() }];
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
  const lifecycle = deps.lifecycle ?? createConsoleServeLifecycle();
  const isReady = () => lifecycle.state() === "ready";
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
  const globalSettingsRouter = createGlobalSettingsRouter({
    computerUseAvailability: async (backend) => {
      const platform = computerUsePlatforms[backend];
      if (!platform.supported()) return "unsupported";
      return await platform.inspectInstallation() ? "available" : "missing";
    },
    consoleSettingsStore,
    isAuthorized: isTerminalAuthorized,
    isRemoteAccessOwner: isLoopbackListener,
    readJsonBody,
    writeJson,
    onThemeChanged: broadcastDesktopThemeChanged,
    onExperimentsChanged: async (next) => {
      await computerUse.setPlatform(computerUsePlatforms[next.computerUseBackend]);
      if (!next.computerUse) await computerUse.stop();
      for (const listener of experimentListeners) listener(next);
      // computerUse 실험 토글·백엔드는 listOperationUse 의 computer 배열을 바꾼다. 끄면 기다리던 허용 요청은
      // 브로커 순찰이 거둔다. 런치 주입은 다음 자식 런치부터 이 값을 따른다(computer-use/host/mcp.ts).
      scheduleOperationUseBroadcast();
    },
    onRemoteAccessChanged: (change) => reconcileRemoteAccess(change),
  });
  const desktopThemeRouter = createDesktopThemeRouter({
    getTheme: () => consoleSettingsStore.load().general?.theme ?? "instrument",
    getFonts: () => resolveConsoleFonts(consoleSettingsStore.load()),
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
  /**
   * 네이티브 브라우저 뷰 — 창을 든 셸이 스냅샷을 구독하고 결과를 relay 로 되돌린다. 테마·업데이트 동기화와 같은 방향이다.
   * 스크린샷이 relay 에 실리므로 그 몸은 일반 JSON 한도보다 크게 받는다.
   */
  const desktopBrowserRouter = createBrowserDesktopRouter({ desktopEngine, browserService, desktopBrowserSseSubscribers, isExactConsoleOrigin, shellOwnerOf, readJsonBody, writeJson, writeNoContent, withSecurityHeaders, encodeSseData });
  const desktopShellUpdateRouter = createDesktopShellUpdateRouter({
    getUpdate: (req) => {
      const owner = shellOwnerOf(req);
      return (owner === null ? undefined : desktopShellUpdatesByOwner.get(owner)) ?? emptyDesktopShellUpdate();
    },
    setUpdate: (req, snapshot) => {
      const owner = shellOwnerOf(req);
      if (owner === null) return;
      desktopShellUpdatesByOwner.set(owner, snapshot);
      broadcastDesktopShellUpdate(owner, snapshot);
    },
    getCommand: (req) => {
      const owner = shellOwnerOf(req);
      return owner === null ? emptyDesktopShellUpdateCommand() : readDesktopShellUpdateCommand(owner);
    },
    requestCommand: (req, command) => {
      const owner = shellOwnerOf(req);
      if (owner === null) return;
      publishDesktopShellUpdateCommand(owner, command);
    },
    isAuthorized: isExactConsoleOrigin,
    readJsonBody,
    subscribeCommand: (req, res, snapshot) => {
      const owner = shellOwnerOf(req);
      if (owner === null) { writeJson(res, 401, { error: "unauthorized" }); return; }
      openDesktopSse(res, DESKTOP_SHELL_UPDATE_COMMAND_EVENT, snapshot);
      desktopShellUpdateCommandSseSubscribers.set(res, owner);
      res.on("close", () => { desktopShellUpdateCommandSseSubscribers.delete(res); });
    },
    writeJson,
    writeNoContent: (res) => { res.writeHead(204, withSecurityHeaders({})); res.end(); },
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
      // 이 게시는 화면이 이미 물어본 뒤에 도착했을 수 있다(재기동·새로고침). 그 창에만 실어 보낸다.
      broadcastDesktopShellChanged(owner, snapshot);
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
  const desktopWindowCommandRouter = createDesktopWindowCommandRouter({
    isAuthorized: isExactConsoleOrigin,
    readJsonBody,
    requestCommand: (req, command) => {
      const owner = shellOwnerOf(req);
      if (owner === null) return;
      publishDesktopWindowCommand(owner, command);
    },
    subscribe: (req, res) => {
      const owner = shellOwnerOf(req);
      if (owner === null) { writeJson(res, 401, { error: "unauthorized" }); return; }
      openDesktopSse(res, DESKTOP_WINDOW_COMMAND_EVENT, { command: null });
      desktopWindowCommandSseSubscribers.set(res, owner);
      res.on("close", () => { desktopWindowCommandSseSubscribers.delete(res); });
    },
    writeJson,
    writeNoContent: (res) => { res.writeHead(204, withSecurityHeaders({})); res.end(); },
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
  const operationsRouter = createOperationsRouter({
    store: operations,
    isAuthorized: isTerminalAuthorized,
    readJsonBody,
    writeJson,
    persist: persistDurableState,
    deleteOperation: (operationId): DeferredDeletionReceipt | null => deletionCoordinator.deleteOperation(operationId),
    isPendingDeletion: (operationId) => deletionCoordinator.hasPendingOperation(operationId),
    getPluginSensitiveFields: (pluginId) => pluginId === null ? CORE_AGENT_SENSITIVE_FIELDS : [
      ...(pluginHost.sensitiveFieldsByPluginId.get(pluginId) ?? []),
      ...(pluginPayloadSanitizers.get(pluginId) ?? []),
    ],
    resolveLaunchCatalog: resolveOperationCatalog,
    publishRenameEvent: (event) => pluginHostCapabilities.events.publish(OPERATION_RENAMED_EVENT_CHANNEL, event),
    broadcastOperationChanged,
    broadcastGroupChanged,
    broadcastGroupRemoved,
    subscribeOperationSse: (req, res) => {
      const listener = listenerForRequest(req);
      const audience: AccessAudience = listener?.audience ?? "local";
      const sessionHandle = listener === null || listener.audience === "local"
        ? null
        : access.resolveSession(readSessionCookie(req.headers, listener.port), listener.audience)?.handle ?? null;
      if (audience === "remote" && sessionHandle === null) { writeJson(res, 401, { error: "unauthorized" }); return; }
      const shellOwner = audience === "local" ? "local" : sessionHandle;
      // 자기 Console을 여는 네이티브 뷰도 일반 Chrome UA를 쓴다. 현재 호스트가 소유한 뷰만 별도로 세어
      // 그 페이지가 자기 엔진을 shared로 닫지 않게 한다. 표식만 있거나 다른 호스트의 요청이면 인정하지 않는다.
      const viewId = req.headers[DESKTOP_BROWSER_VIEW_HEADER];
      const operationView = typeof viewId === "string" && shellOwner !== null
        && desktopEngine.currentHost === shellOwner && Boolean(desktopEngine.viewOwner(viewId));
      const subscriber: OperationSseSubscriber = { res, audience, sessionHandle, client: operationView ? "operation-browser" : clientKindOf(req) };
      res.writeHead(200, withSecurityHeaders({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      }));
      operationSseSubscribers.add(subscriber);
      startSseKeepaliveLifecycle(res, () => {
        if (operationSseSubscribers.delete(subscriber)) browserService.reconcile();
      }, (data) => writeOperationSse(subscriber, data));
      writeOperationSse(subscriber, ":connected\n\n");
      writeOperationSse(subscriber, encodeSseData(DESKTOP_FULLSCREEN_EVENT, desktopFullscreenSnapshot(desktopFullscreen)));
      // 붙기 전에 시작된 콘솔·컴퓨터 사용과 허용 요청은 이벤트로 다시 오지 않는다 — 지금 스냅샷을 실어 보낸다.
      // 재연결도 이 자리를 지나므로 끊긴 사이의 변경은 여기서 한 번에 맞춰진다.
      writeOperationSse(subscriber, encodeSseData(OPERATION_USE_STATE_EVENT, operationUseSnapshot()));
      // 셸이 이미 게시한 집이 있으면 붙는 순간 실어 보낸다 — 화면의 한 번뿐인 물음과 게시가 어느 순서로
      // 오든 창은 돌아갈 곳을 안다. 빈 답은 보내지 않는다: "아직 모른다"를 "집이 없다"로 굳히지 않기 위해서다.
      const publishedShell = shellOwner === null ? undefined : desktopShellsByOwner.get(shellOwner);
      if (publishedShell !== undefined) writeOperationSse(subscriber, encodeSseData(DESKTOP_SHELL_EVENT, publishedShell));
      const publishedShellUpdate = shellOwner === null ? undefined : desktopShellUpdatesByOwner.get(shellOwner);
      if (publishedShellUpdate !== undefined) writeOperationSse(subscriber, encodeSseData(DESKTOP_SHELL_UPDATE_EVENT, publishedShellUpdate));
      // 루프백은 붙는 순간 현재 보유자를 받는다 — 커튼은 세션이 열린 뒤에 새로고침한 화면에서도
      // 떠 있어야 하고, 이벤트만으로는 그 사이에 놓친 사실을 되찾을 수 없다.
      if (audience === "local") {
        writeOperationSse(subscriber, encodeSseData(CONTROL_CHANGED_EVENT, controlChangedSnapshot(currentControlHolder())));
      }
      // 브라우저·모바일 화면이 붙는 순간 Operation 브라우저는 멈춘다 — 떠나면 다시 열린다.
      if (!operationSseSubscribers.has(subscriber)) return;
      browserService.reconcile();
      // 붙기 전에 일어난 브라우저 변화는 이벤트로 다시 오지 않는다. 스트림이 끊겼다 다시 붙는 길도 이 자리를 지나므로,
      // 그 사이 에이전트가 연 탭이나 바뀐 주소가 화면에 영영 낡은 채로 남지 않는다.
      if (subscriber.client === "desktop" && subscriber.audience === "local") {
        writeOperationSse(subscriber, encodeSseData(COMPUTER_CAPTURE_STATE_EVENT, computerCaptureSnapshot()));
      }
      if (subscriber.client === "desktop") {
        for (const browsing of browserService.status().operations) writeOperationSse(subscriber, encodeSseData(BROWSER_STATE_EVENT, browserService.state(browsing)));
      }
    },
  });
  const operationArchiveRouter = createOperationArchiveRouter({ archive: operationArchive, isAuthorized: isTerminalAuthorized, readJsonBody, writeJson, sanitize: (node) => sanitizeArchiveOperation(node, true) });
  routeRegistry.register("/api/v1/operations", async (context) => await operationArchiveRouter(context) || operationsRouter(context));
  routeRegistry.register("/api/v1/theaters", async (context) => {
    return false;
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
  routeRegistry.register("/api/v1/desktop/computer-capture", async ({ req, res, pathname }) => {
    if (!isLoopbackListener(req)) { writeJson(res, 404, { error: "not_found" }); return true; }
    if (req.method === "GET" && pathname === "/api/v1/desktop/computer-capture") {
      await verifyComputerCapture();
      // Desktop main도 getDisplayMedia의 창 선택 때 읽는다 — 네이티브 식별자는 이 루프백 응답에만 둔다.
      writeJson(res, 200, { ...computerCaptureSnapshot(), target: computerUse.status().enabled ? computerCaptureTarget : null });
      return true;
    }
    writeJson(res, 405, { error: "method_not_allowed" });
    return true;
  });
  routeRegistry.register("/api/v1/operation-use", async ({ req, res }) => {
    if (req.method !== "GET") { writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    writeJson(res, 200, operationUseSnapshot());
    return true;
  });
  /** 요청한 클라이언트가 현재 제어 호스트의 Desktop 셸인지 판정한다. */
  function isDesktopHostClient(req: http.IncomingMessage): boolean {
    if (clientKindOf(req) !== "desktop") return false;
    const currentHost = desktopEngine.currentHost;
    if (!currentHost) return false;
    const listener = listenerForRequest(req);
    const audience: AccessAudience = listener?.audience ?? "local";
    const sessionHandle = listener === null || listener.audience === "local"
      ? null
      : access.resolveSession(readSessionCookie(req.headers, listener.port), listener.audience)?.handle ?? null;
    if (audience === "remote" && sessionHandle === null) return false;
    const shellOwner = audience === "local" ? "local" : sessionHandle;
    return shellOwner === currentHost;
  }
  /**
   * Operation 브라우저 API. 루프백과 원격 리스너 모두에서 열린다 — 원격 요청은 라우팅 전에 세션을 통과했고, 창을 든
   * Desktop 이 원격에서 건너와 이 콘솔의 탭을 자기 창에 그리는 길이 바로 이 경로다. 쓰기는 Origin 을 요구한다.
   */
  routeRegistry.register("/api/v1/browser", createBrowserRouter({ browserService, browserMcp, operations, isWriteAdmitted, isExactConsoleOrigin, isDesktopHostClient, writeJson, readJsonBody, readUrl, withSecurityHeaders }));
  routeRegistry.register("/api/v1/computer-use", createComputerUseRouter({ computerUse, computerUseInstaller, readBackend: () => readExperimentSettings(consoleSettingsStore).computerUseBackend, hasRemoteSession: () => access.hasSession("remote", "full") || access.hasSession("remote", "monitoring"), isLoopbackListener, isExactConsoleOrigin, writeJson }));
  routeRegistry.register("/api/v1/desktop", async (context) => {
    if (await desktopBrowserRouter(context)) return true;
    if (await desktopShellUpdateRouter(context)) return true;
    if (await desktopShellRouter(context)) return true;
    if (await desktopFullscreenRouter(context)) return true;
    if (await desktopWindowCommandRouter(context)) return true;
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
  function remoteRequestAdmission(listener: ListenerIdentity, req: http.IncomingMessage, pathname: string): { admitted: true; sessionHandle: string | null } | { admitted: false; reason?: ControlReclaimedReason } {
    // 세션 없이 지나는 경로는 이 하나뿐이다. 페어링은 전용 앱으로만 이루어지고 브라우저는
    // 자기서명 인증서의 지문을 대조할 수 없으므로, 브라우저를 향한 안내 표면을 두지 않는다.
    //
    // join은 어떤 세션에도 묶이지 않는다 — 들고 온 옛 세션 쿠키도 여기서 해석하지 않는다. 재합류는
    // 자기 페어링이 두고 간 옛 세션을 걷은 뒤 새 세션을 여는데, 이 요청이 옛 세션에 묶여 있으면
    // 그 세션을 닫는 종료 신호가 재합류 응답 자체를 파기한다. 페어링된 기기가 조용히 돌아오는 길이
    // 이 한 줄에 걸려 있다.
    if (pathname === "/api/v1/join") return { admitted: true, sessionHandle: null };
    const session = access.resolveSession(readSessionCookie(req.headers, listener.port), listener.audience);
    if (session !== null) {
      // monitoring 자격은 보기만 한다. 등급이 사고 후 범위를 좁히려면 여기서 실제로 막혀야 한다.
      return session.access !== "monitoring" || isReadOnlyRequest(req) ? { admitted: true, sessionHandle: session.handle } : { admitted: false };
    }
    // 세션이 없다는 것은 회수·대체·만료·재시작 중 하나다. 그 기기가 아직 들고 있는 페어링
    // 쿠키로 끝난 사유를 찾아 — handle·기기 이름·openedAt은 들여다보지 않는다. 페어링이 없거나
    // 사유가 없으면(재시작·유휴) 지금처럼 사유 없는 401이다.
    const paired = pairedDeviceStore.peek(readPairingCookie(req.headers, listener.port), listener.audience);
    const reason = paired === null ? null : access.lookupSessionEnd(paired.id);
    return reason === null ? { admitted: false } : { admitted: false, reason };
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
    if (listener && listener.audience !== "local") {
      const admission = remoteRequestAdmission(listener, req, pathname);
      if (!admission.admitted) {
        writeJson(res, 401, admission.reason === undefined ? { error: "unauthorized" } : { error: "unauthorized", reason: admission.reason });
        return;
      }
      // 입장시킨 세션에 이 응답을 묶는다. 그 세션이 끝나면 SSE든 진행 중 요청이든 함께 닫힌다.
      if (admission.sessionHandle !== null) {
        remoteRequestSessions.set(req, admission.sessionHandle);
        remoteSessionBindings.bindResponse(admission.sessionHandle, res);
        // 묶는 순간 세션이 이미 끝나 있었다면 응답은 파기됐다 — 라우팅하지 않는다.
        if (res.destroyed) return;
      }
    }
    // Host 게이트는 순서를 바꾸지 않는다 — Codex는 wildcard 바인드에서 더 넓은 host 집합을 쓰므로
    // 자기 게이트를 그대로 유지한다. 대신 같은 리스너 판정을 주입받아, 원격 리스너의 Host·Origin도
    // 그 게이트가 알고 있다.
    if (!isRequestHostAllowed(req)) {
      writeJson(res, 403, { error: "host_mismatch" });
      return;
    }
    // bind는 lock의 실제 endpoint를 정할 뿐이다. 소유권·복원·활성화가 끝나기 전에는 요청을 실행하지 않는다.
    // 정지 요청만 health와 함께 pre-ready에서도 받는다: startup 중 lock을 쥔 자식을 거두는 경로의 탈출구다.
    if (!isReady()) {
      if (pathname === "/api/v1/health") handleHealth(req, res);
      else if (pathname === CONSOLE_STOP_REQUEST_PATH) handleStopRequest(req, res);
      else writeJson(res, 503, { error: "console_starting" });
      return;
    }
    if (archiveStorage.blocked() && (pathname.startsWith("/api/") || pathname.startsWith("/mcp/")) && pathname !== "/api/v1/health" && pathname !== CONSOLE_STOP_REQUEST_PATH) {
      writeJson(res, 503, { error: "archive_recovery_required" });
      return;
    }
    if (pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(302, withSecurityHeaders({ Location: `/console/${readUrl(req).search}` }));
      res.end();
      return;
    }
    if (pathname.startsWith("/mcp/")) {
      if (listener?.audience !== "local") { writeJson(res, 404, { error: "not_found" }); return; }
      mcpHttp.handle(req, res);
      return;
    }
    if (pathname === PAIRING_IDENTITY_PATH) {
      handlePairingIdentity(req, res);
      return;
    }
    // 플러그인이 선언한 콘솔 경로는 정적 파일보다 먼저 본다 — 뒤에 두면 /console/* 요청이
    // SPA 문서로 먼저 답해져, 그 경로를 소유한 플러그인은 영영 호출되지 않는다.
    // 플러그인이 선언한 콘솔 경로는 정적 파일보다 먼저 본다 — 뒤에 두면 /console/* 요청이
    // SPA 문서로 먼저 답해져, 그 경로를 소유한 플러그인은 영영 호출되지 않는다.
    if (pathname.startsWith("/console/") && pathname !== "/console" && !pathname.startsWith("/console/assets/")) {
      runAsyncBooleanHandler(routeRegistry.handle({ req, res, pathname }), res, () => tryServeStaticConsole(req, res, pathname));
      return;
    }
    if (tryServeStaticConsole(req, res, pathname)) return;
    if (pathname === "/api/v1/health") {
      handleHealth(req, res);
      return;
    }
    if (pathname === CONSOLE_STOP_REQUEST_PATH) {
      handleStopRequest(req, res);
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
    if (pathname === "/api/v1/updates/check") {
      runAsyncHandler(handleUpdateCheck(req, res), res);
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
      if (!isReady()) {
        writeJson(res, 503, { error: "console_starting", pid: payload.pid, stopRequest: CONSOLE_STOP_REQUEST_REVISION });
        return;
      }
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
        lifecycleWire: CONSOLE_LIFECYCLE_WIRE,
        stopRequest: CONSOLE_STOP_REQUEST_REVISION,
      };
      writeJson(res, 200, body);
      return;
    }
    writeJson(res, 401, { error: "Unauthorized" });
  }

  /**
   * A token-authenticated stop request (docs/console-lifecycle-contract.md, "Stop ladder"): the Windows stop path that
   * runs cleanup instead of TerminateProcess. The gates mirror the read/update precedents — a remote listener never
   * sees this route (404), only POST stops (405), a browser Origin never stops (403), and only the lock token stops
   * (401). Like an accepted update's self-stop, the shutdown starts only after the 202 response is finished: a
   * connection lost before then stops nothing. Every accepted request joins the one shutdown.
   */
  function handleStopRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (listenerForRequest(req)?.audience !== "local") {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (req.headers.origin !== undefined) {
      writeJson(res, 403, { error: "forbidden" });
      return;
    }
    const handle = lockHandle;
    const token = handle?.payload.token;
    if (!handle || !token || req.headers.authorization !== `Bearer ${token}`) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const pid = handle.payload.pid;
    writeJson(res, 202, { accepted: true, pid });
    res.once("finish", () => {
      void lifecycle.requestStop("request").catch((error) => {
        console.warn(`[fleet-console] Stop request shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
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
  /**
   * 조인에는 두 갈래가 있다. 링크를 처음 쓰는 기기는 1회용 grant를 내밀고, 그 교환으로
   * 페어링이 생긴다. 이미 페어링된 기기는 아무것도 내밀지 않고 자기 쿠키만 들고 온다 —
   * 제어권을 회수당했든, 유휴로 끊겼든, 콘솔이 재시작했든, 돌아오는 길은 이 두 번째 갈래다.
   *
   * 페어링이 세션과 갈라져 있어야 그 길이 존재한다. 자격이 곧 세션이면 세션을 끊는 모든
   * 행위가 자격까지 지우고, 상대는 새 링크를 받기 전에는 돌아올 수 없다.
   */
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
  /**
   * 쓰기 허용 판정. 원격 리스너로 들어온 요청은 이미 세션을 통과했으므로 허용되고,
   * 로컬 리스너는 루프백에서 온 것만 허용한다.
   */
  function isWriteAdmitted(req: http.IncomingMessage): boolean {
    const listener = listenerForRequest(req);
    if (listener === null) return false;
    // Origin 판정도 여기서 끝낸다 — 허용 집합은 리스너마다 다르고, 플러그인이 그것을
    // 다시 짜면 원격 리스너로 들어온 쓰기가 자기 주소를 실었는데도 거절된다.
    if (listener.audience !== "local") return true;
    return isLoopbackRemoteAddress(req.socket.remoteAddress);
  }

  /**
   * 이 요청을 받은 리스너가 인정하는 Origin. 허용 집합은 리스너마다 다르고 그 사실은
   * 호스트만 안다 — 플러그인은 판정을 스스로 하되, 무엇과 대조할지는 여기서 받는다.
   */
  function expectedOriginFor(req: http.IncomingMessage): string | null {
    const listener = listenerForRequest(req);
    if (listener === null) return null;
    return `${listener.secure ? "https" : "http"}://${listenerAuthority(listener.host, listener.port, listener.secure)}`;
  }

  function resolveTerminalSocketRole(req: http.IncomingMessage): "control" | "viewer" {
    if (!isLoopbackListener(req)) return "control";
    return access.hasSession("remote", "full") ? "viewer" : "control";
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
    writeJson(res, 200, { version, routes: buildApiCatalog([...OPERATION_ARCHIVE_API_CATALOG, ...executionApiCatalog, ...pluginHost.apiCatalog]) });
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

  /** 플러그인이 등록한 플래그. 해석이 던지면 그 플래그만 빠진다 — 목록 전체를 잃지 않는다. */
  function resolveTheaterFlags(theaterId: string): Record<string, boolean> {
    const flags: Record<string, boolean> = {};
    for (const [flag, resolve] of pluginTheaterFlags) {
      try {
        flags[flag] = resolve(theaterId);
      } catch {
        // 소유 플러그인이 답하지 못하면 그 사실을 조용히 참으로 바꾸지 않는다.
      }
    }
    return flags;
  }

  function toTheaterInfo(theater: TheaterRegistration, hasWiki: boolean): ConsoleTheaterInfo {
    return {
      id: theater.id,
      label: theater.label,
      createdAt: theater.registeredAt,
      lastOpenedAt: theater.lastOpenedAt,
      ...(theater.order !== undefined ? { order: theater.order } : {}),
      ...resolveTheaterFlags(theater.id),
      hasWiki: resolveTheaterFlags(theater.id).hasWiki ?? hasWiki,
      activeAdmiralCount: operations.listByTheater(theater.id).filter((operation) => operation.pluginId === null && operation.type === "agent").length,
    };
  }

  /**
   * 지식 서버 상태는 그것을 소유한 플러그인이 말한다. 소유자가 없으면 "unknown"이다 —
   * 코어가 대신 "unavailable"이라고 답하면, 아무도 모른다는 사실이 없다는 주장으로 바뀐다.
   */
  function resolveWikiServerStatus(theaterId: string | null): ConsoleObserverStatus["wikiServerStatus"] {
    if (!theaterId) return "unknown";
    if (!theaters.get(theaterId)) return "unknown";
    const resolve = pluginTheaterFlags.get("hasWiki");
    if (!resolve) return "unknown";
    try {
      return resolve(theaterId) ? "available" : "unavailable";
    } catch {
      return "unknown";
    }
  }

  /** An accepted update stops this Console from inside: the same stop request a signal makes, with the same deadline. */
  async function stopAfterAcceptedUpdateApply(): Promise<void> {
    try {
      await lifecycle.requestStop("update");
    } catch (error) {
      console.warn(`[fleet-console] Update apply shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function cleanupAfterFailedStart(): Promise<void> {
    operationArchive.dispose();
    deletionCoordinator.dispose();
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
    // The single shutdown and a failed start each run this once and release the lock at its end; nothing else releases it.
    if (consoleResourcesDisposed) return;
    consoleResourcesDisposed = true;
    // 원격 리스너를 남겨 두면 콘솔이 내려간 뒤에도 포트가 열려 있는 것처럼 보인다.
    const closingRemote = remoteServer;
    remoteServer = null;
    remoteFingerprint = null;
    listeners = [];
    boundPort = null;
    access.revokeAllSessions();
    await closeHttpServer(closingRemote);
    // SDK는 동기 cleanup도 허용한다 — async 래퍼가 동기 throw를 그 cleanup 하나의 reject로 바꿔, 나머지 정리와 lock 해제를 막지 않는다.
    const cleanupResults = await Promise.allSettled([...pluginCleanupCallbacks].map(async (cleanup) => cleanup()));
    for (const result of cleanupResults) {
      if (result.status === "rejected") {
        console.warn(`[fleet-console] Plugin cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
    // 플러그인 cleanup 이후 살아 있는 플러그인 그룹을 정리한다. 같은 정지 단계는 owner와 무관하게
    // 종료된 리더의 잔여도 grace 뒤 거둔다. 살아 있는 에이전트는 flush를 위해 계속 SDK close에 맡긴다.
    ownedProcesses.beginStop((group) => group.owner?.startsWith("plugin:") === true, OWNED_GROUP_TERM_GRACE_MS, {
      onProcessTableUnavailable: (error) => recordFailure("shutdown_process_table_unavailable", error),
    });
    for (const cleanup of [...executionCleanupCallbacks].reverse()) {
      try { await cleanup(); } catch (error) { console.warn("[fleet-console] Execution cleanup failed:", error); }
    }
    executionCleanupCallbacks.clear();
    await pluginHost.cleanup();
    consoleControl.dispose();
    useRequests.dispose();
    try { await Promise.all([computerUseMcp.dispose(), browserMcp.dispose(), consoleUse.dispose(), pluginMcp.dispose()]); } finally { await mcpHttp.dispose(); }
    pluginCleanupCallbacks.clear();
    pluginEventListeners.clear();
    currentLock?.release();
  }

  /**
   * durable Theater들을 플러그인에게 알린다.
   *
   * 가장 최근에 연 Theater를 마지막에 알린다 — 이 순서를 재현해야 재시작 뒤에도
   * "마지막에 보던 것"이 그대로 앞에 선다.
   */
  function announceRestoredTheaters(): void {
    const ordered = [...theaters.list()].sort((left, right) =>
      String(left.lastOpenedAt ?? "").localeCompare(String(right.lastOpenedAt ?? "")));
    for (const theater of ordered) publishTheaterLifecycle("restored", theater.id);
  }

  async function rehydrateDurableState(): Promise<void> {
    const loadedVersion = readDurableStateVersion(durablePaths.stateFile);
    // 이동 저널·버전·손상은 빈 Console로 숨기지 않는다. 공개·실행 전에 쌍 파일을 복구한다.
    const state = archiveStorage.load();
    theaters.restore(state.theaters);
    operations.replace(state.operations);
    operations.replaceGroups(state.groups ?? []);
    deletionCoordinator.load(state.deletionTombstones ?? []);
    // 지원하는 구버전을 실제로 복원한 경우에만 sanitizer의 단계형 이주를 현재 버전으로 확정한다.
    // 알 수 없는 버전이나 복원 실패를 빈 v4 상태로 덮으면 재시도할 원본 자체를 잃는다.
    if (loadedVersion !== null && loadedVersion < STATE_VERSION) {
      try { fs.copyFileSync(durablePaths.stateFile, `${durablePaths.stateFile}.pre-archive-backup`, fs.constants.COPYFILE_EXCL); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (loadedVersion === 3) backupDurableStateV3(durablePaths.stateFile);
      if (loadedVersion === 4) backupDurableStateV4(durablePaths.stateFile);
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
  }

  function migrateLegacyCaptureState(): void {
    migrateLegacyCaptures({
      consoleDataDir: durablePaths.dir,
      operations,
      // 삭제 유예 중인 Operation은 live store에 없으므로 tombstone에서 flatten해 넘긴다.
      tombstonedOperations: deletionCoordinator.list().flatMap(deletionOperations),
      save: () => saveDurableState(deletionCoordinator.list()),
    });
  }


  // patch 브로드캐스트 게이트가 쓰는 "브라우저가 보는 모양" — broadcastOperationChanged와 같은
  // 새니타이즈 규칙을 공유해야 민감 필드 전용 patch가 조용히 남는다. ts는 모든 patch가 건드리는
  // 축이라 비교에서 뺀다 — 남기면 게이트가 항상 열려 게이트가 아니게 된다.
  function sanitizedOperationJson(node: OperationNode): string {
    const sensitiveFields = node.pluginId === null ? CORE_AGENT_SENSITIVE_FIELDS : [
      ...(pluginHost.sensitiveFieldsByPluginId.get(node.pluginId) ?? []),
      ...(pluginPayloadSanitizers.get(node.pluginId) ?? []),
    ];
    const { ts: _ts, ...rest } = createSanitizedOpDto(node, { sensitiveFields });
    return JSON.stringify(rest);
  }
  /** `operation:launch-changed` 게이트가 비교하는 모양 — 자식 세션이면 부모의 childSessions 안 그 자식의 payload 를 읽는다. */
  function launchJson(id: string): string | null {
    const payload = operations.getChild(id)?.child.payload ?? operations.get(id)?.payload;
    return payload ? JSON.stringify(readOperationLaunch(payload)) : null;
  }

  /**
   * Operation 사용 스냅샷 — /api/v1/operation-use 응답과 같은 모양. 콘솔·컴퓨터·브라우저 사용, 패널 안 허용
   * 요청, 「이번 작업만」 허가를 한 번에 싣는다. 도구 이름·사유·시한뿐이라 경로·인자 같은 민감 정보는 없다.
   * 원천(consoleUseActivity, ComputerUseService.owner, browserService, useRequests)이 바뀔 때마다
   * scheduleOperationUseBroadcast 로 이 스냅샷을 operations SSE 로 밀어 내보낸다.
   */
  const OPERATION_USE_STATE_EVENT = "operation-use:state";
  let operationUseBroadcastQueued = false;
  let lastOperationUseSnapshot: string | null = null;

  function operationUseSnapshot() {
    const using = listOperationUse();
    const live = new Set(operations.list().flatMap((operation) => [operation.id, ...(operation.childSessions ?? []).map((child) => child.id)]));
    const { requests, grants } = useRequests.list();
    return {
      console: using.console,
      computer: using.computer ? [using.computer] : [],
      browser: using.browser,
      requests: requests.filter((request) => live.has(request.operationId)),
      grants: { console: grants.console.filter((id) => live.has(id)), computer: grants.computer.filter((id) => live.has(id)) },
    };
  }

  /** 한 틱에 몰린 원천 변화(턴 종료 → settle·revoke·operation:changed 등)를 스냅샷 한 번으로 합친다. */
  function scheduleOperationUseBroadcast(): void {
    if (operationUseBroadcastQueued) return;
    operationUseBroadcastQueued = true;
    queueMicrotask(() => {
      operationUseBroadcastQueued = false;
      broadcastOperationUse();
    });
  }

  function broadcastOperationUse(): void {
    if (operationSseSubscribers.size === 0) { lastOperationUseSnapshot = null; return; }
    const snapshot = operationUseSnapshot();
    const encoded = JSON.stringify(snapshot);
    // 바뀌지 않은 사실은 내보내지 않는다 — broadcastOperationChanged 처럼 광범위하게 걸린 원천에서도
    // 실제로 operation-use 스냅샷이 달라진 경우에만 프레임이 나간다.
    if (encoded === lastOperationUseSnapshot) return;
    lastOperationUseSnapshot = encoded;
    const data = encodeSseData(OPERATION_USE_STATE_EVENT, snapshot);
    for (const subscriber of operationSseSubscribers) writeOperationSse(subscriber, data);
  }

  function writeOperationSse(subscriber: OperationSseSubscriber, data: string): void {
    // sweep 사이에도 만료된 세션에 프레임을 보내지 않는다. 초기 상태·heartbeat도 같은 문을 탄다.
    // resolveSession은 idle 수명을 늘리므로 쓰지 않는다. prune이 이 구독을 제거했는지 다시 본다.
    if (subscriber.audience === "remote") access.prune();
    if (!operationSseSubscribers.has(subscriber)) return;
    subscriber.res.write(data);
  }

  /** 그룹 사건 — 이름·색·순서뿐이라 민감 필드가 없다. 원격 세션에도 그대로 흐른다. */
  function broadcastGroupChanged(group: { readonly id: string; readonly name: string; readonly color: string; readonly order: number; readonly theaterId: string; readonly createdAt: number }): void {
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData("group:changed", { group });
    for (const subscriber of operationSseSubscribers) writeOperationSse(subscriber, data);
  }
  function broadcastGroupRemoved(groupId: string, theaterId: string): void {
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData("group:removed", { groupId, theaterId });
    for (const subscriber of operationSseSubscribers) writeOperationSse(subscriber, data);
  }
  function broadcastOperationRemoved(operationId: string): void {
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData(OPERATION_REMOVED_SSE_EVENT, { operationId });
    for (const subscriber of operationSseSubscribers) writeOperationSse(subscriber, data);
    scheduleOperationUseBroadcast();
  }
  function broadcastOperationChanged(node: OperationNode): void {
    if (operationSseSubscribers.size === 0) return;
    const sensitiveFields = node.pluginId === null ? CORE_AGENT_SENSITIVE_FIELDS : [
      ...(pluginHost.sensitiveFieldsByPluginId.get(node.pluginId) ?? []),
      ...(pluginPayloadSanitizers.get(node.pluginId) ?? []),
    ];
    const sanitized = createSanitizedOpDto(node, { sensitiveFields });
    const data = encodeSseData("operation:changed", { operation: sanitized });
    for (const subscriber of operationSseSubscribers) {
      writeOperationSse(subscriber, data);
    }
    // payload(consoleUse)·childSessions·live 목록이 바뀌면 operation-use 스냅샷도 바뀐다 — 제목만 바뀐 patch 는 스킵이 흡수한다.
    scheduleOperationUseBroadcast();
  }

  /**
   * 이벤트는 힌트다 — 변한 범위만 싣고 내용은 싣지 않는다. 원격 세션도 이 채널을 받으므로
   * 경로·본문이 실리면 안 되고, workspaceId(12-hex 해시)와 범위 이름만 나간다.
   */


  function broadcastUpdateAvailable(): void {
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData("update:available", {});
    for (const subscriber of operationSseSubscribers) {
      writeOperationSse(subscriber, data);
    }
  }

  function computerCaptureSnapshot() {
    const target = computerUse.status().enabled ? computerCaptureTarget : null;
    const unavailableOwner = computerUse.captureUnavailableOwner();
    return {
      target: target ? { id: target.id, operationId: target.operationId, title: target.title } : null,
      unavailableOperationId: unavailableOwner ? computerUseMcp.operationIdForOwner(unavailableOwner) : null,
    };
  }

  function broadcastComputerCapture(): void {
    const snapshot = computerCaptureSnapshot();
    const encoded = JSON.stringify(snapshot);
    if (encoded === lastComputerCaptureSnapshot) return;
    lastComputerCaptureSnapshot = encoded;
    const data = encodeSseData(COMPUTER_CAPTURE_STATE_EVENT, snapshot);
    // Computer Use는 로컬 기계만 조작한다. 원격 Desktop의 셸 소유자에게 로컬 창을 넘기지 않는다.
    for (const subscriber of operationSseSubscribers) {
      if (subscriber.client === "desktop" && subscriber.audience === "local") writeOperationSse(subscriber, data);
    }
  }

  let computerCaptureVerification: Promise<void> | null = null;

  async function verifyComputerCapture(): Promise<void> {
    const candidate = computerCaptureTarget;
    if (!candidate) return;
    // 감시와 GET은 진행 중인 검증을 공유한다. 늦은 결과도 같은 대상의 명시적 false일 때만 해제한다.
    const verification = computerCaptureVerification ??= computerUse.verifyCaptureTarget(candidate)
      .then((valid) => {
        if (valid === false && computerCaptureTarget?.id === candidate.id) {
          computerCaptureTarget = null;
          broadcastComputerCapture();
          watchComputerCapture();
        }
      })
      .catch(() => undefined)
      .finally(() => { computerCaptureVerification = null; });
    // 3초는 응답 대기 한도일 뿐 창 소멸의 증거가 아니다. 시간 초과에는 대상과 감시를 유지한다.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      verification,
      new Promise<void>((resolve) => { timeout = setTimeout(resolve, 3000); timeout.unref(); }),
    ]).finally(() => { if (timeout) clearTimeout(timeout); });
  }

  /** 네이티브 창 소멸은 도구 호출 없이도 일어난다. 기존 700ms 검증은 활성 대상에만 남기고 유휴에는 멈춘다. */
  function watchComputerCapture(): void {
    if (!computerCaptureTarget) {
      if (computerCaptureWatch) clearTimeout(computerCaptureWatch);
      computerCaptureWatch = null;
      return;
    }
    // 같은 창의 연속 관찰이 소멸 확인 시점을 계속 뒤로 미루지 않게 한다.
    if (computerCaptureWatch) return;
    const timer = setTimeout(() => {
      void verifyComputerCapture().finally(() => {
        if (computerCaptureWatch !== timer) return;
        computerCaptureWatch = null;
        watchComputerCapture();
      });
    }, 700);
    computerCaptureWatch = timer;
    timer.unref();
  }

  /** 집 주소는 게시한 창에만 돌아간다 — 다른 사람의 화면에서는 그 사람의 기계를 가리키기 때문이다. */
  function broadcastDesktopShellChanged(owner: string | "local", snapshot: DesktopShellSnapshot): void {
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData(DESKTOP_SHELL_EVENT, snapshot.homeOrigin === null ? emptyDesktopShell() : snapshot);
    for (const subscriber of operationSseSubscribers) {
      const subscriberOwner = subscriber.audience === "local" ? "local" : subscriber.sessionHandle;
      if (subscriberOwner === owner) writeOperationSse(subscriber, data);
    }
  }

  function broadcastDesktopFullscreenChanged(): void {
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData(DESKTOP_FULLSCREEN_EVENT, desktopFullscreenSnapshot(desktopFullscreen));
    for (const subscriber of operationSseSubscribers) writeOperationSse(subscriber, data);
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
    if (access.hasSession("remote", "full") || access.hasSession("remote", "monitoring")) computerUse.stopDetached();
    // 제어 보유자가 곧 브라우저 뷰를 그릴 창이다 — 바뀌면 옛 창의 탭은 닫히고 새 창이 이어받는다.
    browserService.reconcile();
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
      writeOperationSse(subscriber, data);
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
      try {
        // 명시적 회수 안내만 이미 무효인 세션에 보낸다. 만료는 프레임 없이 끝난다.
        if (data !== null) subscriber.res.write(data);
        subscriber.res.end();
      } catch (error) {
        try { subscriber.res.destroy(); } catch (failure) { recordFailure("session_stream_destroy_failed", failure); }
        recordFailure("session_stream_close_failed", error);
      }
    }
  }

  /**
   * Operation 브라우저를 열 수 있는가. 브라우저 탭·모바일 화면이 하나라도 붙어 있으면 멈춘다 — 그 화면에는 뷰가 없어
   * 에이전트의 조작을 사람이 볼 수 없다. 뷰를 그릴 셸은 제어를 쥔 쪽이다: 원격 full 세션이 있으면 그 창, 아니면 이 기계의 창.
   */
  function browserAvailability(): BrowserAvailability {
    const holder = currentControlHolder();
    const host = holder ? holder.handle : "local";
    for (const subscriber of operationSseSubscribers) if (subscriber.client === "browser") return { available: false, reason: "shared", host };
    return { available: true, reason: null, host };
  }

  function broadcastDesktopThemeChanged(theme: ConsoleThemeId): void {
    if (desktopThemeSseSubscribers.size === 0) return;
    settleRemoteExpiry();
    const data = encodeSseData(DESKTOP_THEME_EVENT, desktopThemeSnapshot(theme, resolveConsoleFonts(consoleSettingsStore.load())));
    for (const res of desktopThemeSseSubscribers) {
      if (!res.destroyed) res.write(data);
    }
  }

  /**
   * 원격 구독자가 섞일 수 있는 방송 앞에서 만료를 지금 시각으로 판정한다. 레지스트리의 만료 시계는
   * 기기가 잠들었다 깨면 늦게 울린다 — 그 사이 끝난 세션에 프레임이 나가지 않게, 만료된 세션의
   * 연결은 이 자리에서 종료 신호로 먼저 파기된다(그래서 아래 루프는 파기된 응답을 건너뛴다).
   * prune은 유휴 수명을 늘리지 않는다. 서버가 내보내는 이벤트는 사람의 활동이 아니다.
   */
  function settleRemoteExpiry(): void {
    access.prune();
  }

  function openDesktopSse(res: http.ServerResponse, event: string, snapshot: unknown): void {
    res.writeHead(200, withSecurityHeaders({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    }));
    res.write(":connected\n\n");
    res.write(encodeSseData(event, snapshot));
  }

  function broadcastDesktopShellUpdate(owner: string | "local", snapshot: DesktopShellUpdateSnapshot): void {
    if (operationSseSubscribers.size === 0) return;
    const data = encodeSseData(DESKTOP_SHELL_UPDATE_EVENT, snapshot);
    for (const subscriber of operationSseSubscribers) {
      const subscriberOwner = subscriber.audience === "local" ? "local" : subscriber.sessionHandle;
      if (subscriberOwner === owner) writeOperationSse(subscriber, data);
    }
  }

  /**
   * 한 셸 주인이 남긴 것을 한꺼번에 잊는다 — 게시한 집 주소, 그 셸의 갱신 상태, 걸어 둔 갱신 명령.
   * 세션 회수·페어링 회수·축출·원격 중지가 모두 이 문을 지나므로 셋이 갈라질 수 없다.
   */
  function forgetShellOwner(owner: string | "local"): void {
    desktopShellsByOwner.delete(owner);
    desktopShellUpdatesByOwner.delete(owner);
    desktopShellUpdateCommandsByOwner.delete(owner);
  }

  function readDesktopShellUpdateCommand(owner: string | "local"): DesktopShellUpdateCommandSnapshot {
    const pending = desktopShellUpdateCommandsByOwner.get(owner);
    if (pending === undefined) return emptyDesktopShellUpdateCommand();
    if (Date.now() - pending.at <= DESKTOP_UPDATE_REQUEST_TTL_MS) return pending.snapshot;
    desktopShellUpdateCommandsByOwner.delete(owner);
    return emptyDesktopShellUpdateCommand();
  }

  function publishDesktopShellUpdateCommand(owner: string | "local", command: DesktopShellUpdateCommandKind): void {
    const snapshot: DesktopShellUpdateCommandSnapshot = { command, commandId: `${Date.now()}-${crypto.randomUUID()}` };
    desktopShellUpdateCommandsByOwner.set(owner, { snapshot, at: Date.now() });
    if (desktopShellUpdateCommandSseSubscribers.size === 0) return;
    settleRemoteExpiry();
    const data = encodeSseData(DESKTOP_SHELL_UPDATE_COMMAND_EVENT, snapshot);
    for (const [res, subscriber] of desktopShellUpdateCommandSseSubscribers) {
      if (subscriber === owner && !res.destroyed) res.write(data);
    }
  }

  function publishDesktopWindowCommand(owner: string | "local", command: DesktopWindowCommand): void {
    if (desktopWindowCommandSseSubscribers.size === 0) return;
    settleRemoteExpiry();
    const data = encodeSseData(DESKTOP_WINDOW_COMMAND_EVENT, { command });
    for (const [res, subscriber] of desktopWindowCommandSseSubscribers) {
      if (subscriber === owner && !res.destroyed) res.write(data);
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
    settleRemoteExpiry();
    const data = encodeSseData(DESKTOP_UPDATE_EVENT, snapshot);
    for (const res of desktopUpdateSseSubscribers) {
      if (!res.destroyed) res.write(data);
    }
  }

  function persistDurableState(): void {
    try {
      saveDurableState(deletionCoordinator.list());
    } catch (error) {
      console.warn(`[fleet-console] Durable state save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function snapshotDurableState(deletionTombstones: ReturnType<typeof deletionCoordinator.list>): DurableConsoleState {
    return { version: STATE_VERSION, theaters: theaters.list(), operations: operations.list(), groups: operations.listAllGroups(), deletionTombstones };
  }

  function saveDurableState(deletionTombstones: ReturnType<typeof deletionCoordinator.list>, archives = archiveStorage.entries()): void {
    const nextIds = new Set(deletionTombstones.map((item) => item.deletionId));
    const present = new Set([...operations.list().map((node) => node.id), ...archives.map((entry) => entry.operation.id)]);
    const purged = deletionCoordinator.list().filter((item) => !nextIds.has(item.deletionId))
      .flatMap(deletionOperations).filter((node) => !present.has(node.id));
    const previousRevision = archiveStorage.revision();
    archiveStorage.save(snapshotDurableState(deletionTombstones), archives, purged.map((node) => archiveEvent("operation:purged", node)));
    if (archiveStorage.revision() !== previousRevision) publishArchiveChanged();
  }

  function sanitizeArchiveOperation(node: OperationNode, includeSessionNames = false): OperationNode {
    const sensitiveFields = node.pluginId === null ? CORE_AGENT_SENSITIVE_FIELDS : [
      ...(pluginHost.sensitiveFieldsByPluginId.get(node.pluginId) ?? []), ...(pluginPayloadSanitizers.get(node.pluginId) ?? []),
    ];
    return createSanitizedOpDto(node, { sensitiveFields, includeSessionNames });
  }

  function publishArchiveChanged(): void {
    const totalsByTheater: Record<string, number> = {};
    for (const entry of archiveStorage.entries()) totalsByTheater[entry.operation.theaterId] = (totalsByTheater[entry.operation.theaterId] ?? 0) + 1;
    publishPluginEvent("operation:archive-changed", { revision: operationArchive.revision(), total: archiveStorage.entries().length, totalsByTheater });
    publishPluginEvent("operation:cluster-changed", { removedIds: [...pendingClusterRemoved], operations: operations.list().map((node) => sanitizeArchiveOperation(node)) });
    pendingClusterRemoved.clear();
    // 보관·복원은 live 목록을 통째로 바꾼다 — 그 Operation 에 걸린 요청·허가의 필터가 여기서 다시 맞춰진다.
    scheduleOperationUseBroadcast();
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
    operationArchive.dispose();
    deletionCoordinator.dispose();
    computerCaptureTarget = null;
    watchComputerCapture();
    // 입력 제어는 HTTP·플러그인 정리에 막히기 전에 회수하고 신규 호출도 닫는다.
    const stoppingComputerUse = computerUseMcp.dispose();
    const stoppingBrowser = browserMcp.dispose();
    try {
      await Promise.all([
        stoppingComputerUse,
        stoppingBrowser,
        closeHttpServer(current),
        closeHttpServer(currentLoopback),
      ]);
    } finally {
      await disposeConsoleResources(currentLock);
    }
  }
  lifecycle.setShutdown(stopServer);

  const { handleTheaterFoldersList, handleTheaterFolderGrants, handleObserverTheaters, handleObserverTheaterItem, handleDeferredDeletionRestore } = createWorkspaceRoutes({ theaters, folderGrants, deletionCoordinator, isTerminalAuthorized, readJsonBody, writeJson, listTheaterInfos, toTheaterInfo, publishTheaterLifecycle, persistDurableState, migrateLegacyCaptureState });

  const { handleObserverReleaseNotes, handleUpdateProgress, handleUpdateCheck, handleUpdateApply } = createUpdatesRoutes({ releaseNotes, updateCheck, updateApply, durablePaths, release, version, channel, isExactConsoleOrigin, isLoopbackListener, readJsonBody, writeJson, readUrl, currentRuntime: () => ({ lockHandle, activeEndpoint, activeLockFile }), publishDesktopUpdateRequest, stopAfterAcceptedUpdateApply });

  const { handleAccessJoin } = createPairingRoutes({ access, pairedDeviceStore, remoteJoinGuard, listenerForRequest, readJsonBody, writeJson, withSecurityHeaders, broadcastControlChanged });

  const { handleRemoteAccessStatus, handleAccessLinkRevoke, handleAccessSessionRevoke, handlePairedDeviceRevoke, handleRemoteIdentityRotation, handleAccessLinkIssue } = createRemoteAdminRoutes({ access, pairedDeviceStore, remoteJoinGuard, remoteIdentityStore, remoteEndpointStore, consoleSettingsStore, readListenerState: () => ({ listeners, remoteFingerprint, remoteLastError }), isLoopbackListener, isAccessAdminAuthorized, writeJson, withSecurityHeaders, broadcastControlChanged, reconcileRemoteIdentity, consoleLabel });

  const { handleRemoteHosts, handleLocalConsoles, handleRemoteHostHandoff } = createRemoteHostsRoutes({ remoteHostStore, readListeners: () => listeners, listLocalConsoles, isLoopbackListener, isRemoteHostWriteAuthorized, readJsonBody, writeJson, writeNoContent });

  const returnedServer: ConsoleServer = {
    host,
    port,
    async start(lockPaths) {
      if (isReady() && lockHandle) return lockHandle.payload.endpoint;
      return lifecycle.startup(() => startConsole(lockPaths));
    },
    stop() {
      return lifecycle.requestStop("api");
    },
  };

  async function startConsole(lockPaths: { readonly dir: string; readonly lockFile: string }): Promise<string> {
    try {
      const result = await listenConsolePort(resolveConsolePortListenPlan());
      server = result.srv;
      loopbackServer = result.localLoopbackServer;
      portState = result.portState;
      // 실제 포트만 먼저 확보한다. 패자는 제품 상태를 읽어 복원하거나 플러그인을 실행하기 전에 끝난다.
      lockHandle = await lock.acquireLock({ dir: lockPaths.dir, lockFile: lockPaths.lockFile, pid: process.pid, port: result.actualPort, endpoint: result.endpoint, version, ...(desktop ? { owner: desktop.owner } : {}) });
      lifecycle.lockAcquired(lockHandle.payload);
      // Earlier instances' exit records are pruned only by the lock owner, after it took the lock (I3).
      pruneConsoleExitRecords(lockPaths.lockFile);
      activeLockFile = lockPaths.lockFile;
      activeEndpoint = result.endpoint;
      // 워크스페이스 승계·옛 렌더 트리 회수·설정 기본값 확정도 durable writer의 일이다.
      adoptLegacyWorkspaces(fleetDataDir, durablePaths.dir);
      reclaimLegacyTrees(fleetDataDir, durablePaths.dir);
      consoleSettingsStore.load();
      await rehydrateDurableState();
      // 플러그인은 기동에 한 번만 zip으로 묶는다 — 세션마다 같은 내용이다. 내주는 자리는 MCP와
      // 같은 루프백 전용 불투명 경로이고, 리스너가 뜬 뒤에야 주소가 정해지므로 런치가 그때 묻는다.
      const agentCliPlugin = renderConsoleAgentCliPlugin({ transport: mcpHttp.transport });
      // launch 프롬프트 파일은 이 lock 도메인의 자리에 둔다. 지난 프로세스가 남긴 것의 회수는 lock을 쓴 뒤에만 한다.
      const launchPromptDirectories = createLaunchPromptNamespace({ lockFile: lockPaths.lockFile });
      const execution = await startConsoleExecution(createConsoleRuntimeContext({
        consoleControl,
        agentCallRedirect: (operationId) => {
          for (const reason of agentCallRedirects.values()) {
            const answer = reason(operationId);
            if (answer !== null) return answer;
          }
          return null;
        },
        host: { ...pluginHostCapabilities, computerUseMcp, browserMcp, useRequests, requestLifetime, lifecycle: { registerCleanup: (cleanup) => { executionCleanupCallbacks.add(cleanup); return () => executionCleanupCallbacks.delete(cleanup); } } },
        dataDir: durablePaths.dir,
        recordFailure,
        legacyDataDir: path.join(durablePaths.dir, "plugins", "terminal"),
        agentOptions,
        agentCliPlugin,
        launchPromptDirectories,
        spawnAgentProcess: createAgentProcessSpawner(ownedProcesses, recordFailure),
        routes: routeRegistry, upgrades: upgradeRegistry, catalog: executionApiCatalog,
      }), consoleActions, pluginHostCapabilities.storage, theaterSystemPrompts);
      coreLaunchKinds = execution.launchKinds;
      ensureClaudeNativeModels = execution.ensureClaudeNativeModels;
      resolveClaudeExecutable = execution.resolveClaudeExecutable;
      sleepOperation = execution.actions.sleep;
      resumeArchivedOperation = execution.actions.resume;
      stopForArchive = execution.stopForArchive;
      purgeCoreOperation = execution.purgeOperation;
      consoleUse.activate({ ...consoleActions, ...execution.actions });
      await pluginHost.boot();
      // 플러그인이 붙은 뒤에 복원 사실을 알린다 — 부팅 순서상 이보다 앞서 알리면
      // 아직 구독하지 않은 플러그인이 그 Theater들을 영영 못 본다.
      announceRestoredTheaters();
      operationArchive.flushEvents();
      deletionCoordinator.sweepExpired();
      await pluginClientAssets.prepare();
      // 지난 프로세스의 잔재 회수는 lock 소유자만 한다 — lock을 쓰기 전에 지우면 lock에서 질 프로세스가
      // 서비스 중인 Console의 파일을 지운다.
      launchPromptDirectories.reclaimLeftovers();
      execution.reclaimAttachmentLeftovers();
      // 인증서·페어링·공표 endpoint를 쓰는 원격 활성화는 lock 소유자만 한다.
      await startRemoteAccessGuarded(result.actualPort);
      lifecycle.activated();
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
  }

  /**
   * 업데이트가 방금 이 콘솔을 갈아 끼웠다면, 열려 있던 화면은 옛 주소를 계속 두드리고 있다.
   * 그 주소를 되찾는 것이 "같은 자리로 돌아온다"는 약속의 전부다.
   *
   * 다만 이것은 **바인드할 포트**일 뿐, 사용자가 요청한 포트가 아니다. 보고되는 portMode와
   * requestedPort를 건드리면 설정 화면이 "요청한 포트를 쓰지 못했습니다"라고 말하게 되는데,
   * 사용자는 그런 포트를 요청한 적이 없다. 그리고 사용자가 고정 포트를 지정해 두었다면
   * 그쪽이 이긴다 — 명시된 설정이 복귀 편의보다 앞선다. 옛 포트를 이미 누가 쥐고 있으면
   * 새 포트로 뜬다 — 복귀는 편의일 뿐이고, 업데이트 뒤 콘솔이 아예 못 뜨는 것보다 낫다.
   */
  function resolveConsolePortListenPlan(): ConsolePortListenPlan {
    const plan = resolveConfiguredConsolePortListenPlan();
    if (resumePort === null || plan.portMode !== "dynamic") return plan;
    return { ...plan, port: resumePort, fallback: "resume" };
  }

  function resolveConfiguredConsolePortListenPlan(): ConsolePortListenPlan {
    if (deps.port !== undefined) {
      return {
        port,
        requestedPort: null,
        portMode: "dynamic",
        fallback: "none",
      };
    }
    if (channel === "local") {
      return {
        port: DEFAULT_PORT,
        requestedPort: null,
        portMode: "dynamic",
        fallback: "none",
      };
    }
    const options = consoleSettingsStore.readSnapshot().general ?? {};
    if (options.consolePortMode === "static" && isValidConsoleStaticPort(options.consoleStaticPort)) {
      return {
        port: options.consoleStaticPort,
        requestedPort: options.consoleStaticPort,
        portMode: "static",
        fallback: "requested",
      };
    }
    return {
      port: DEFAULT_PORT,
      requestedPort: null,
      portMode: "dynamic",
      fallback: "none",
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
      if (plan.fallback === "resume") {
        return listenOnce(DEFAULT_PORT, {
          requestedPort: plan.requestedPort,
          portMode: plan.portMode,
          portHonored: true,
        });
      }
      if (plan.fallback !== "requested" || plan.requestedPort === null) throw error;
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
    // 걷힌 페어링의 끝난 사유는 더 조회할 키가 없다 — 함께 걷어 메모리에 남기지 않는다.
    for (const device of pairedDeviceStore.revokeAll("remote")) access.clearSessionEnd(device.id);
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

  // 만료를 알아채는 시계는 레지스트리가 가장 이른 만료 시각에 맞춰 스스로 건다 — 유휴로 만료되는
  // 세션은 정의상 아무도 건드리지 않으므로, 그 시각에 종료 신호가 나야 커튼과 채널이 함께 걷힌다.

  async function stopRemoteAccess(): Promise<void> {
    const closing = remoteServer;
    remoteServer = null;
    remoteFingerprint = null;
    listeners = listeners.filter((entry) => entry.audience !== "remote");
    // A listener stop ends live sessions, but unused grants remain valid unless public identity changes.
    // 그 종료 신호가 세션별 채널과 셸 상태를 걷는다. 아래 루프는 세션 없이 남은 원격 셸 상태의 잔여분이다.
    access.revokeSessions("remote");
    for (const owner of desktopShellsByOwner.keys()) {
      if (owner === "local") continue;
      forgetShellOwner(owner);
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
      for (const device of pairedDeviceStore.revokeAll("remote")) access.clearSessionEnd(device.id);
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

  /** 업그레이드도 요청과 같은 판정을 거치고, 입장시킨 세션에 소켓을 묶는다 — 세션이 끝나면 WebSocket도 닫힌다. */
  function remoteAdmission(req: http.IncomingMessage): boolean {
    if (!isReady()) return false;
    const resolved = listenerForRequest(req);
    if (resolved === null || resolved.audience === "local") return true;
    const admission = remoteRequestAdmission(resolved, req, getPathname(req));
    if (!admission.admitted) return false;
    if (admission.sessionHandle !== null) {
      remoteRequestSessions.set(req, admission.sessionHandle);
      remoteSessionBindings.bindSocket(admission.sessionHandle, req.socket);
      // 묶는 순간 세션이 이미 끝나 있었다면 소켓은 파기됐다 — 업그레이드를 넘기지 않는다.
      if (req.socket.destroyed) return false;
    }
    return true;
  }

  /**
   * 요청이 입장한 접속의 수명. 루프백은 세션 수명으로 끝나지 않는다. 원격은 입장 판정이 그 요청에 정해 둔
   * 세션을 따른다 — 판정 기록이 없는 원격 요청(세션 없이 지나는 join, 등록되지 않은 소켓)은 처음부터
   * 끝난 것으로 본다. "모름"을 살아 있음으로 읽으면 끝난 기기의 명령이 그 틈으로 들어온다.
   */
  function requestLifetime(req: http.IncomingMessage): RequestLifetime {
    // 입장 기록을 먼저 본다 — 원격 세션으로 입장한 요청은 리스너 해석이 어떻게 되든 로컬로 읽히지 않는다.
    const handle = remoteRequestSessions.get(req);
    if (handle !== undefined) return { isLive: () => access.isSessionLive(handle), touch: () => access.touchSession(handle) };
    return listenerForRequest(req)?.audience === "local" ? LOCAL_REQUEST_LIFETIME : ENDED_REQUEST_LIFETIME;
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
      const srv = createHttpServer(handleRequest, upgradeRegistry, isRequestHostAllowed, isReady);
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
          const localLoopbackServer = await maybeStartLoopbackServer(host, actualPort, handleRequest, upgradeRegistry, isRequestHostAllowed, isReady);
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
  trackUpgradedSockets(srv);
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
  isAdmitted: (req: http.IncomingMessage) => boolean,
): http.Server {
  const srv = http.createServer(handler);
  srv.timeout = SERVER_TIMEOUT_MS;
  srv.keepAliveTimeout = SERVER_TIMEOUT_MS;
  srv.headersTimeout = SERVER_TIMEOUT_MS + 1000;
  trackUpgradedSockets(srv);
  srv.on("upgrade", createUpgradeListener({ isHostAllowed, upgradeRegistry, isAdmitted }));
  return srv;
}

/**
 * 업그레이드된 소켓(터미널·채팅 WebSocket)은 HTTP 연결 추적에서 빠져 `closeAllConnections()`가
 * 끊지 못하지만, 리스너의 연결 수에는 남아 `close()` 콜백을 막는다. 그 소켓을 닫을 실행 정리는
 * 리스너가 닫힌 뒤에야 돌므로, 리스너가 직접 세어 두었다가 닫을 때 거둔다. 닫힌 소켓은 바로 뺀다.
 */
const upgradedSockets = new WeakMap<http.Server | https.Server, Set<Duplex>>();

function trackUpgradedSockets(srv: http.Server | https.Server): void {
  const sockets = new Set<Duplex>();
  upgradedSockets.set(srv, sockets);
  srv.on("upgrade", (_req: http.IncomingMessage, socket: Duplex) => {
    if (socket.destroyed) return;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
}

async function maybeStartLoopbackServer(
  host: string,
  actualPort: number,
  handler: http.RequestListener,
  upgradeRegistry: UpgradeRegistry,
  isHostAllowed: (req: http.IncomingMessage) => boolean,
  isAdmitted: (req: http.IncomingMessage) => boolean,
): Promise<http.Server | null> {
  if (isLoopbackHost(host) || isWildcardHost(host)) return null;
  const srv = createHttpServer(handler, upgradeRegistry, isHostAllowed, isAdmitted);
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
 * 업그레이드된 WebSocket은 `closeAllConnections()`가 닿지 않으므로 따로 거둔다.
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
    for (const socket of upgradedSockets.get(srv) ?? []) socket.destroy();
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function readJsonBody<T>(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<T | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) return null;
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
