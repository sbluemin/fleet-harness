import http from "node:http";

import { readBearerToken } from "./auth.js";
import type { GatewayHealth, GatewayRegisterTenantRequest, GatewayToolCallResult } from "./api-types.js";
import { createGatewayCallQueue } from "./call-queue.js";
import { writeGatewayCallEvent } from "./call-stream.js";
import { createGatewayLock, type GatewayLockHandle } from "./lock.js";
import { createGatewayMcpJsonRpcRouter } from "./mcp-jsonrpc.js";
import { writeObserverEvents } from "./observability-routes.js";
import { createGatewayObservabilityStore } from "./observability-store.js";
import { createGatewayTenantStore } from "./tenant-store.js";

declare const __PKG_VERSION__: string | undefined;

export interface GatewayServerDeps {
  readonly host?: string;
  readonly port?: number;
  readonly endpointPath?: string;
  readonly version?: string;
}

export interface GatewayServer {
  readonly host: string;
  readonly port: number;
  readonly endpointPath: string;
  start(lockPaths: { dir: string; lockFile: string }): Promise<string>;
  stop(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 37283;
const DEFAULT_ENDPOINT_PATH = "/mcp";
const SERVER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

export function createGatewayServer(deps: GatewayServerDeps = {}): GatewayServer {
  const host = deps.host ?? DEFAULT_HOST;
  const port = deps.port ?? DEFAULT_PORT;
  const endpointPath = deps.endpointPath ?? DEFAULT_ENDPOINT_PATH;
  const version = deps.version ?? (typeof __PKG_VERSION__ === "string" ? __PKG_VERSION__ : "0.0.0-dev");
  const lock = createGatewayLock({ hostname: () => host });
  const tenants = createGatewayTenantStore();
  const callQueue = createGatewayCallQueue();
  const observability = createGatewayObservabilityStore();
  const mcpRouter = createGatewayMcpJsonRpcRouter({ callQueue, serverInfo: { name: "fleet-gateway", version } });
  let server: http.Server | null = null;
  let lockHandle: GatewayLockHandle | null = null;
  let activeEndpoint: string | null = null;

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === "/health") {
      handleHealth(req, res);
      return;
    }
    if (req.url === "/admin/register") {
      void handleRegister(req, res);
      return;
    }
    if (req.url === "/control/calls") {
      void handleCallStream(req, res);
      return;
    }
    if (req.url?.startsWith("/control/results/")) {
      void handleResultSubmission(req, res);
      return;
    }
    if (req.url === "/control/release") {
      void handleControlRelease(req, res);
      return;
    }
    if (req.url === "/control/events") {
      void handleControlEvent(req, res);
      return;
    }
    if (req.url === "/observer/status") {
      handleObserverStatus(req, res);
      return;
    }
    if (req.url === "/observer/jobs") {
      handleObserverJobs(req, res);
      return;
    }
    if (req.url === "/observer/events") {
      handleObserverEvents(req, res);
      return;
    }
    if (req.url === endpointPath) {
      void handleMcp(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  }

  function handleHealth(req: http.IncomingMessage, res: http.ServerResponse): void {
    const handle = lockHandle;
    const token = handle?.payload.token;
    if (!handle || !token || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const payload = handle.payload;
    const body: GatewayHealth = {
      ok: true,
      pid: payload.pid,
      host: payload.host,
      port: payload.port,
      endpoint: payload.endpoint,
      startedAt: payload.startedAt,
      version: payload.version,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async function handleRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
    const input = await readJsonBody<GatewayRegisterTenantRequest>(req);
    if (!input?.tenantLabel || !input.cwd || !Array.isArray(input.tools)) {
      writeJson(res, 400, { error: "Invalid registration payload" });
      return;
    }
    writeJson(res, 200, tenants.registerTenant(input, handle.payload.endpoint));
  }

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const token = readBearerToken(req.headers);
    const lookup = token ? tenants.lookupToken(token) : null;
    if (!lookup || lookup.kind !== "session" || !lookup.session) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const request = await readJsonBody<Parameters<typeof mcpRouter.process>[0]>(req);
    if (!request) {
      writeJson(res, 400, { error: "Invalid JSON-RPC payload" });
      return;
    }
    const isHeldToolCall = request.method === "tools/call";
    if (isHeldToolCall) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders();
    }
    const keepalive = isHeldToolCall ? setInterval(() => {
      if (!res.writableEnded) res.write(" ");
    }, 60_000) : null;
    try {
      const payload = await mcpRouter.process(request, lookup.session);
      if (keepalive) clearInterval(keepalive);
      if (payload === null) {
        if (!res.headersSent) res.writeHead(204);
        res.end();
        return;
      }
      if (res.headersSent) {
        res.end(JSON.stringify(payload));
        return;
      }
      writeJson(res, 200, payload);
    } catch (err) {
      if (keepalive) clearInterval(keepalive);
      const body = { error: err instanceof Error ? err.message : String(err) };
      if (res.headersSent) {
        res.end(JSON.stringify(body));
        return;
      }
      writeJson(res, 500, body);
    }
  }

  async function handleCallStream(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const token = readBearerToken(req.headers);
    const lookup = token ? tenants.lookupToken(token) : null;
    if (!lookup || lookup.kind !== "control") {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), 30_000);
    req.on("close", () => clearInterval(keepalive));
    for (const session of lookup.tenant.sessions.values()) {
      void streamSessionCalls(session.sessionId, res);
    }
  }

  async function streamSessionCalls(sessionId: string, res: http.ServerResponse): Promise<void> {
    while (!res.writableEnded) {
      const call = await callQueue.waitForNext(sessionId);
      if (res.writableEnded) return;
      writeGatewayCallEvent(res, call);
    }
  }

  async function handleResultSubmission(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const token = readBearerToken(req.headers);
    const lookup = token ? tenants.lookupToken(token) : null;
    if (!lookup || lookup.kind !== "control") {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const callId = req.url?.split("/").pop() ?? "";
    const body = await readJsonBody<{ sessionId?: string; result?: GatewayToolCallResult }>(req);
    if (!body?.sessionId || !body.result) {
      writeJson(res, 400, { error: "Invalid result payload" });
      return;
    }
    if (!lookup.tenant.sessions.has(body.sessionId)) {
      writeJson(res, 403, { error: "Forbidden" });
      return;
    }
    if (!callQueue.resolveCall(body.sessionId, callId, body.result)) {
      writeJson(res, 404, { error: "Call not found" });
      return;
    }
    writeJson(res, 200, { ok: true });
  }

  async function handleControlRelease(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const token = readBearerToken(req.headers);
    const release = token ? tenants.releaseTenant(token) : null;
    if (!release) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    for (const sessionId of release.sessionIds) {
      callQueue.clearSession(sessionId);
    }
    writeJson(res, 200, { ok: true });
  }

  async function handleControlEvent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const token = readBearerToken(req.headers);
    const lookup = token ? tenants.lookupToken(token) : null;
    if (!lookup || lookup.kind !== "control") {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const body = await readJsonBody<{ event?: unknown }>(req);
    if (!body || !("event" in body)) {
      writeJson(res, 400, { error: "Invalid event payload" });
      return;
    }
    writeJson(res, 200, { ok: true, event: observability.append(lookup.tenant.tenantId, body.event) });
  }

  function handleObserverStatus(req: http.IncomingMessage, res: http.ServerResponse): void {
    const lookup = readObserverLookup(req, res);
    if (!lookup) return;
    writeJson(res, 200, {
      tenantId: lookup.tenant.tenantId,
      tenantLabel: lookup.tenant.tenantLabel,
      sessions: lookup.tenant.sessions.size,
      jobs: observability.listJobs(lookup.tenant.tenantId).length,
      events: observability.listEvents(lookup.tenant.tenantId).length,
    });
  }

  function handleObserverJobs(req: http.IncomingMessage, res: http.ServerResponse): void {
    const lookup = readObserverLookup(req, res);
    if (!lookup) return;
    writeJson(res, 200, { jobs: observability.listJobs(lookup.tenant.tenantId) });
  }

  function handleObserverEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    const lookup = readObserverLookup(req, res);
    if (!lookup) return;
    writeObserverEvents(req, res, lookup.tenant, observability);
  }

  function readObserverLookup(req: http.IncomingMessage, res: http.ServerResponse) {
    const token = readBearerToken(req.headers);
    const lookup = token ? tenants.lookupToken(token) : null;
    if (!lookup || lookup.kind !== "observer") {
      writeJson(res, 401, { error: "Unauthorized" });
      return null;
    }
    return lookup;
  }

  return {
    host,
    port,
    endpointPath,
    async start(lockPaths) {
      if (server && lockHandle) return lockHandle.payload.endpoint;
      await new Promise<void>((resolve, reject) => {
        const srv = http.createServer(handleRequest);
        srv.timeout = SERVER_TIMEOUT_MS;
        srv.keepAliveTimeout = SERVER_TIMEOUT_MS;
        srv.headersTimeout = SERVER_TIMEOUT_MS + 1000;
        srv.once("error", reject);
        srv.listen(port, host, () => {
          srv.off("error", reject);
          server = srv;
          const address = srv.address();
          const actualPort = typeof address === "object" && address ? address.port : port;
          const endpoint = `http://${host}:${actualPort}${endpointPath}`;
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
      if (!activeEndpoint) throw new Error("Gateway endpoint unavailable");
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
      callQueue.clear();
      tenants.clear();
      observability.clear();
      currentLock?.release();
    },
  };
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
