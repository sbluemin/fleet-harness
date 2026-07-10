import type http from "node:http";

import { TheaterPathContextError } from "../theater-path-context.js";
import type { TheaterRegistration } from "../theaters.js";
import type { CodexWorkspaceResolution } from "./gateway.js";

// ─── types ─────────────────────────────────────────────────────────────────

export interface CodexWorkspaceContextRouteDeps {
  readonly getTheater: (theaterId: string) => TheaterRegistration | null;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly resolveWorkspace: (theaterRoot: string, relPath: string | null) => Promise<CodexWorkspaceResolution>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export interface CodexWorkspaceContextRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

interface ResolveWorkspaceBody {
  readonly relPath?: unknown;
}

// ─── functions ─────────────────────────────────────────────────────────────

export function createCodexWorkspaceContextRouter(
  deps: CodexWorkspaceContextRouteDeps,
): (context: CodexWorkspaceContextRouteContext) => Promise<boolean> {
  return async function handleCodexWorkspaceContextRoute({ req, res, pathname }: CodexWorkspaceContextRouteContext): Promise<boolean> {
    const match = pathname.match(/^\/api\/v1\/theaters\/([^/]+)\/codex-workspace$/u);
    if (!match) return false;
    const theater = deps.getTheater(decodeURIComponent(match[1] ?? ""));
    if (!theater) {
      deps.writeJson(res, 400, { error: "invalid_theater" });
      return true;
    }
    if (req.method !== "POST") {
      deps.writeJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!deps.isAuthorized(req)) {
      deps.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await deps.readJsonBody<ResolveWorkspaceBody>(req);
    if (!isResolveWorkspaceBody(body)) {
      deps.writeJson(res, 400, { error: "invalid_request" });
      return true;
    }
    try {
      deps.writeJson(res, 200, await deps.resolveWorkspace(theater.realpath, body.relPath));
    } catch (error) {
      writePathError(res, deps, error);
    }
    return true;
  };
}

function isResolveWorkspaceBody(value: ResolveWorkspaceBody | null): value is ResolveWorkspaceBody & { readonly relPath: string | null } {
  return typeof value === "object"
    && value !== null
    && Object.keys(value).length === 1
    && (value.relPath === null || typeof value.relPath === "string");
}

function writePathError(res: http.ServerResponse, deps: CodexWorkspaceContextRouteDeps, error: unknown): void {
  if (!(error instanceof TheaterPathContextError)) throw error;
  const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 400;
  deps.writeJson(res, status, { error: error.code });
}
