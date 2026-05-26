import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import os from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireLockFile, createDaemonToken } from "./lock.js";
import { handleApiRequest } from "./routes.js";
import { withSecurityHeaders } from "./security-headers.js";
import { WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceRegistration } from "./workspaces.js";

interface ServerArgs {
  cwd: string;
  lockPath: string;
  port: number;
  host?: string;
}

export interface AllowedAccessSets {
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  externalMode: boolean;
}

interface ParsedHostHeader {
  host: string;
  port: number;
}

interface ListenGroup {
  all: Server[];
  hosts: string[];
  port: number;
  primary: Server;
}

type WorkspaceSelection =
  | { kind: "workspace"; workspace: WorkspaceRegistration | null; rewrittenUrl?: string }
  | { kind: "redirect"; location: string }
  | { kind: "no-workspace" };

type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;
type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

const VERSION = "0.0.0";
const DAEMON_HOST = "127.0.0.1";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolveClientRoot(MODULE_DIR);
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);
const LOOPBACK_ACCESS_HOSTS = ["127.0.0.1", "::1"];
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export async function startFleetWikiServer(args: ServerArgs): Promise<Server> {
  const cwd = path.resolve(args.cwd);
  process.chdir(cwd);
  const host = args.host ?? DAEMON_HOST;
  const token = createDaemonToken();
  const workspaces = new WorkspaceRegistry();
  const initialWorkspace = await workspaces.register(cwd);
  let accessSets: AllowedAccessSets | null = null;
  let actualPort = 0;
  const handler: RequestHandler = async (request, response) => {
    try {
      if (!ALLOWED_METHODS.has(request.method ?? "")) {
        sendMethodNotAllowed(response);
        return;
      }
      if (!accessSets || !isHostAllowed(request.rawHeaders, request.url ?? "/", accessSets.allowedHosts, actualPort)) {
        sendJson(response, 403, { error: "host_mismatch" });
        return;
      }
      const selected = selectWorkspace(request.url ?? "/", workspaces);
      if (selected.kind === "redirect") {
        redirect(response, selected.location);
        return;
      }
      if (selected.kind === "no-workspace") {
        if (isJsonRequest(request)) {
          sendJson(response, 404, { error: "no_workspace_registered" });
          return;
        }
        redirect(response, "/");
        return;
      }
      const workspace = selected.workspace ?? initialWorkspace;
      const originalUrl = request.url;
      if (selected.rewrittenUrl) request.url = selected.rewrittenUrl;
      const context = {
        cwd: workspace.cwd,
        knowledgeRoot: workspace.paths.root,
        paths: workspace.paths,
        version: VERSION,
        host,
        workspaceId: workspace.id,
        workspaces,
        adminToken: token,
        allowedOrigins: accessSets.allowedOrigins,
        externalMode: accessSets.externalMode,
        get port(): number {
          return actualPort;
        },
      };
      if (await handleApiRequest(request, response, context)) {
        request.url = originalUrl;
        return;
      }
      request.url = originalUrl;
      await serveStatic(request.url ?? "/", response);
    } catch {
      sendJson(response, 400, { error: "bad request" });
    }
  };
  const listenGroup = await listenOnAvailablePort(handler, args.port, host);
  const server = attachCompositeClose(listenGroup);
  actualPort = listenGroup.port;
  accessSets = buildAllowedAccessSets(host, actualPort);

  process.stderr.write(`[fleet-wiki-ui] listening cwd=${cwd} host=${host} port=${actualPort}\n`);
  if (accessSets.externalMode) {
    process.stderr.write([
      "[fleet-wiki-ui] SECURITY: external bind enabled.",
      "[fleet-wiki-ui] GET/HEAD routes are LAN-readable for allowed Host values.",
      "[fleet-wiki-ui] Queue writes and admin registration remain loopback-only.",
      "[fleet-wiki-ui] Host and Origin allowlists were captured at startup; restart after NIC changes.",
    ].join("\n") + "\n");
  }

  try {
    await acquireLockFile(args.lockPath, {
      pid: process.pid,
      port: actualPort,
      startedAt: new Date().toISOString(),
      host,
      token,
    });
  } catch (error) {
    await closeServers(listenGroup.all);
    throw error;
  }
  return server;
}

export function buildAllowedAccessSets(
  host: string,
  port: number,
  interfaces: NetworkInterfaces = os.networkInterfaces(),
): AllowedAccessSets {
  const hosts = isWildcardBindHost(host)
    ? enumerateWildcardAccessHosts(interfaces)
    : isDualBindHost(host)
      ? [host, DAEMON_HOST]
      : [host];
  const allowedHosts = new Set<string>();
  const allowedOrigins = new Set<string>();
  for (const item of hosts) {
    const canonical = canonicalizeAllowedHost(item);
    if (!canonical) continue;
    allowedHosts.add(canonical);
    allowedOrigins.add(`http://${formatHostForUrl(canonical)}:${port}`);
  }
  return { allowedHosts, allowedOrigins, externalMode: !isLoopbackBindHost(host) };
}

function resolveClientRoot(moduleDir: string): string {
  const candidates = [
    path.join(moduleDir, "client"),
    path.join(moduleDir, "..", "dist", "client"),
    path.join(moduleDir, "..", "client"),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return candidates[0];
}

function selectWorkspace(requestUrl: string, workspaces: WorkspaceRegistry): WorkspaceSelection {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const prefixed = url.pathname.match(/^\/w\/([^/]+)(\/.*)?$/);
  if (prefixed) {
    const workspace = workspaces.get(decodeURIComponent(prefixed[1] ?? ""));
    if (!workspace) return { kind: "redirect", location: "/" };
    const suffix = prefixed[2] ?? "/";
    url.pathname = suffix;
    return { kind: "workspace", workspace, rewrittenUrl: `${url.pathname}${url.search}` };
  }
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname === "/api/health" || url.pathname === "/api/admin/workspaces") {
      return { kind: "workspace", workspace: workspaces.getMru() };
    }
    const workspace = workspaces.getMru();
    return workspace ? { kind: "workspace", workspace } : { kind: "no-workspace" };
  }
  const legacyTarget = legacyWorkspacePath(url);
  if (legacyTarget) {
    const workspace = workspaces.getMru();
    if (!workspace) return { kind: "redirect", location: "/" };
    return { kind: "redirect", location: `/w/${encodeURIComponent(workspace.id)}${legacyTarget}` };
  }
  return { kind: "workspace", workspace: workspaces.getMru() };
}

function isHostAllowed(rawHeaders: string[], requestUrl: string, allowedHosts: Set<string>, serverPort: number): boolean {
  if (/^https?:\/\//i.test(requestUrl)) return false;
  const hostHeaders = readRawHeaderValues(rawHeaders, "host");
  if (hostHeaders.length !== 1) return false;
  const parsed = parseHostHeader(hostHeaders[0] ?? "");
  if (!parsed || parsed.port !== serverPort) return false;
  return allowedHosts.has(parsed.host);
}

function formatHostForUrl(host: string): string {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

function canonicalizeAllowedHost(host: string): string | null {
  const unbracketed = stripIpv6Brackets(host).toLowerCase();
  if (unbracketed.includes("%")) return null;
  if (isIpv4MappedAddress(unbracketed)) return null;
  if (net.isIP(unbracketed) === 6) {
    try {
      return stripIpv6Brackets(new URL(`http://[${unbracketed}]:1`).hostname).toLowerCase();
    } catch {
      return null;
    }
  }
  return unbracketed;
}

function enumerateWildcardAccessHosts(interfaces: NetworkInterfaces): string[] {
  const hosts = [...LOOPBACK_ACCESS_HOSTS];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (net.isIP(entry.address) === 0) continue;
      hosts.push(entry.address);
    }
  }
  return hosts;
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = stripIpv6Brackets(host).toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function isDualBindHost(host: string): boolean {
  return !isLoopbackBindHost(host) && !isWildcardBindHost(host);
}

function isIpv4MappedAddress(host: string): boolean {
  return host.startsWith("::ffff:");
}

function isWildcardBindHost(host: string): boolean {
  return WILDCARD_HOSTS.has(stripIpv6Brackets(host).toLowerCase());
}

function parseHostHeader(value: string): ParsedHostHeader | null {
  if (!value || value.includes(",") || /^https?:\/\//i.test(value)) return null;
  if (value.startsWith("[")) {
    const match = value.match(/^\[([^\]]+)\]:(\d+)$/);
    if (!match) return null;
    const host = canonicalizeAllowedHost(match[1] ?? "");
    const port = Number(match[2] ?? "");
    if (!host || !Number.isInteger(port)) return null;
    return { host, port };
  }
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const host = canonicalizeAllowedHost(parts[0] ?? "");
  const port = Number(parts[1] ?? "");
  if (!host || !Number.isInteger(port)) return null;
  if (net.isIP(host) === 6) return null;
  return { host, port };
}

function readRawHeaderValues(rawHeaders: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if ((rawHeaders[index] ?? "").toLowerCase() === name) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function legacyWorkspacePath(url: URL): string | null {
  const pathname = url.pathname;
  if (
    pathname.startsWith("/entry/")
    || pathname.startsWith("/raw/")
    || pathname === "/queue"
    || pathname.startsWith("/queue/")
    || pathname === "/conflicts"
    || pathname.startsWith("/conflicts/")
    || pathname === "/index-md"
    || pathname === "/log"
  ) {
    return `${pathname}${url.search}`;
  }
  return null;
}

function isJsonRequest(request: { headers: { accept?: string | string[]; "x-requested-with"?: string | string[] } }): boolean {
  const accept = Array.isArray(request.headers.accept) ? request.headers.accept.join(",") : request.headers.accept ?? "";
  const requestedWith = Array.isArray(request.headers["x-requested-with"])
    ? request.headers["x-requested-with"].join(",")
    : request.headers["x-requested-with"] ?? "";
  return accept.includes("application/json") || requestedWith.toLowerCase() === "xmlhttprequest";
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, withSecurityHeaders({ location }));
  response.end();
}

async function serveStatic(requestUrl: string, response: ServerResponse): Promise<void> {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const relativePath = decodeURIComponent(requestPath).replace(/^\/+/, "");
  const filePath = path.resolve(CLIENT_ROOT, relativePath);
  const relativeToClient = path.relative(CLIENT_ROOT, filePath);

  if (relativeToClient.startsWith("..") || path.isAbsolute(relativeToClient)) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not a file");
    response.writeHead(200, withSecurityHeaders({
      "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    }));
    createReadStream(filePath).pipe(response);
  } catch {
    if (shouldFallbackToSpa(url.pathname)) {
      await serveSpaIndex(response);
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }
}

function shouldFallbackToSpa(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return false;
  if (pathname.match(/^\/w\/[^/]+\/api\//)) return false;
  if (pathname.startsWith("/assets/")) return false;
  if (pathname.match(/^\/w\/[^/]+\/assets\//)) return false;
  if (pathname.startsWith("/entry/") || pathname.startsWith("/raw/")) return true;
  if (pathname.match(/^\/w\/[^/]+\/(entry|raw|queue|conflicts|index-md|log)(\/|$)/)) return true;
  return path.extname(pathname) === "";
}

async function serveSpaIndex(response: ServerResponse): Promise<void> {
  const indexPath = path.join(CLIENT_ROOT, "index.html");
  try {
    const indexStat = await stat(indexPath);
    if (!indexStat.isFile()) throw new Error("not a file");
    response.writeHead(200, withSecurityHeaders({ "content-type": "text/html; charset=utf-8" }));
    createReadStream(indexPath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "not_found" });
  }
}

async function listenOnAvailablePort(handler: RequestHandler, startPort: number, host: string): Promise<ListenGroup> {
  for (let port = startPort; port < startPort + 100; port += 1) {
    const listenGroup = await tryListenGroup(handler, port, host);
    if (listenGroup !== null) return listenGroup;
  }
  throw new Error(`사용 가능한 포트를 찾을 수 없습니다: ${startPort}-${startPort + 99}`);
}

async function tryListenGroup(handler: RequestHandler, port: number, host: string): Promise<ListenGroup | null> {
  const hosts = listenHostsForBindHost(host);
  let actualPort = port;
  const servers: Server[] = [];
  try {
    for (const listenHost of hosts) {
      const server = createServer(handler);
      const listenPort = servers.length === 0 ? port : actualPort;
      const listenedPort = await tryListen(server, listenPort, listenHost);
      if (listenedPort === null) {
        await closeServers([...servers, server]);
        return null;
      }
      actualPort = listenedPort;
      servers.push(server);
    }
    return { all: servers, hosts, port: actualPort, primary: servers[0]! };
  } catch (error) {
    await closeServers(servers);
    throw error;
  }
}

async function tryListen(server: Server, port: number, host: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error & { code?: string }) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        resolve(null);
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function attachCompositeClose(listenGroup: ListenGroup): Server {
  const primary = listenGroup.primary;
  const originalClose = primary.close.bind(primary);
  primary.close = ((callback?: (err?: Error) => void): Server => {
    void closeServers(listenGroup.all, primary, originalClose).then(() => callback?.()).catch((error: Error) => callback?.(error));
    return primary;
  }) as Server["close"];
  return primary;
}

async function closeServers(servers: Server[], primary?: Server, primaryClose?: Server["close"]): Promise<void> {
  await Promise.all(servers.map((server) => closeServer(server, primary, primaryClose)));
}

function closeServer(server: Server, primary?: Server, primaryClose?: Server["close"]): Promise<void> {
  return new Promise((resolve, reject) => {
    const close = primaryClose && server === primary ? primaryClose : server.close.bind(server);
    close((error?: Error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function listenHostsForBindHost(host: string): string[] {
  return isDualBindHost(host) ? [host, DAEMON_HOST] : [host];
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, withSecurityHeaders({ "content-type": "application/json; charset=utf-8" }));
  response.end(JSON.stringify(body));
}

function sendMethodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, withSecurityHeaders({
    allow: "GET, HEAD, POST",
    "content-type": "application/json; charset=utf-8",
  }));
  response.end(JSON.stringify({ error: "method_not_allowed" }));
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Fleet Wiki server rejection:", reason);
});

function parseServerArgs(argv: string[]): ServerArgs {
  assertKnownFlags(argv, new Set(["--cwd", "--lock", "--host", "--port"]));
  const cwd = readFlag(argv, "--cwd");
  const host = readFlag(argv, "--host") ?? undefined;
  const lockPath = readFlag(argv, "--lock");
  const port = Number(readFlag(argv, "--port"));
  if (!cwd || !lockPath || !Number.isInteger(port)) {
    throw new Error("server requires --cwd, --lock, and --port");
  }
  return { cwd, host, lockPath, port };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function assertKnownFlags(argv: string[], allowed: Set<string>): void {
  for (const arg of argv) {
    if (arg.startsWith("--") && !allowed.has(arg)) {
      throw new Error(`unknown server flag: ${arg}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startFleetWikiServer(parseServerArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
