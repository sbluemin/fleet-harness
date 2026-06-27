import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { FileReadError, readFileForTheater } from "./file-reader.js";
import { FolderBrowserError, listTheaterContents } from "./folder-browser.js";
import { ImageServeError, readImageForTheater, writeImageResponse } from "./image-server.js";

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
  if (!isPlainObject(body) && body !== null) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const rawTheaterId = (body as Record<string, unknown> | null)?.theaterId;
  if (typeof rawTheaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const rawRel = (body as Record<string, unknown> | null)?.relativePath;
  const relPath = rawRel === undefined || rawRel === null ? "" : typeof rawRel === "string" ? rawRel : null;
  if (relPath === null) { ctx.host.http.writeJson(res, 400, { error: "invalid_path" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(rawTheaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    const result = await listTheaterContents(theaterPath, relPath);
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
