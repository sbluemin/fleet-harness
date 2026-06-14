import crypto from "node:crypto";
import http from "node:http";

import type {
  DeregisterCliRequest,
  HeartbeatCliRequest,
  PushEventsRequest,
  RegisterCliRequest,
} from "@dotobokuri/core-agent";
import {
  createCarrierRegistry,
  readCarrierStatusEntries,
  registerDefaultCarriers,
  type CarrierStatusEntry,
} from "@dotobokuri/fleet-carriers";

import { readBearerToken } from "./auth.js";
import type { ConsoleCarrierReadinessEntry, ConsoleHealth, ConsoleObservedWorkspace, ConsoleObserverStatus, ConsoleTheaterInfo } from "./api-types.js";
import { createCodexGateway } from "./codex/gateway.js";
import { createConsoleLock, type ConsoleLockHandle } from "./lock.js";
import { writeAggregateObserverEvents, writeObserverEvents } from "./observability-routes.js";
import { readFleetConsoleRelease } from "./release.js";
import { createConsoleObservabilityStore } from "./observability-store.js";
import { withSecurityHeaders } from "./security-headers.js";
import { tryServeStaticConsole } from "./static-console.js";
import type { FolderPickerResult } from "./terminal/folder-picker.js";
import { createNativeFolderPicker } from "./terminal/folder-picker.js";
import { createFolderGrantStore } from "./terminal/folder-grants.js";
import { createDefaultTerminalLaunchResolver, type TerminalLaunchResolver, startTerminalShell } from "./terminal/launch.js";
import { createTerminalSessionManager } from "./terminal/session-manager.js";
import { createTerminalTicketRegistry } from "./terminal/tickets.js";
import { createTerminalUpgradeHandler, TERMINAL_TICKET_PATH } from "./terminal/ws-handler.js";
import type { TheaterRegistration } from "./theaters.js";
import { TheaterRegistry } from "./theaters.js";

export interface ConsoleServerDeps {
  readonly host?: string;
  readonly port?: number;
  readonly version?: string;
  readonly codexCwd?: string;
  readonly terminalLaunch?: TerminalLaunchResolver;
  readonly terminalStartShell?: typeof startTerminalShell;
  readonly maxTerminalSessions?: number;
  readonly terminalPickFolder?: () => Promise<FolderPickerResult>;
}

export interface ConsoleServer {
  readonly host: string;
  readonly port: number;
  start(lockPaths: { readonly dir: string; readonly lockFile: string }): Promise<string>;
  stop(): Promise<void>;
}

type ObserverLookup = { readonly kind: "aggregate" };

const DEFAULT_HOST = "127.0.0.1";
// 포트 0은 OS가 사용 가능한 임의 포트를 할당한다는 의미다. 실제 바인딩된 포트는
// start()에서 srv.address()의 actualPort로 캡처해 락 파일에 기록한다.
const DEFAULT_PORT = 0;
const DEFAULT_TERMINAL_SESSION_ID = "default";
const SHELL_TERMINAL_SESSION_ID = "shell";
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
  const theaters = new TheaterRegistry();
  const terminalTickets = createTerminalTicketRegistry();
  const folderGrants = createFolderGrantStore();
  const codex = createCodexGateway({
    cwd: deps.codexCwd ?? process.cwd(),
    host,
    version,
    getPort: () => lockHandle?.payload.port ?? port,
    getAdminToken: () => lockHandle?.payload.token ?? null,
  });
  const pickTerminalFolder = deps.terminalPickFolder ?? createNativeFolderPicker();
  const terminalSessions = createTerminalSessionManager({
    launch: deps.terminalLaunch ?? createDefaultTerminalLaunchResolver(),
    startShell: deps.terminalStartShell,
    maxSessions: deps.maxTerminalSessions,
    // PTY가 종료되면(예: fleet-cli 종료) 콘솔 세션 목록에서도 제거해 잔존/재실행을 막는다.
    onSessionExit: (sessionId) => observability.removeTerminalSession(sessionId),
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
    if (pathname === "/api/cli/register") {
      runAsyncHandler(handleCliRegister(req, res), res);
      return;
    }
    if (pathname === "/api/cli/events") {
      runAsyncHandler(handleCliEvents(req, res), res);
      return;
    }
    if (pathname === "/api/cli/heartbeat") {
      runAsyncHandler(handleCliHeartbeat(req, res), res);
      return;
    }
    if (pathname === "/api/cli/deregister") {
      runAsyncHandler(handleCliDeregister(req, res), res);
      return;
    }
    if (pathname === TERMINAL_TICKET_PATH) {
      runAsyncHandler(handleTerminalTicket(req, res), res);
      return;
    }
    if (pathname === "/terminal/folders/pick") {
      runAsyncHandler(handleTerminalFolderPick(req, res), res);
      return;
    }
    if (pathname === "/terminal/sessions") {
      runAsyncHandler(handleTerminalSessions(req, res), res);
      return;
    }
    const terminalSessionItemMatch = pathname.match(/^\/terminal\/sessions\/([^/]+)$/);
    if (terminalSessionItemMatch) {
      handleTerminalSessionItem(req, res, decodeURIComponent(terminalSessionItemMatch[1] ?? ""));
      return;
    }
    if (pathname === "/observer/theaters") {
      runAsyncHandler(handleObserverTheaters(req, res), res);
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
    observability.markExpiredSessions();
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

  async function handleCliRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const handle = lockHandle;
    const token = readBearerToken(req.headers);
    if (!handle || token !== handle.payload.token) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const input = await readJsonBody<RegisterCliRequest>(req);
    if (!input) {
      writeJson(res, 400, { error: "Invalid registration payload" });
      return;
    }
    try {
      writeJson(res, 200, observability.register(input));
    } catch (err) {
      writeJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleCliEvents(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const token = readBearerToken(req.headers);
    const input = await readJsonBody<PushEventsRequest>(req);
    if (!token || !Array.isArray(input)) {
      writeJson(res, token ? 400 : 401, { error: token ? "Invalid event payload" : "Unauthorized" });
      return;
    }
    const result = observability.pushEvents(token, input);
    if (!result) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    writeJson(res, 200, result);
  }

  async function handleCliHeartbeat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const token = readBearerToken(req.headers);
    const input = await readJsonBody<HeartbeatCliRequest>(req);
    if (!token || !input?.cliRunId || !input.registrationId) {
      writeJson(res, token ? 400 : 401, { error: token ? "Invalid heartbeat payload" : "Unauthorized" });
      return;
    }
    const result = observability.heartbeat(token, input.cliRunId, input.registrationId);
    if (!result) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    writeJson(res, 200, result);
  }

  async function handleCliDeregister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const token = readBearerToken(req.headers);
    const input = await readJsonBody<DeregisterCliRequest>(req);
    if (!token || !input?.cliRunId || !input.registrationId) {
      writeJson(res, token ? 400 : 401, { error: token ? "Invalid deregister payload" : "Unauthorized" });
      return;
    }
    writeJson(res, 200, {
      accepted: observability.deregister(token, input.cliRunId, input.registrationId),
    });
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
    const body = await readJsonBody<{ readonly registrationId?: string; readonly cliRunId?: string; readonly sessionId?: string; readonly kind?: string }>(req);
    const kind = body?.kind === "shell" ? "shell" : "fleet";
    const sessionId = kind === "shell"
      ? SHELL_TERMINAL_SESSION_ID
      : typeof body?.sessionId === "string" && body.sessionId.length > 0
        ? body.sessionId
        : DEFAULT_TERMINAL_SESSION_ID;
    if (!terminalSessions.canAttach(sessionId)) {
      writeJson(res, 503, { error: "Terminal session capacity exhausted" });
      return;
    }
    writeJson(res, 200, terminalTickets.issue({
      cwd: kind === "shell" ? "" : observability.getLaunchCwd(body?.registrationId, body?.cliRunId),
      sessionId,
      kind,
    }));
  }

  async function handleTerminalFolderPick(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    const result = await pickTerminalFolder();
    if (result.kind === "cancelled") {
      writeJson(res, 200, { cancelled: true });
      return;
    }
    if (result.kind === "error") {
      writeJson(res, result.error === "invalid_folder" ? 400 : 503, { error: result.error });
      return;
    }
    writeJson(res, 200, { folderGrantId: folderGrants.issue(result.cwd) });
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
    const body = await readJsonBody<{ readonly folderGrantId?: unknown; readonly cwd?: unknown }>(req);
    if (!body || typeof body.folderGrantId !== "string" || "cwd" in body) {
      writeJson(res, 400, { error: "invalid_folder_grant" });
      return;
    }
    const cwd = folderGrants.consume(body.folderGrantId);
    if (!cwd) {
      writeJson(res, 400, { error: "invalid_folder_grant" });
      return;
    }
    await createTerminalSessionForCwd(cwd, res);
  }

  function handleTerminalSessionItem(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
    if (req.method !== "DELETE") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!isTerminalAuthorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    // 운영자 X 버튼 종료 — PTY 자식을 끝내고(멱등) 콘솔 세션 목록에서도 제거한다. 이미 종료된 세션이어도 200으로 멱등 처리한다.
    terminalSessions.terminate(sessionId);
    observability.removeTerminalSession(sessionId);
    writeJson(res, 200, { ok: true });
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
    const result = await pickTerminalFolder();
    if (result.kind === "cancelled") {
      writeJson(res, 200, { cancelled: true });
      return;
    }
    if (result.kind === "error") {
      writeJson(res, result.error === "invalid_folder" ? 400 : 503, { error: result.error });
      return;
    }
    const theater = await theaters.register(result.cwd);
    let hasWiki = false;
    try {
      await codex.registerWorkspace(result.cwd);
      hasWiki = true;
    } catch (error) {
      if (!(error instanceof Error && error.message === "knowledge_root_missing")) {
        console.warn(`[fleet-console] Codex workspace registration skipped for Theater ${theater.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    writeJson(res, 200, toTheaterInfo(theater, hasWiki));
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
    await createTerminalSessionForCwd(theater.path, res);
  }

  async function createTerminalSessionForCwd(cwd: string, res: http.ServerResponse): Promise<void> {
    const sessionId = crypto.randomUUID();
    const session = observability.createPendingTerminalSession({ sessionId, cwd });
    try {
      terminalSessions.createSession({ sessionId, cwd });
      const created = observability.updateTerminalSessionStatus(sessionId, "terminal-only") ?? session;
      writeJson(res, 200, created);
    } catch (error) {
      observability.updateTerminalSessionStatus(sessionId, "error");
      writeJson(res, 503, { error: error instanceof Error ? error.message : "terminal_unavailable" });
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

  function toTheaterInfo(theater: TheaterRegistration, hasWiki: boolean): ConsoleTheaterInfo {
    return {
      id: theater.id,
      label: theater.label,
      createdAt: theater.registeredAt,
      lastOpenedAt: theater.lastOpenedAt,
      hasWiki,
      activeAdmiralCount: observability.listWorkspaces()
        .filter((workspace) => workspace.theaterId === theater.id && workspace.status !== "deregistered")
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

  return {
    host,
    port,
    async start(lockPaths) {
      if (server && lockHandle) return lockHandle.payload.endpoint;
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
            srv.close();
            server = null;
            loopbackServer = null;
            reject(err);
          }
        });
      });
      if (!activeEndpoint) throw new Error("Console endpoint unavailable");
      return activeEndpoint;
    },
    async stop() {
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
      observability.clear();
      terminalUpgrade.close();
      terminalSessions.stop();
      currentLock?.release();
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
