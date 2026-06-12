import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type http from "node:http";

import { withSecurityHeaders } from "./security-headers.js";

const CONSOLE_ROOT = fileURLToPath(new URL("../dist/client/", import.meta.url));
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
} as const;

export function tryServeStaticConsole(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  if (pathname !== "/console" && !pathname.startsWith("/console/")) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, withSecurityHeaders({ Allow: "GET, HEAD", "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }
  const relativePath = resolveConsolePath(pathname);
  if (!relativePath) {
    // /console 하위의 무효 경로(NUL, 깨진 percent-인코딩)도 이 핸들러가 보안 헤더와 함께 응답한다.
    res.writeHead(404, withSecurityHeaders({ "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "Not found" }));
    return true;
  }
  const absolutePath = path.resolve(CONSOLE_ROOT, relativePath);
  if (!absolutePath.startsWith(CONSOLE_ROOT)) {
    res.writeHead(404, withSecurityHeaders({ "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "Not found" }));
    return true;
  }
  try {
    const data = fs.readFileSync(absolutePath);
    const contentType = MIME_TYPES[path.extname(absolutePath)] ?? "application/octet-stream";
    res.writeHead(200, withSecurityHeaders({ "Content-Type": contentType }));
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    res.end(data);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    res.writeHead(404, withSecurityHeaders({ "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "Not found" }));
    return true;
  }
}

function resolveConsolePath(pathname: string): string | null {
  if (pathname === "/console" || pathname === "/console/") return "index.html";
  if (!pathname.startsWith("/console/")) return null;
  let withoutPrefix: string;
  try {
    withoutPrefix = decodeURIComponent(pathname.slice("/console/".length));
  } catch {
    // 깨진 percent-인코딩은 데몬을 죽이지 않고 404로 흡수한다.
    return null;
  }
  if (withoutPrefix === "") return "index.html";
  if (withoutPrefix.includes("\0")) return null;
  if (!path.extname(withoutPrefix)) return "index.html";
  return withoutPrefix;
}
