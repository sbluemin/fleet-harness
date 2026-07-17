import type http from "node:http";

import type { TheaterRegistration } from "../theaters.js";
import type { CodexWorkspaceResolution } from "./gateway.js";

// ─── types ─────────────────────────────────────────────────────────────────

export interface CodexWorkspaceContextRouteDeps {
  readonly getTheater: (theaterId: string) => TheaterRegistration | null;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly resolveWorkspace: (theaterId: string, theaterRoot: string) => Promise<CodexWorkspaceResolution>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export interface CodexWorkspaceContextRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
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
    const body = await deps.readJsonBody<unknown>(req);
    if (!isResolveWorkspaceBody(body)) {
      deps.writeJson(res, 400, { error: "invalid_request" });
      return true;
    }
    try {
      deps.writeJson(res, 200, await deps.resolveWorkspace(theater.id, theater.realpath));
    } catch (error) {
      deps.writeJson(res, 500, { error: "internal_error" });
    }
    return true;
  };
}

function isResolveWorkspaceBody(value: unknown): value is Record<string, never> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}
