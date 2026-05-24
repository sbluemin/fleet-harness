import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
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

const VERSION = "0.0.0";
const DAEMON_HOST = "127.0.0.1";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolveClientRoot(MODULE_DIR);
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

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

export async function startFleetWikiServer(args: ServerArgs): Promise<Server> {
  const cwd = path.resolve(args.cwd);
  if (args.host !== undefined && args.host !== DAEMON_HOST) {
    throw new Error(`Fleet Wiki daemon host is fixed to ${DAEMON_HOST}`);
  }
  process.chdir(cwd);
  const host = DAEMON_HOST;
  const token = createDaemonToken();
  const workspaces = new WorkspaceRegistry();
  const initialWorkspace = await workspaces.register(cwd);
  const server = createServer(async (request, response) => {
    try {
      if (!ALLOWED_METHODS.has(request.method ?? "")) {
        sendMethodNotAllowed(response);
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
        get port(): number {
          const address = server.address();
          return typeof address === "object" && address ? address.port : 0;
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
  });
  const port = await listenOnAvailablePort(server, args.port, host);

  process.stderr.write(`[fleet-wiki-ui] listening cwd=${cwd} host=${host} port=${port}\n`);

  try {
    await acquireLockFile(args.lockPath, {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      host,
      token,
    });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return server;
}

type WorkspaceSelection =
  | { kind: "workspace"; workspace: WorkspaceRegistration | null; rewrittenUrl?: string }
  | { kind: "redirect"; location: string }
  | { kind: "no-workspace" };

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

async function listenOnAvailablePort(server: Server, startPort: number, host: string): Promise<number> {
  for (let port = startPort; port < startPort + 100; port += 1) {
    const actualPort = await tryListen(server, port, host);
    if (actualPort !== null) return actualPort;
  }
  throw new Error(`사용 가능한 포트를 찾을 수 없습니다: ${startPort}-${startPort + 99}`);
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
  assertKnownFlags(argv, new Set(["--cwd", "--lock", "--port"]));
  const cwd = readFlag(argv, "--cwd");
  const lockPath = readFlag(argv, "--lock");
  const port = Number(readFlag(argv, "--port"));
  if (!cwd || !lockPath || !Number.isInteger(port)) {
    throw new Error("server requires --cwd, --lock, and --port");
  }
  return { cwd, lockPath, port };
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
