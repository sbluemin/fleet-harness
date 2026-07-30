import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

import type { ConsoleThemeId } from "./console-settings.js";
import { withSecurityHeaders } from "./security-headers.js";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
} as const;

export type StaticConsoleHandler = (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => boolean;

export function createStaticConsoleHandler(
  packageRoot: string,
  deps?: { readonly getActiveTheme?: () => ConsoleThemeId },
): StaticConsoleHandler {
  const consoleRoot = path.join(packageRoot, "dist", "client");
  return (req, res, pathname) => tryServeStaticConsole(req, res, pathname, consoleRoot, deps?.getActiveTheme);
}

function tryServeStaticConsole(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  consoleRoot: string,
  getActiveTheme?: () => ConsoleThemeId,
): boolean {
  if (pathname !== "/console" && !pathname.startsWith("/console/")) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, withSecurityHeaders({ Allow: "GET, HEAD", "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }
  const relativePath = resolveConsolePath(pathname);
  if (!relativePath) {
    res.writeHead(404, withSecurityHeaders({ "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "Not found" }));
    return true;
  }
  const absolutePath = path.resolve(consoleRoot, relativePath);
  if (!absolutePath.startsWith(consoleRoot)) {
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
    res.end(contentType === MIME_TYPES[".html"] ? injectActiveTheme(data.toString("utf8"), getActiveTheme) : data);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    if (pathname.startsWith("/console/")) {
      return serveFallbackIndex(req, res, consoleRoot, getActiveTheme);
    }
    res.writeHead(404, withSecurityHeaders({ "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "Not found" }));
    return true;
  }
}

function serveFallbackIndex(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  consoleRoot: string,
  getActiveTheme?: () => ConsoleThemeId,
): boolean {
  try {
    const data = fs.readFileSync(path.join(consoleRoot, "index.html"));
    res.writeHead(200, withSecurityHeaders({ "Content-Type": MIME_TYPES[".html"] }));
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    res.end(injectActiveTheme(data.toString("utf8"), getActiveTheme));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    res.writeHead(404, withSecurityHeaders({ "Content-Type": "application/json" }));
    res.end(JSON.stringify({ error: "Not found" }));
    return true;
  }
}

function injectActiveTheme(html: string, getActiveTheme?: () => ConsoleThemeId): string {
  if (!getActiveTheme) return html;
  const theme = getActiveTheme();
  if (theme !== "instrument" && theme !== "maritime" && theme !== "carbon" && theme !== "whites") {
    return html;
  }
  return html.replace('data-theme="instrument"', `data-theme="${theme}" data-theme-source="server"`);
}

function resolveConsolePath(pathname: string): string | null {
  if (pathname === "/console" || pathname === "/console/") return "index.html";
  if (!pathname.startsWith("/console/")) return null;
  let withoutPrefix: string;
  try {
    withoutPrefix = decodeURIComponent(pathname.slice("/console/".length));
  } catch {
    return null;
  }
  if (withoutPrefix === "") return "index.html";
  if (withoutPrefix.includes("\0")) return null;
  if (!path.extname(withoutPrefix)) return "index.html";
  return withoutPrefix;
}
