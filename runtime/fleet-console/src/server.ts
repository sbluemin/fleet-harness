import crypto from "node:crypto";
import http from "node:http";

import {
  createCarrierRegistry,
  initStore,
  readCarrierStatusEntries,
  registerDefaultCarriers,
  type CarrierJobStreamEvent,
  type CarrierStatusEntry,
} from "@dotobokuri/fleet-carriers";
import {
  createCarrierResultReminderRouter,
  createFleetAgentRuntimeLifecycle,
  formatCarrierResultReminderMessage,
  getAgentCliMetadata,
  parseAgentCliId,
  sanitizeCarrierResultReminder,
  type AgentCliId,
  type FleetAgentRuntimeLifecycle,
} from "@dotobokuri/fleet-admiral";
import { createInfraServices, getFleetDataDir } from "@dotobokuri/fleet-infra";
import { resolveAuthEnv } from "@dotobokuri/fleet-infra/auth";
import { getWikiToolSpecs } from "@dotobokuri/fleet-wiki";

import type { ConsoleCarrierReadinessEntry, ConsoleHealth, ConsoleObservedWorkspace, ConsoleObserverStatus, ConsoleTheaterInfo, TerminalFolderListResponse } from "./api-types.js";
import { createCarrierSettingsRouter } from "./carrier-settings-routes.js";
import { createCodexGateway } from "./codex/gateway.js";
import { cleanupProviderSessionCaptures, createConsoleDurableStateStore, emptyDurableConsoleState, mergeProviderSessionCaptures, readProviderSessionCapture, unlinkProviderSessionCapture, type DurableConsoleState, type DurableOperation } from "./durable-state.js";
import { createConsoleLock, type ConsoleLockHandle } from "./lock.js";
import { writeAggregateObserverEvents, writeObserverEvents } from "./observability-routes.js";
import { createConsoleDataPaths } from "./paths.js";
import { readFleetConsoleRelease } from "./release.js";
import { createConsoleObservabilityStore } from "./observability-store.js";
import { withSecurityHeaders } from "./security-headers.js";
import { tryServeStaticConsole } from "./static-console.js";
import { listTerminalFolders, TerminalFolderListError } from "./terminal/folder-browser.js";
import { createFolderGrantStore } from "./terminal/folder-grants.js";
import { createDefaultTerminalLaunchResolver, type ConsoleRuntimeSessionInfo, type TerminalLaunchResolver, type TerminalLaunchResolverDeps, startTerminalShell } from "./terminal/launch.js";
import { createTerminalSessionManager } from "./terminal/session-manager.js";
import { createTerminalTicketRegistry } from "./terminal/tickets.js";
import { createWorkspaceChangeScanner } from "./terminal/workspace-scanner.js";
import { createTerminalUpgradeHandler, TERMINAL_TICKET_PATH } from "./terminal/ws-handler.js";
import type { TheaterRegistration } from "./theaters.js";
import { TheaterRegistry } from "./theaters.js";
import { createConsoleUpdateCheckService, type ConsoleUpdateCheckService } from "./update-check.js";

export interface ConsoleServerDeps {
  readonly host?: string;
  readonly port?: number;
  readonly version?: string;
  readonly codexCwd?: string;
  readonly dataDir?: string;
  readonly terminalLaunch?: TerminalLaunchResolver;
  readonly terminalLaunchResolverDeps?: Omit<TerminalLaunchResolverDeps, "agentRuntime" | "dataDir" | "infraServices" | "onRuntimeSessionStart">;
  readonly agentRuntime?: FleetAgentRuntimeLifecycle;
  readonly terminalStartShell?: typeof startTerminalShell;
  readonly maxTerminalSessions?: number;
  readonly updateCheck?: ConsoleUpdateCheckService;
}

export interface ConsoleServer {
  readonly host: string;
  readonly port: number;
  start(lockPaths: { readonly dir: string; readonly lockFile: string }): Promise<string>;
  stop(): Promise<void>;
}

type ObserverLookup = { readonly kind: "aggregate" };
type ConsoleCarrierJobStreamEvent = CarrierJobStreamEvent & { readonly originSessionId?: string };
type TerminalFolderListBody = { readonly path?: unknown };
type TerminalFolderGrantBody = { readonly path?: unknown };
type CreateTerminalSessionBody = { readonly folderGrantId?: unknown; readonly cwd?: unknown; readonly cliId?: unknown };
type CreateTheaterBody = { readonly folderGrantId?: unknown };
type CreateTheaterSessionBody = { readonly cliId?: unknown };

const DEFAULT_HOST = "127.0.0.1";
// 포트 0은 OS가 사용 가능한 임의 포트를 할당한다는 의미다. 실제 바인딩된 포트는
// start()에서 srv.address()의 actualPort로 캡처해 락 파일에 기록한다.
const DEFAULT_PORT = 0;
const SHELL_TERMINAL_SESSION_ID = "shell";
// 캔버스의 순정 셸 패널 세션 id 접두사. 이 접두사 + theaterId가 함께 오면 Theater 디렉터리에서 셸을 띄운다.
const THEATER_SHELL_SESSION_PREFIX = "shell:";
const SERVER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

export function createConsoleServer(deps: ConsoleServerDeps = {}): ConsoleServer {
  const host = deps.host ?? DEFAULT_HOST;
  const port = deps.port ?? DEFAULT_PORT;
  // 버전은 런타임에 package.json을 읽는 release.ts SSoT에서 해석한다(channel과 동일 경로).
  // 과거 빌드타임 상수(__PKG_VERSION__)는 tsup define에 주입된 적이 없어 항상 "0.0.0-dev"로
  // 폴백되는 죽은 경로였다. deps.version은 테스트 오버라이드용으로 유지한다.
  const version = deps.version ?? readFleetConsoleRelease().version;
  const channel = readConsoleChannel();
  const carrierRegistry = createCarrierRegistry();
  registerDefaultCarriers(carrierRegistry);
  const lock = createConsoleLock({ hostname: () => host });
  const observability = createConsoleObservabilityStore();
  const updateCheck = deps.updateCheck ?? createConsoleUpdateCheckService();
  const theaters = new TheaterRegistry();
  const terminalTickets = createTerminalTicketRegistry();
  const folderGrants = createFolderGrantStore();
  const infraServices = createInfraServices();
  const dataDir = deps.dataDir ?? getFleetDataDir();
  initStore(dataDir);
  const durablePaths = createConsoleDataPaths({ fleetDataDir: dataDir });
  const durableStateStore = createConsoleDurableStateStore({ paths: durablePaths });
  const authEnvResolver = (cli: Parameters<typeof resolveAuthEnv>[0]) => resolveAuthEnv(cli, { authService: infraServices.authService });
  const ownsAgentRuntime = deps.agentRuntime === undefined;
  const agentRuntime = deps.agentRuntime ?? createFleetAgentRuntimeLifecycle({
    authEnvResolver,
    dataDir,
    onMcpServerStartError: (error) => {
      console.error("[fleet-console] Failed to start MCP server", error);
    },
    workspaceChangeScanner: createWorkspaceChangeScanner(),
    wikiToolSpecs: getWikiToolSpecs(),
  });
  const jobOriginById = new Map<string, string>();
  const unsubscribeCarrierStream = agentRuntime.carrierRuntime.jobs.streaming.register((event) => {
    const sessionId = resolveCarrierEventOrigin(event, jobOriginById);
    if (!sessionId) return;
    observability.appendTerminalRuntimeEvent(sessionId, event);
  });
  const codex = createCodexGateway({
    cwd: deps.codexCwd ?? process.cwd(),
    host,
    version,
    getPort: () => lockHandle?.payload.port ?? port,
    getAdminToken: () => lockHandle?.payload.token ?? null,
  });
  const pendingRuntimeSessions = new Map<string, ConsoleRuntimeSessionInfo>();
  const terminalSessions = createTerminalSessionManager({
    launch: deps.terminalLaunch ?? createDefaultTerminalLaunchResolver({
      ...deps.terminalLaunchResolverDeps,
      agentRuntime,
      dataDir,
      infraServices,
      onRuntimeSessionStart: (session) => {
        pendingRuntimeSessions.set(session.sessionId, session);
      },
    }),
    startShell: deps.terminalStartShell,
    maxSessions: deps.maxTerminalSessions,
    onSessionExit: (sessionId) => {
      pendingRuntimeSessions.delete(sessionId);
      const operation = observability.getDurableOperation(sessionId);
      const providerSession = operation?.providerSession ?? readProviderSessionCapture(sessionId, { capturesDir: durablePaths.capturesDir });
      if (providerSession) {
        observability.updateTerminalSessionProviderSession(sessionId, providerSession);
        const dormant = observability.transitionTerminalSessionToDormant(sessionId, providerSession);
        if (dormant) observability.notifySessionUpdated(dormant);
      } else {
        observability.removeTerminalSession(sessionId);
      }
      persistDurableState();
    },
  });
  const unsubscribeCarrierReminderRouter = createCarrierResultReminderRouter({
    streamRegister: agentRuntime.carrierRuntime.jobs.streaming.register,
    resolveSink: (event) => {
      const sessionId = resolveCarrierEventOrigin(event, jobOriginById);
      if (!sessionId) return undefined;
      return {
        write: (data) => {
          terminalSessions.writeToSession(sessionId, data);
        },
      };
    },
    resolvePolicy: (event) => {
      const sessionId = resolveCarrierEventOrigin(event, jobOriginById);
      return sessionId ? terminalSessions.getSessionMessagePolicy(sessionId) ?? {} : {};
    },
  });
  const terminalUpgrade = createTerminalUpgradeHandler({
    expectedHost: host,
    getExpectedPort: () => lockHandle?.payload.port ?? port,
    tickets: terminalTickets,
    sessions: terminalSessions,
    validateHost,
  });
  let server: http.Server | null = null;
  let loopbackServer: http.Server | null = null;
  let lockHandle: ConsoleLockHandle | null = null;
  let activeEndpoint: string | null = null;
  let agentRuntimeStopped = false;
  let consoleResourcesDisposed = false;
  const carrierSettingsRouter = createCarrierSettingsRouter({
    registry: carrierRegistry,
    isAuthorized: isTerminalAuthorized,
    readJsonBody,
    writeJson,
  });

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
    if (pathname === "/health") {
      handleHealth(req, res);
      return;
    }
    if (pathname === TERMINAL_TICKET_PATH) {
      runAsyncHandler(handleTerminalTicket(req, res), res);
      return;
    }
    if (pathname === "/terminal/folders/list") {
      runAsyncHandler(handleTerminalFoldersList(req, res), res);
      return;
    }
    if (pathname === "/terminal/folders/grants") {
      runAsyncHandler(handleTerminalFolderGrants(req, res), res);
      return;
    }
    if (pathname === "/terminal/sessions") {
      runAsyncHandler(handleTerminalSessions(req, res), res);
      return;
    }
    const terminalSessionResumeMatch = pathname.match(/^\/terminal\/sessions\/([^/]+)\/resume$/);
    if (terminalSessionResumeMatch) {
      runAsyncHandler(handleTerminalSessionResume(req, res, decodeURIComponent(terminalSessionResumeMatch[1] ?? "")), res);
      return;
    }
    const terminalSessionItemMatch = pathname.match(/^\/terminal\/sessions\/([^/]+)$/);
    if (terminalSessionItemMatch) {
      runAsyncHandler(handleTerminalSessionItem(req, res, decodeURIComponent(terminalSessionItemMatch[1] ?? "")), res);
      return;
    }
    if (pathname === "/observer/theaters") {
      runAsyncHandler(handleObserverTheaters(req, res), res);
      return;
    }
    const theaterItemMatch = pathname.match(/^\/observer\/theaters\/([^/]+)$/);
    if (theaterItemMatch) {
      runAsyncHandler(handleObserverTheaterItem(req, res, decodeURIComponent(theaterItemMatch[1] ?? "")), res);
      return;
    }
    const theaterSessionMatch = pathname.match(/^\/observer\/theaters\/([^/]+)\/sessions$/);
    if (theaterSessionMatch) {
      runAsyncHandler(handleObserverTheaterSessions(req, res, decodeURIComponent(theaterSessionMatch[1] ?? "")), res);
      return;
    }
    if (pathname === "/observer/status") {
      handleObserverStatus(req, res);
      return;
    }
    if (pathname === "/observer/carriers") {
      handleObserverCarriers(req, res);
      return;
    }
    if (pathname === "/carrier-settings" || pathname.startsWith("/carrier-settings/")) {
      runAsyncBooleanHandler(carrierSettingsRouter({ req, res, pathname }), res);
      return;
    }
    if (pathname === "/observer/tenants") {
      handleObserverWorkspaces(req, res);
      return;
    }
    if (pathname === "/observer/jobs") {
      handleObserverJobs(req, res);
      return;
    }
    if (pathname === "/observer/events") {
      handleObserverEvents(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  }

  function handleHealth(req: http.IncomingMessage, res: http.ServerResponse): void {
    const handle = lockHandle;
    const token = handle?.payload.token;
    if (!handle || !token || req.headers.authorization !== `Bearer ${token}`) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const payload = handle.payload;
    const body: ConsoleHealth = {
      ok: true,
      pid: payload.pid,
      host: payload.host,
      port: payload.port,
      endpoint: payload.endpoint,
      startedAt: payload.startedAt,
      version: payload.version,
      workspaceCount: observability.workspaceCount(),
    };
    writeJson(res, 200, body);
  }

  async function handleTerminalTicket(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const body = await readJsonBody<{ readonly sessionId?: string; readonly kind?: string; readonly theaterId?: string }>(req);
    const kind = body?.kind === "shell" ? "shell" : "fleet";
    const requestedSessionId = body?.sessionId;
    const requestedTheaterId = typeof body?.theaterId === "string" ? body.theaterId : undefined;
    let sessionId: string;
    let cwd: string | null;
    if (kind === "shell") {
      if (typeof requestedSessionId === "string" && requestedSessionId.startsWith(THEATER_SHELL_SESSION_PREFIX) && requestedTheaterId) {
        // theater-shell: 캔버스 순정 셸 패널. theaterId로 Theater 디렉터리를 서버 측에서만 해석한다(raw 경로 비노출).
        const theater = theaters.get(requestedTheaterId);
        if (!theater) {
          writeJson(res, 404, { error: "theater_not_found" });
          return;
        }
        sessionId = requestedSessionId;
        cwd = theater.path;
      } else {
        // 싱글톤 셸 오버레이(Cmd+`) — 기존 계약 보존: 고정 sessionId + 빈 cwd(서버 cwd 폴백).
        sessionId = SHELL_TERMINAL_SESSION_ID;
        cwd = "";
      }
    } else if (typeof requestedSessionId === "string" && requestedSessionId.length > 0) {
      sessionId = requestedSessionId;
      cwd = observability.getLaunchCwd(sessionId);
    } else {
      writeJson(res, 400, { error: "terminal_session_not_found" });
      return;
    }
    if (cwd === null) {
      writeJson(res, 404, { error: "terminal_session_not_found" });
      return;
    }
    if (!terminalSessions.canAttach(sessionId)) {
      writeJson(res, 503, { error: "Terminal session capacity exhausted" });
      return;
    }
    writeJson(res, 200, terminalTickets.issue({
      cwd,
      sessionId,
      kind,
    }));
  }

  async function handleTerminalFoldersList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody<TerminalFolderListBody>(req);
    if (!isPlainObject(body) || (body.path !== undefined && body.path !== null && typeof body.path !== "string")) {
      writeJson(res, 400, { error: "invalid_path" });
      return;
    }
    try {
      const payload: TerminalFolderListResponse = await listTerminalFolders(body.path === undefined ? null : body.path);
      writeJson(res, 200, payload);
    } catch (error) {
      if (error instanceof TerminalFolderListError) {
        writeJson(res, terminalFolderListStatus(error), { error: error.code });
        return;
      }
      throw error;
    }
  }

  async function handleTerminalFolderGrants(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody<TerminalFolderGrantBody>(req);
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

  async function handleTerminalSessions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "GET") {
      writeJson(res, 200, { sessions: observability.listTerminalSessions() });
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const body = await readJsonBody<CreateTerminalSessionBody>(req);
    if (!body || typeof body.folderGrantId !== "string" || "cwd" in body) {
      writeJson(res, 400, { error: "invalid_folder_grant" });
      return;
    }
    const cliId = readOptionalAgentCliId(body.cliId, res);
    if (cliId === false) return;
    const cwd = folderGrants.consume(body.folderGrantId);
    if (!cwd) {
      writeJson(res, 400, { error: "invalid_folder_grant" });
      return;
    }
    await createTerminalSessionForCwd(cwd, res, cliId);
  }

  // 작전(터미널 세션) 이름 변경 시, 실행 중인 Agent CLI에 rename 슬래시 명령을 주입한다.
  // carrier 결과 system-reminder와 동일한 주입 경로(messagePolicy 포맷 + writeToSession)를 재사용하므로
  // CLI별 lineTerminator/bracketed-paste 처리가 자동으로 일관되게 적용된다.
  function injectRenameCommand(sessionId: string, label: string | undefined): void {
    if (!label) return;
    // 세션이 실제로 launch한 Agent CLI 프로파일이 제공한 rename 슬래시 명령을 조회한다(messagePolicy와
    // 동일 소스). FLEET_TERMINAL_CMD 같은 임의 override나 미지원 CLI는 renameCommand가 없으므로 건너뛴다.
    const renameCommand = terminalSessions.getSessionRenameCommand(sessionId);
    if (!renameCommand) return;
    // 라벨을 먼저 단일 라인으로 정규화(개행·탭 → 공백)하고 제어문자를 제거한다. 개행/캐리지리턴은
    // 명령 한 줄을 분리해 추가 명령을 주입하는 통로가 되므로 carrier 리마인더와 동일한 sanitize를
    // 라벨에 직접 적용한다. rename 명령 prefix를 붙이기 전에 라벨 자체를 검사해, 제어문자만 있던
    // 라벨(콘솔 기본 표시명으로 복귀)이 인자 없는 bare 명령으로 새는 것을 막는다.
    const safeLabel = sanitizeCarrierResultReminder(label.replace(/[\r\n\t]+/g, " ")).trim();
    if (safeLabel.length === 0) return;
    // messagePolicy는 carrier 리마인더와 동일 소스를 써서 CLI별 lineTerminator/bracketed-paste 처리가
    // 일관되게 적용된다. 세션이 아직 PTY를 띄우지 않았거나 종료된 경우 writeToSession이 무시한다.
    const policy = terminalSessions.getSessionMessagePolicy(sessionId) ?? {};
    for (const chunk of formatCarrierResultReminderMessage(policy, `${renameCommand} ${safeLabel}`)) {
      terminalSessions.writeToSession(sessionId, chunk);
    }
  }

  async function handleTerminalSessionItem(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): Promise<void> {
    if (req.method !== "DELETE" && req.method !== "PATCH") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody<{ readonly label?: unknown }>(req);
      if (!body || (body.label !== undefined && typeof body.label !== "string")) {
        writeJson(res, 400, { error: "invalid_session_label" });
        return;
      }
      const updated = observability.renameTerminalSession(sessionId, body.label ?? "");
      if (!updated) {
        writeJson(res, 404, { error: "session_not_found" });
        return;
      }
      // 세션 이름은 PTY 생명주기 인메모리 메타만 갱신하고, raw cwd는 계속 직렬화하지 않는다.
      observability.notifySessionUpdated(updated);
      // 작전 이름 변경을 실행 중인 Agent CLI 세션에도 동기화한다: carrier 결과 system-reminder와
      // 동일한 PTY 주입 파이프라인을 재사용해 해당 CLI의 rename 슬래시 명령을 그 세션에 주입한다.
      injectRenameCommand(sessionId, updated.label);
      persistDurableState();
      writeJson(res, 200, updated);
      return;
    }
    // 운영자 X 버튼은 영구 삭제다. 라이브 PTY를 끝내고, dormant/live durable operation과 capture까지 함께 잊는다.
    forgetTerminalSession(sessionId);
    writeJson(res, 200, { ok: true });
  }

  async function handleTerminalSessionResume(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const dormantSession = observability.listTerminalSessions().find((session) => session.sessionId === sessionId && session.status === "dormant");
    const operation = dormantSession ? observability.getDurableOperation(sessionId) : null;
    if (!operation) {
      writeJson(res, 404, { error: "session_not_found" });
      return;
    }
    const cliId = readDurableAgentCliId(operation);
    if (!cliId) {
      writeJson(res, 409, { error: "resume_unavailable" });
      return;
    }
    const providerSession = operation.providerSession ?? readProviderSessionCapture(sessionId, { capturesDir: durablePaths.capturesDir });
    if (!providerSession) {
      writeJson(res, 409, { error: "resume_unavailable" });
      return;
    }
    observability.updateTerminalSessionProviderSession(sessionId, providerSession);
    const starting = observability.updateTerminalSessionStatus(sessionId, "starting");
    if (starting) observability.notifySessionUpdated(starting);
    try {
      await terminalSessions.createSession({ sessionId, cwd: operation.cwd, cliId, resumeSessionId: providerSession.sessionId });
      const runtimeSession = pendingRuntimeSessions.get(sessionId);
      pendingRuntimeSessions.delete(sessionId);
      const resumed = runtimeSession
        ? observability.registerTerminalRuntimeSession(runtimeSession) ?? starting
        : observability.updateTerminalSessionStatus(sessionId, "terminal-only") ?? starting;
      if (!resumed) {
        writeJson(res, 404, { error: "session_not_found" });
        return;
      }
      observability.notifySessionUpdated(resumed);
      persistDurableState();
      writeJson(res, 200, resumed);
    } catch {
      pendingRuntimeSessions.delete(sessionId);
      const reverted = observability.updateTerminalSessionStatus(sessionId, "dormant");
      if (reverted) observability.notifySessionUpdated(reverted);
      persistDurableState();
      writeJson(res, 503, { error: "terminal_unavailable" });
    }
  }

  async function handleObserverTheaters(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === "GET") {
      writeJson(res, 200, { theaters: listTheaterInfos(), agentClis: getAgentCliMetadata() });
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
      await codex.registerWorkspace(cwd);
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
    const operations = observability.listDurableOperations().filter((operation) => operation.theaterId === theaterId);
    // DELETE는 idempotent해야 한다 — Theater가 레지스트리에 이미 없어도(유령 항목이나 중복 forget) 목표 상태(부재)는
    // 이미 달성된 것이므로 404가 아닌 성공으로 처리하고, 남아 있을 수 있는 소속 Operation도 함께 정리한다.
    theaters.remove(theaterId);
    for (const operation of operations) forgetTerminalSession(operation.sessionId, { persist: false });
    persistDurableState();
    writeJson(res, 200, { ok: true });
  }

  async function handleObserverTheaterSessions(req: http.IncomingMessage, res: http.ServerResponse, theaterId: string): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const theater = theaters.get(theaterId);
    if (!theater) {
      writeJson(res, 404, { error: "theater_not_found" });
      return;
    }
    const body = await readJsonBody<CreateTheaterSessionBody>(req);
    const cliId = readOptionalAgentCliId(body?.cliId, res);
    if (cliId === false) return;
    await createTerminalSessionForCwd(theater.path, res, cliId);
  }

  async function createTerminalSessionForCwd(cwd: string, res: http.ServerResponse, cliId?: AgentCliId): Promise<void> {
    const sessionId = crypto.randomUUID();
    const session = observability.createPendingTerminalSession({ sessionId, cwd, cliId });
    try {
      await terminalSessions.createSession({ sessionId, cwd, cliId });
      const runtimeSession = pendingRuntimeSessions.get(sessionId);
      pendingRuntimeSessions.delete(sessionId);
      const created = runtimeSession
        ? observability.registerTerminalRuntimeSession(runtimeSession) ?? session
        : observability.updateTerminalSessionStatus(sessionId, "terminal-only") ?? session;
      observability.notifySessionUpdated(created);
      persistDurableState();
      writeJson(res, 200, created);
    } catch (error) {
      pendingRuntimeSessions.delete(sessionId);
      observability.updateTerminalSessionStatus(sessionId, "error");
      writeJson(res, 503, { error: "terminal_unavailable" });
    }
  }

  function handleObserverStatus(req: http.IncomingMessage, res: http.ServerResponse): void {
    const lookup = readObserverLookup();
    if (lookup.kind !== "aggregate") return;
    const theaterId = readUrl(req).searchParams.get("theaterId");
    const payload: ConsoleObserverStatus = {
      workspaces: observability.listWorkspaces().length,
      jobs: observability.listWorkspaces().reduce((count, workspace) => count + observability.listJobs(workspace.tenantId).length, 0),
      version,
      channel,
      ...updateCheck.getStatus(),
      port: lockHandle?.payload.port ?? port,
      wikiServerStatus: resolveWikiServerStatus(theaterId),
    };
    writeJson(res, 200, payload);
  }

  function handleObserverCarriers(_req: http.IncomingMessage, res: http.ServerResponse): void {
    writeJson(res, 200, {
      carriers: readCarrierStatusEntries(carrierRegistry).map(toCarrierReadinessEntry),
    });
  }

  function handleObserverWorkspaces(_req: http.IncomingMessage, res: http.ServerResponse): void {
    const lookup = readObserverLookup();
    if (lookup.kind !== "aggregate") return;
    writeJson(res, 200, { tenants: observability.listWorkspaces() });
  }

  function handleObserverJobs(req: http.IncomingMessage, res: http.ServerResponse): void {
    const lookup = readObserverLookup();
    if (lookup.kind !== "aggregate") return;
    const requestedTenantId = readUrl(req).searchParams.get("tenant");
    const visibleWorkspaces = listVisibleWorkspaces(requestedTenantId);
    if (requestedTenantId && visibleWorkspaces.length === 0) {
      writeJson(res, 404, { error: "Workspace not found" });
      return;
    }
    writeJson(res, 200, {
      tenants: visibleWorkspaces.map((workspace) => ({
        tenantId: workspace.tenantId,
        tenantLabel: workspace.tenantLabel,
        jobs: observability.listJobs(workspace.tenantId),
        truncation: observability.getTruncation(workspace.tenantId),
      })),
    });
  }

  function handleObserverEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    const lookup = readObserverLookup();
    if (lookup.kind !== "aggregate") return;
    const requestedTenantId = readUrl(req).searchParams.get("tenant");
    const visibleWorkspaces = listVisibleWorkspaces(requestedTenantId);
    if (requestedTenantId && visibleWorkspaces.length === 0) {
      writeJson(res, 404, { error: "Workspace not found" });
      return;
    }
    if (requestedTenantId) {
      writeObserverEvents(req, res, visibleWorkspaces[0]!, observability);
      return;
    }
    writeAggregateObserverEvents(req, res, visibleWorkspaces, observability, (tenantId) => observability.getWorkspace(tenantId), {
      subscribeAll: true,
    });
  }

  function readObserverLookup(): ObserverLookup {
    return { kind: "aggregate" };
  }

  function isTerminalAuthorized(req: http.IncomingMessage): boolean {
    if (!lockHandle) return false;
    // Origin 검증으로 WS 경로와 동일한 출처 경계를 terminal 라우트에 적용한다.
    return isAllowedTerminalOrigin(req, lockHandle.payload.port ?? port);
  }

  function listVisibleWorkspaces(requestedTenantId: string | null): readonly ConsoleObservedWorkspace[] {
    if (requestedTenantId) {
      const workspace = observability.getWorkspace(requestedTenantId);
      return workspace ? [workspace] : [];
    }
    return observability.listWorkspaces();
  }

  function listTheaterInfos(): readonly ConsoleTheaterInfo[] {
    return theaters.list().map((theater) => toTheaterInfo(theater, codex.getWorkspace(theater.id) !== null));
  }

  function forgetTerminalSession(sessionId: string, options: { readonly persist?: boolean } = {}): void {
    terminalSessions.terminate(sessionId);
    pendingRuntimeSessions.delete(sessionId);
    observability.removeTerminalSession(sessionId);
    unlinkProviderSessionCapture(sessionId, { capturesDir: durablePaths.capturesDir });
    if (options.persist !== false) persistDurableState();
  }

  function toTheaterInfo(theater: TheaterRegistration, hasWiki: boolean): ConsoleTheaterInfo {
    return {
      id: theater.id,
      label: theater.label,
      createdAt: theater.registeredAt,
      lastOpenedAt: theater.lastOpenedAt,
      hasWiki,
      activeAdmiralCount: observability.listWorkspaces()
        .filter((workspace) => workspace.theaterId === theater.id)
        .length,
    };
  }

  function toCarrierReadinessEntry(entry: CarrierStatusEntry): ConsoleCarrierReadinessEntry {
    return {
      carrierId: entry.carrierId,
      displayName: entry.displayName,
      role: entry.role,
      model: entry.model,
      effort: entry.effort,
      taskForceBackendCount: entry.taskForceBackendCount,
      subagentMode: entry.subagentMode,
      ...(entry.category ? { category: entry.category } : {}),
      slot: entry.slot,
      cliType: entry.cliType,
    };
  }

  function resolveWikiServerStatus(theaterId: string | null): ConsoleObserverStatus["wikiServerStatus"] {
    if (!theaterId) return "unknown";
    if (!theaters.get(theaterId)) return "unknown";
    return codex.getWorkspace(theaterId) ? "available" : "unavailable";
  }

  async function cleanupOwnedAgentRuntime(): Promise<void> {
    if (!ownsAgentRuntime || agentRuntimeStopped) return;
    await agentRuntime.cleanup();
    agentRuntimeStopped = true;
  }

  async function cleanupAfterFailedStart(): Promise<void> {
    const current = server;
    const currentLoopback = loopbackServer;
    const currentLock = lockHandle;
    server = null;
    loopbackServer = null;
    lockHandle = null;
    activeEndpoint = null;
    await Promise.all([
      closeHttpServer(current),
      closeHttpServer(currentLoopback),
    ]);
    await terminalSessions.stop();
    await cleanupOwnedAgentRuntime();
    disposeConsoleResources(currentLock);
  }

  function disposeConsoleResources(currentLock: ConsoleLockHandle | null): void {
    if (consoleResourcesDisposed) {
      currentLock?.release();
      return;
    }
    consoleResourcesDisposed = true;
    unsubscribeCarrierReminderRouter();
    unsubscribeCarrierStream();
    observability.clear();
    terminalUpgrade.close();
    currentLock?.release();
  }

  function rehydrateDurableState(): void {
    let state: DurableConsoleState;
    try {
      state = durableStateStore.load();
      theaters.restore(state.theaters);
    } catch (error) {
      console.warn(`[fleet-console] Durable state restore skipped: ${error instanceof Error ? error.message : String(error)}`);
      state = emptyDurableConsoleState();
      theaters.restore([]);
    }
    const merged = mergeProviderSessionCaptures(state, { capturesDir: durablePaths.capturesDir });
    syncProviderSessionsToObservability(merged);
    const restorable = {
      ...merged,
      operations: merged.operations.filter((operation) => operation.providerSession),
    };
    if (merged !== state || restorable.operations.length !== merged.operations.length) {
      try {
        durableStateStore.save(restorable);
        cleanupProviderSessionCaptures(restorable, { capturesDir: durablePaths.capturesDir });
      } catch (error) {
        console.warn(`[fleet-console] Durable state capture merge was not persisted: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      cleanupProviderSessionCaptures(restorable, { capturesDir: durablePaths.capturesDir });
    }
    for (const operation of restorable.operations) {
      if (theaters.get(operation.theaterId)) observability.injectDormantOperation(operation);
    }
  }

  function persistDurableState(): void {
    try {
      const state = mergeProviderSessionCaptures({
        version: 1,
        theaters: theaters.list(),
        operations: observability.listDurableOperations(),
      }, { capturesDir: durablePaths.capturesDir });
      syncProviderSessionsToObservability(state);
      const operationsWithProviderSession = state.operations.filter((operation) => operation.providerSession);
      durableStateStore.save({
        version: state.version,
        theaters: state.theaters,
        // 대화 없는 빈 Operation 드롭은 rehydrate에서 capture 머지 뒤에만 수행한다.
        // create 시점의 메타데이터를 먼저 남겨야 이후 도착한 capture 파일이 재시작 때 병합될 수 있다.
        operations: state.operations,
      });
      cleanupProviderSessionCaptures({ ...state, operations: operationsWithProviderSession }, { capturesDir: durablePaths.capturesDir });
    } catch (error) {
      console.warn(`[fleet-console] Durable state save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function syncProviderSessionsToObservability(state: DurableConsoleState): void {
    for (const operation of state.operations) {
      if (operation.providerSession) observability.updateTerminalSessionProviderSession(operation.sessionId, operation.providerSession);
    }
  }

  return {
    host,
    port,
    async start(lockPaths) {
      if (server && lockHandle) return lockHandle.payload.endpoint;
      try {
        rehydrateDurableState();
        await new Promise<void>((resolve, reject) => {
          const srv = createHttpServer(handleRequest, terminalUpgrade);
          srv.once("error", reject);
          srv.listen(port, host, async () => {
            srv.off("error", reject);
            const address = srv.address();
            const actualPort = typeof address === "object" && address ? address.port : port;
            const endpoint = `http://${host}:${actualPort}/`;
            try {
              const localLoopbackServer = await maybeStartLoopbackServer(host, actualPort, handleRequest, terminalUpgrade);
              server = srv;
              loopbackServer = localLoopbackServer;
              lockHandle = lock.writeLock({ dir: lockPaths.dir, lockFile: lockPaths.lockFile, pid: process.pid, port: actualPort, endpoint, version });
              activeEndpoint = endpoint;
              resolve();
            } catch (err) {
              await closeHttpServer(srv);
              await closeHttpServer(loopbackServer);
              server = null;
              loopbackServer = null;
              reject(err);
            }
          });
        });
      } catch (error) {
        await cleanupAfterFailedStart();
        throw error;
      }
      if (!activeEndpoint) throw new Error("Console endpoint unavailable");
      void updateCheck.refresh();
      return activeEndpoint;
    },
    async stop() {
      const current = server;
      const currentLoopback = loopbackServer;
      const currentLock = lockHandle;
      let cleanupError: unknown;
      server = null;
      loopbackServer = null;
      lockHandle = null;
      activeEndpoint = null;
      try {
        await Promise.all([
          closeHttpServer(current),
          closeHttpServer(currentLoopback),
        ]);
        await terminalSessions.stop();
        if (!agentRuntimeStopped) {
          try {
            if (ownsAgentRuntime) await cleanupOwnedAgentRuntime();
          } catch (error) {
            cleanupError = error;
          }
        }
      } finally {
        disposeConsoleResources(currentLock);
      }
      if (cleanupError) throw cleanupError;
    },
  };
}

function readConsoleChannel(): ConsoleObserverStatus["channel"] {
  try {
    return readFleetConsoleRelease().channel;
  } catch {
    return "unknown";
  }
}

function resolveCarrierEventOrigin(event: ConsoleCarrierJobStreamEvent, jobOriginById: Map<string, string>): string | null {
  const originSessionId = event.originSessionId;
  if (originSessionId) {
    jobOriginById.set(event.jobId, originSessionId);
    if (event.type === "job:finalized") queueOriginCleanup(event.jobId, jobOriginById);
    return originSessionId;
  }
  const knownOrigin = jobOriginById.get(event.jobId);
  if (event.type === "job:finalized") queueOriginCleanup(event.jobId, jobOriginById);
  return knownOrigin ?? null;
}

function queueOriginCleanup(jobId: string, jobOriginById: Map<string, string>): void {
  queueMicrotask(() => jobOriginById.delete(jobId));
}

function readDurableAgentCliId(operation: DurableOperation): AgentCliId | null {
  if (!operation.cliId) return null;
  try {
    return parseAgentCliId(operation.cliId) ?? null;
  } catch {
    return null;
  }
}

function createHttpServer(
  handler: http.RequestListener,
  terminalUpgrade: ReturnType<typeof createTerminalUpgradeHandler>,
): http.Server {
  const srv = http.createServer(handler);
  srv.timeout = SERVER_TIMEOUT_MS;
  srv.keepAliveTimeout = SERVER_TIMEOUT_MS;
  srv.headersTimeout = SERVER_TIMEOUT_MS + 1000;
  srv.on("upgrade", (req, socket, head) => {
    if (!terminalUpgrade.handleUpgrade(req, socket, head)) socket.destroy();
  });
  return srv;
}

async function maybeStartLoopbackServer(
  host: string,
  actualPort: number,
  handler: http.RequestListener,
  terminalUpgrade: ReturnType<typeof createTerminalUpgradeHandler>,
): Promise<http.Server | null> {
  if (isLoopbackHost(host) || isWildcardHost(host)) return null;
  const srv = createHttpServer(handler, terminalUpgrade);
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

function readOptionalAgentCliId(value: unknown, res: http.ServerResponse): AgentCliId | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    writeJson(res, 400, { error: "invalid_agent_cli" });
    return false;
  }
  try {
    return parseAgentCliId(value);
  } catch {
    writeJson(res, 400, { error: "invalid_agent_cli" });
    return false;
  }
}

function terminalFolderListStatus(error: TerminalFolderListError): number {
  if (error.code === "forbidden") return 403;
  if (error.code === "not_found") return 404;
  return 400;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
