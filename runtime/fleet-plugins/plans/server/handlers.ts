import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { PlanStoreError, isValidPlanName, listPlansForTheater, readPlanForTheater } from "./plan-store.js";

export async function handlePlansList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown }>(req);
  if (!isPlainObject(body) || typeof body.theaterId !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    const plans = await listPlansForTheater(theaterPath);
    ctx.host.http.writeJson(res, 200, { plans });
  } catch (error) {
    writePlanStoreError(res, ctx, error);
  }
}

export async function handlePlansRead(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly name?: unknown }>(req);
  if (!isPlainObject(body) || typeof body.theaterId !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  if (typeof body.name !== "string" || !isValidPlanName(body.name)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_name" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    const plan = await readPlanForTheater(theaterPath, body.name);
    ctx.host.http.writeJson(res, 200, plan);
  } catch (error) {
    writePlanStoreError(res, ctx, error);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writePlanStoreError(res: http.ServerResponse, ctx: FleetPluginServerContext, error: unknown): void {
  if (!(error instanceof PlanStoreError)) throw error;

  const httpStatus = error.code === "path_outside_theater" ? 403 : error.code === "too_large" ? 413 : 404;
  ctx.host.http.writeJson(res, httpStatus, { error: error.code });
}
