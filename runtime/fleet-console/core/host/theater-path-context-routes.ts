import type http from "node:http";

import type { TheaterRegistration } from "./theaters.js";
import { listTheaterDirectories, resolveTheaterPathContext, TheaterPathContextError } from "./theater-path-context.js";
import { listTheaterWorktrees } from "./theater-worktrees.js";

export interface TheaterPathContextRouteDeps {
  readonly getTheater: (theaterId: string) => TheaterRegistration | null;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly persist: () => void;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly setPathContext: (theaterId: string, relPath: string | null) => TheaterRegistration | null;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export interface TheaterPathContextRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

interface PutPathContextBody {
  readonly relPath?: unknown;
}

interface DirectoriesBody {
  readonly relativePath?: unknown;
}

export function createTheaterPathContextRouter(deps: TheaterPathContextRouteDeps): (context: TheaterPathContextRouteContext) => Promise<boolean> {
  return async function handleTheaterPathContextRoute({ req, res, pathname }: TheaterPathContextRouteContext): Promise<boolean> {
    const match = pathname.match(/^\/api\/v1\/theaters\/([^/]+)\/path-context(?:\/(worktrees|directories))?$/u);
    if (!match) return false;
    const theater = deps.getTheater(decodeURIComponent(match[1] ?? ""));
    if (!theater) {
      deps.writeJson(res, 400, { error: "invalid_theater" });
      return true;
    }
    const action = match[2] ?? "context";
    if (action === "context") await handleContext(req, res, theater, deps);
    else if (action === "worktrees") await handleWorktrees(req, res, theater, deps);
    else await handleDirectories(req, res, theater, deps);
    return true;
  };
}

async function handleContext(req: http.IncomingMessage, res: http.ServerResponse, theater: TheaterRegistration, deps: TheaterPathContextRouteDeps): Promise<void> {
  if (req.method === "GET") {
    await writeContext(res, theater, deps);
    return;
  }
  if (req.method !== "PUT") {
    deps.writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const body = await deps.readJsonBody<PutPathContextBody>(req);
  if (!isPlainObject(body) || !(body.relPath === null || typeof body.relPath === "string") || Object.keys(body).length !== 1) {
    deps.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  try {
    const resolved = await resolveTheaterPathContext(theater.realpath, body.relPath);
    const updated = deps.setPathContext(theater.id, resolved.relPath);
    if (!updated) {
      deps.writeJson(res, 404, { error: "theater_not_found" });
      return;
    }
    deps.persist();
    deps.writeJson(res, 200, await toContextDto(updated, deps));
  } catch (error) {
    writePathError(res, deps, error);
  }
}

async function handleWorktrees(req: http.IncomingMessage, res: http.ServerResponse, theater: TheaterRegistration, deps: TheaterPathContextRouteDeps): Promise<void> {
  if (req.method !== "GET") {
    deps.writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    deps.writeJson(res, 200, await listTheaterWorktrees(theater.realpath));
  } catch {
    deps.writeJson(res, 500, { error: "worktree_discovery_failed" });
  }
}

async function handleDirectories(req: http.IncomingMessage, res: http.ServerResponse, theater: TheaterRegistration, deps: TheaterPathContextRouteDeps): Promise<void> {
  if (req.method !== "POST") {
    deps.writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const body = await deps.readJsonBody<DirectoriesBody>(req);
  if (!isPlainObject(body) || !(body.relativePath === null || typeof body.relativePath === "string") || Object.keys(body).length !== 1) {
    deps.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  try {
    deps.writeJson(res, 200, { directories: await listTheaterDirectories(theater.realpath, body.relativePath) });
  } catch (error) {
    writePathError(res, deps, error);
  }
}

async function writeContext(res: http.ServerResponse, theater: TheaterRegistration, deps: TheaterPathContextRouteDeps): Promise<void> {
  try {
    deps.writeJson(res, 200, await toContextDto(theater, deps));
  } catch (error) {
    writePathError(res, deps, error);
  }
}

async function toContextDto(theater: TheaterRegistration, _deps: TheaterPathContextRouteDeps): Promise<{ readonly kind: "root" | "worktree" | "directory"; readonly relPath: string | null; readonly label: string }> {
  const resolved = await resolveTheaterPathContext(theater.realpath, theater.pathContext);
  let kind: "root" | "worktree" | "directory" = resolved.relPath === null ? "root" : "directory";
  if (resolved.relPath !== null) {
    try {
      const worktrees = await listTheaterWorktrees(theater.realpath);
      if (worktrees.worktrees.some((worktree) => worktree.relPath === resolved.relPath)) kind = "worktree";
    } catch { /* a Git discovery failure must not make context reads unavailable */ }
  }
  return { kind, relPath: resolved.relPath, label: resolved.relPath === null ? theater.label : resolved.label };
}

function writePathError(res: http.ServerResponse, deps: TheaterPathContextRouteDeps, error: unknown): void {
  if (!(error instanceof TheaterPathContextError)) throw error;
  const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 400;
  deps.writeJson(res, status, { error: error.code });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
