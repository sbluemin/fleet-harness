import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { ClipboardUnavailableError, copyPathToClipboard } from "./clipboard.js";
import { FileReadError, readFileForTheater } from "./file-reader.js";
import { FolderBrowserError, listTheaterContents } from "./folder-browser.js";
import { ImageServeError, readImageForTheater, writeImageResponse } from "./image-server.js";
import { PathActionError } from "./path-actions.js";
import { FileActionUnavailableError, revealPath, type FileRevealMode } from "./reveal.js";
import { watcherRegistry } from "./watcher.js";

interface ClipboardHandlerDependencies {
  readonly copyPath: typeof copyPathToClipboard;
}

interface RevealHandlerDependencies {
  readonly revealPath: typeof revealPath;
}

const DEFAULT_CLIPBOARD_DEPENDENCIES: ClipboardHandlerDependencies = { copyPath: copyPathToClipboard };
const DEFAULT_REVEAL_DEPENDENCIES: RevealHandlerDependencies = { revealPath };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

export async function handleFilesList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly relativePath?: unknown }>(req);
  if (!isPlainObject(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const rawTheaterId = body.theaterId;
  if (typeof rawTheaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const rawRel = body.relativePath;
  const relPath = rawRel === undefined || rawRel === null ? "" : typeof rawRel === "string" ? rawRel : null;
  if (relPath === null) { ctx.host.http.writeJson(res, 400, { error: "invalid_path" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(rawTheaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    const result = await listTheaterContents(theaterPath, relPath);
    await watcherRegistry.trackDirectory(rawTheaterId, theaterPath, relPath);
    ctx.host.http.writeJson(res, 200, result);
  } catch (error) {
    if (error instanceof FolderBrowserError) {
      const httpStatus = error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : 400;
      ctx.host.http.writeJson(res, httpStatus, { error: error.code });
      return;
    }
    throw error;
  }
}

export async function handleFilesRead(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly relativePath?: unknown }>(req);
  if (!isPlainObject(body) || typeof body.relativePath !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_path" }); return; }

  const theaterId = body.theaterId;
  if (typeof theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    const result = await readFileForTheater(theaterPath, body.relativePath);
    ctx.host.http.writeJson(res, 200, result);
  } catch (error) {
    if (error instanceof FileReadError) {
      const httpStatus = error.code === "path_outside_theater" || error.code === "forbidden" ? 403 : error.code === "binary_file" ? 422 : 404;
      ctx.host.http.writeJson(res, httpStatus, { error: error.code });
      return;
    }
    throw error;
  }
}

export async function handleFilesImage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const url = readUrl(req);
  const theaterId = url.searchParams.get("theaterId");
  const relPath = url.searchParams.get("path");

  if (!theaterId) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }
  if (!relPath) { ctx.host.http.writeJson(res, 400, { error: "invalid_path" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    const result = await readImageForTheater(theaterPath, relPath);
    writeImageResponse(res, result);
  } catch (error) {
    if (error instanceof ImageServeError) {
      const httpStatus = error.code === "path_outside_theater" || error.code === "mime_not_allowed" || error.code === "forbidden" ? 403 : error.code === "size_exceeded" ? 413 : 404;
      ctx.host.http.writeJson(res, httpStatus, { error: error.code });
      return;
    }
    throw error;
  }
}

export async function handleFilesClipboard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  dependencies: ClipboardHandlerDependencies = DEFAULT_CLIPBOARD_DEPENDENCIES,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly relativePath?: unknown }>(req);
  if (!isPlainObject(body) || typeof body.theaterId !== "string" || typeof body.relativePath !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    await dependencies.copyPath(theaterPath, body.relativePath);
    writeNoContent(res);
  } catch (error) {
    if (error instanceof PathActionError) {
      writePathActionError(res, ctx, error);
      return;
    }
    if (error instanceof ClipboardUnavailableError) {
      ctx.host.http.writeJson(res, 501, { error: "clipboard_unavailable" });
      return;
    }
    ctx.host.http.writeJson(res, 500, { error: "clipboard_failed" });
  }
}

export async function handleFilesReveal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  dependencies: RevealHandlerDependencies = DEFAULT_REVEAL_DEPENDENCIES,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly relativePath?: unknown;
    readonly mode?: unknown;
  }>(req);
  if (
    !isPlainObject(body)
    || typeof body.theaterId !== "string"
    || typeof body.relativePath !== "string"
    || !isFileRevealMode(body.mode)
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    await dependencies.revealPath(theaterPath, body.relativePath, body.mode);
    writeNoContent(res);
  } catch (error) {
    if (error instanceof PathActionError) {
      writePathActionError(res, ctx, error);
      return;
    }
    if (error instanceof FileActionUnavailableError) {
      ctx.host.http.writeJson(res, 501, { error: "action_unavailable" });
      return;
    }
    ctx.host.http.writeJson(res, 500, { error: "action_failed" });
  }
}

export function handleFilesWatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): void {
  if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  // EventSource는 same-origin GET — origin 헤더 미첨부여도 isTerminalAuthorized 통과
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const url = readUrl(req);
  const theaterId = url.searchParams.get("theaterId");
  if (!theaterId) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  // SSE 헤더 — 응답을 스트림으로 유지
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  function sendEvent(name: string, data: string): void {
    try {
      res.write(`event: ${name}\ndata: ${data}\n\n`);
    } catch {
      // 연결 종료 후 쓰기 시도 무시
    }
  }

  const unsubscribe = watcherRegistry.subscribe(
    theaterId,
    theaterPath,
    // 개행 포함 파일명이 SSE 필드 경계를 깨지 않도록 JSON으로 프레이밍한다
    (relDir) => sendEvent("change", JSON.stringify(relDir)),
    (state) => sendEvent("state", state),
  );

  req.on("close", () => {
    unsubscribe();
    try { res.end(); } catch { /* 이미 종료된 경우 무시 */ }
  });
}

function isFileRevealMode(value: unknown): value is FileRevealMode {
  return value === "reveal" || value === "open";
}

function writeNoContent(res: http.ServerResponse): void {
  res.statusCode = 204;
  res.end();
}

function writePathActionError(
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  error: PathActionError,
): void {
  const status = error.code === "not_found" ? 404 : 403;
  ctx.host.http.writeJson(res, status, { error: error.code });
}
