import http from "node:http";

import type { GatewayHealth } from "./api-types.js";
import { createGatewayLock, type GatewayLockHandle } from "./lock.js";

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

export function createGatewayServer(deps: GatewayServerDeps = {}): GatewayServer {
  const host = deps.host ?? DEFAULT_HOST;
  const port = deps.port ?? DEFAULT_PORT;
  const endpointPath = deps.endpointPath ?? DEFAULT_ENDPOINT_PATH;
  const version = deps.version ?? (typeof __PKG_VERSION__ === "string" ? __PKG_VERSION__ : "0.0.0-dev");
  const lock = createGatewayLock();
  let server: http.Server | null = null;
  let lockHandle: GatewayLockHandle | null = null;

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === "/health") {
      handleHealth(req, res);
      return;
    }
    if (req.url === endpointPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "MCP router not initialized" }));
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

  return {
    host,
    port,
    endpointPath,
    async start(lockPaths) {
      if (server && lockHandle) return lockHandle.payload.endpoint;
      const endpoint = `http://${host}:${port}${endpointPath}`;
      await new Promise<void>((resolve, reject) => {
        const srv = http.createServer(handleRequest);
        srv.timeout = SERVER_TIMEOUT_MS;
        srv.keepAliveTimeout = SERVER_TIMEOUT_MS;
        srv.headersTimeout = SERVER_TIMEOUT_MS + 1000;
        srv.once("error", reject);
        srv.listen(port, host, () => {
          srv.off("error", reject);
          server = srv;
          try {
            lockHandle = lock.writeLock({ dir: lockPaths.dir, lockFile: lockPaths.lockFile, pid: process.pid, port, endpoint, version });
            resolve();
          } catch (err) {
            srv.close();
            server = null;
            reject(err);
          }
        });
      });
      return endpoint;
    },
    async stop() {
      const current = server;
      const currentLock = lockHandle;
      server = null;
      lockHandle = null;
      await new Promise<void>((resolve) => {
        if (!current) {
          resolve();
          return;
        }
        current.close(() => resolve());
        current.closeAllConnections?.();
      });
      currentLock?.release();
    },
  };
}
