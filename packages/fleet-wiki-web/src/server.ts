import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeLockFile } from "./lock.js";
import { resolveWorkspaceMemoryPaths } from "./paths.js";
import { handleApiRequest } from "./routes.js";

interface ServerArgs {
  cwd: string;
  lockPath: string;
  port: number;
}

const VERSION = "0.0.0";
const HOST = "127.0.0.1";
const CLIENT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "client");
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export async function startFleetWikiServer(args: ServerArgs): Promise<Server> {
  const cwd = path.resolve(args.cwd);
  const paths = resolveWorkspaceMemoryPaths(cwd);
  const server = createServer(async (request, response) => {
    try {
      if (!ALLOWED_METHODS.has(request.method ?? "")) {
        sendMethodNotAllowed(response);
        return;
      }
      // port는 listen 이후에 확정되므로 클로저로 지연 접근
      const context = {
        cwd,
        knowledgeRoot: paths.root,
        paths,
        version: VERSION,
        get port(): number {
          const address = server.address();
          return typeof address === "object" && address ? address.port : 0;
        },
      };
      if (await handleApiRequest(request, response, context)) return;
      await serveStatic(request.url ?? "/", response);
    } catch {
      sendJson(response, 400, { error: "bad request" });
    }
  });
  const port = await listenOnAvailablePort(server, args.port);

  await writeLockFile(args.lockPath, {
    pid: process.pid,
    port,
    cwd,
    startedAt: new Date().toISOString(),
  });
  return server;
}

async function serveStatic(requestUrl: string, response: ServerResponse): Promise<void> {
  const url = new URL(requestUrl, `http://${HOST}`);
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
    response.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    });
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
  if (pathname.startsWith("/assets/")) return false;
  if (pathname.startsWith("/entry/") || pathname.startsWith("/raw/")) return true;
  return path.extname(pathname) === "";
}

async function serveSpaIndex(response: ServerResponse): Promise<void> {
  const indexPath = path.join(CLIENT_ROOT, "index.html");
  try {
    const indexStat = await stat(indexPath);
    if (!indexStat.isFile()) throw new Error("not a file");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    createReadStream(indexPath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "not_found" });
  }
}

async function listenOnAvailablePort(server: Server, startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port += 1) {
    const actualPort = await tryListen(server, port);
    if (actualPort !== null) return actualPort;
  }
  throw new Error(`사용 가능한 포트를 찾을 수 없습니다: ${startPort}-${startPort + 99}`);
}

async function tryListen(server: Server, port: number): Promise<number | null> {
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
    server.listen(port, HOST);
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendMethodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, {
    allow: "GET, HEAD, POST",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ error: "method_not_allowed" }));
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Fleet Wiki server rejection:", reason);
});

function parseServerArgs(argv: string[]): ServerArgs {
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startFleetWikiServer(parseServerArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
