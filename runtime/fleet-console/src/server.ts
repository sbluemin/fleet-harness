import crypto from "node:crypto";
import http from "node:http";

import type {
  DeregisterCliRequest,
  HeartbeatCliRequest,
  PushEventsRequest,
  RegisterCliRequest,
} from "@dotobokuri/core-agent";

import { readBearerToken } from "./auth.js";
import type { ConsoleHealth, ConsoleObservedWorkspace } from "./api-types.js";
import { createConsoleLock, type ConsoleLockHandle } from "./lock.js";
import { writeAggregateObserverEvents, writeObserverEvents } from "./observability-routes.js";
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

declare const __PKG_VERSION__: string | undefined;

export interface ConsoleServerDeps {
  readonly host?: string;
  readonly port?: number;
  readonly version?: string;
  readonly terminalLaunch?: TerminalLaunchResolver;
  readonly terminalStartShell?: typeof startTerminalShell;
  readonly terminalGraceMs?: number;
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
const DEFAULT_PORT = 37283;
const DEFAULT_TERMINAL_SESSION_ID = "default";
const SERVER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

export function createConsoleServer(deps: ConsoleServerDeps = {}): ConsoleServer {
  const host = deps.host ?? DEFAULT_HOST;
  const port = deps.port ?? DEFAULT_PORT;
  const version = deps.version ?? (typeof __PKG_VERSION__ === "string" ? __PKG_VERSION__ : "0.0.0-dev");
  const lock = createConsoleLock({ hostname: () => host });
  const observability = createConsoleObservabilityStore();
  const terminalTickets = createTerminalTicketRegistry();
  const folderGrants = createFolderGrantStore();
  const pickTerminalFolder = deps.terminalPickFolder ?? createNativeFolderPicker();
  const terminalSessions = createTerminalSessionManager({
    launch: deps.terminalLaunch ?? createDefaultTerminalLaunchResolver(),
    startShell: deps.terminalStartShell,
    graceMs: deps.terminalGraceMs,
    maxSessions: deps.maxTerminalSessions,
  });
  const terminalUpgrade = createTerminalUpgradeHandler({
    expectedHost: host,
    getExpectedPort: () => lockHandle?.payload.port ?? port,
    tickets: terminalTickets,
    sessions: terminalSessions,
    validateHost,
  });
  let server: http.Server | null = null;
  let lockHandle: ConsoleLockHandle | null = null;
  let activeEndpoint: string | null = null;

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!validateHost(req, lockHandle?.payload.port ?? port)) {
      writeJson(res, 403, { error: "host_mismatch" });
      return;
    }
    const pathname = getPathname(req);
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
    if (pathname === "/observer/status") {
      handleObserverStatus(req, res);
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
    const token = readBearerToken(req.headers);
    if (!lockHandle || token !== lockHandle.payload.terminalToken) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const body = await readJsonBody<{ readonly registrationId?: string; readonly cliRunId?: string; readonly sessionId?: string }>(req);
    const sessionId = typeof body?.sessionId === "string" && body.sessionId.length > 0 ? body.sessionId : DEFAULT_TERMINAL_SESSION_ID;
    if (!terminalSessions.canAttach(sessionId)) {
      writeJson(res, 503, { error: "Terminal session capacity exhausted" });
      return;
    }
    writeJson(res, 200, terminalTickets.issue({
      cwd: observability.getLaunchCwd(body?.registrationId, body?.cliRunId),
      sessionId,
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
    const lookup = readObserverLookup(req, res);
    if (!lookup) return;
    writeJson(res, 200, {
      workspaces: observability.listWorkspaces().length,
      jobs: observability.listWorkspaces().reduce((count, workspace) => count + observability.listJobs(workspace.tenantId).length, 0),
    });
  }

  function handleObserverWorkspaces(req: http.IncomingMessage, res: http.ServerResponse): void {
    const lookup = readObserverLookup(req, res);
    if (!lookup) return;
    writeJson(res, 200, { tenants: observability.listWorkspaces() });
  }

  function handleObserverJobs(req: http.IncomingMessage, res: http.ServerResponse): void {
    const lookup = readObserverLookup(req, res);
    if (!lookup) return;
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
    const lookup = readObserverLookup(req, res);
    if (!lookup) return;
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

  function readObserverLookup(req: http.IncomingMessage, res: http.ServerResponse): ObserverLookup | null {
    const token = readBearerToken(req.headers);
    if (token && token === lockHandle?.payload.observerToken) {
      return { kind: "aggregate" };
    }
    writeJson(res, 401, { error: "Unauthorized" });
    return null;
  }

  function isTerminalAuthorized(req: http.IncomingMessage): boolean {
    const token = readBearerToken(req.headers);
    return Boolean(lockHandle && token === lockHandle.payload.terminalToken);
  }

  function listVisibleWorkspaces(requestedTenantId: string | null): readonly ConsoleObservedWorkspace[] {
    if (requestedTenantId) {
      const workspace = observability.getWorkspace(requestedTenantId);
      return workspace ? [workspace] : [];
    }
    return observability.listWorkspaces();
  }

  return {
    host,
    port,
    async start(lockPaths) {
      if (server && lockHandle) return lockHandle.payload.endpoint;
      await new Promise<void>((resolve, reject) => {
        const srv = http.createServer(handleRequest);
        srv.timeout = SERVER_TIMEOUT_MS;
        srv.keepAliveTimeout = SERVER_TIMEOUT_MS;
        srv.headersTimeout = SERVER_TIMEOUT_MS + 1000;
        srv.on("upgrade", (req, socket, head) => {
          if (!terminalUpgrade.handleUpgrade(req, socket, head)) socket.destroy();
        });
        srv.once("error", reject);
        srv.listen(port, host, () => {
          srv.off("error", reject);
          server = srv;
          const address = srv.address();
          const actualPort = typeof address === "object" && address ? address.port : port;
          const endpoint = `http://${host}:${actualPort}/`;
          try {
            lockHandle = lock.writeLock({ dir: lockPaths.dir, lockFile: lockPaths.lockFile, pid: process.pid, port: actualPort, endpoint, version });
            activeEndpoint = endpoint;
            resolve();
          } catch (err) {
            srv.close();
            server = null;
            reject(err);
          }
        });
      });
      if (!activeEndpoint) throw new Error("Console endpoint unavailable");
      return activeEndpoint;
    },
    async stop() {
      const current = server;
      const currentLock = lockHandle;
      server = null;
      lockHandle = null;
      activeEndpoint = null;
      await new Promise<void>((resolve) => {
        if (!current) {
          resolve();
          return;
        }
        current.close(() => resolve());
        current.closeAllConnections?.();
      });
      observability.clear();
      terminalUpgrade.close();
      terminalSessions.stop();
      currentLock?.release();
    },
  };
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

function validateHost(req: http.IncomingMessage, expectedPort: number): boolean {
  if (req.url?.startsWith("http://") || req.url?.startsWith("https://")) return false;
  const hostHeaderCount = req.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === "host").length;
  if (hostHeaderCount !== 1) return false;
  const hostHeader = req.headers.host;
  if (!hostHeader) return false;
  return hostHeader === `127.0.0.1:${expectedPort}`;
}
