import type http from "node:http";

import { PlanStoreError, isValidPlanName, listPlansForTheater, readPlanForTheater } from "./plan-store.js";

export interface PlansRouteDeps {
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly resolveTheaterPath: (theaterId: string) => string | null;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

interface PlansRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

interface PlansListBody {
  readonly theaterId?: unknown;
}

interface PlansReadBody extends PlansListBody {
  readonly name?: unknown;
}

export function createPlansRouter(deps: PlansRouteDeps): (context: PlansRouteContext) => Promise<boolean> {
  return async function handlePlansRoute(context: PlansRouteContext): Promise<boolean> {
    const { req, res, pathname } = context;
    if (pathname === "/api/v1/plans/list") {
      await handlePlansList(req, res, deps);
      return true;
    }
    if (pathname === "/api/v1/plans/read") {
      await handlePlansRead(req, res, deps);
      return true;
    }
    return false;
  };
}

async function handlePlansList(req: http.IncomingMessage, res: http.ServerResponse, deps: PlansRouteDeps): Promise<void> {
  if (req.method !== "POST") {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const body = await deps.readJsonBody<PlansListBody>(req);
  if (!isPlainObject(body) || typeof body.theaterId !== "string") {
    deps.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  const theaterPath = deps.resolveTheaterPath(body.theaterId);
  if (!theaterPath) {
    deps.writeJson(res, 404, { error: "theater_not_found" });
    return;
  }
  try {
    deps.writeJson(res, 200, { plans: await listPlansForTheater(theaterPath) });
  } catch (error) {
    writePlanStoreError(res, deps, error);
  }
}

async function handlePlansRead(req: http.IncomingMessage, res: http.ServerResponse, deps: PlansRouteDeps): Promise<void> {
  if (req.method !== "POST") {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const body = await deps.readJsonBody<PlansReadBody>(req);
  if (!isPlainObject(body) || typeof body.theaterId !== "string") {
    deps.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  if (typeof body.name !== "string" || !isValidPlanName(body.name)) {
    deps.writeJson(res, 400, { error: "invalid_name" });
    return;
  }
  const theaterPath = deps.resolveTheaterPath(body.theaterId);
  if (!theaterPath) {
    deps.writeJson(res, 404, { error: "theater_not_found" });
    return;
  }
  try {
    deps.writeJson(res, 200, await readPlanForTheater(theaterPath, body.name));
  } catch (error) {
    writePlanStoreError(res, deps, error);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writePlanStoreError(res: http.ServerResponse, deps: PlansRouteDeps, error: unknown): void {
  if (!(error instanceof PlanStoreError)) throw error;
  const httpStatus = error.code === "path_outside_theater" ? 403 : error.code === "too_large" ? 413 : 404;
  deps.writeJson(res, httpStatus, { error: error.code });
}
