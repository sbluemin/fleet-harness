import type http from "node:http";

import type { TheaterRef } from "./theater-paths.js";
import type { CodexWorkspaceResolution } from "./gateway.js";

export interface CodexWorkspaceRouteDeps {
  readonly getTheater: (theaterId: string) => TheaterRef | null;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly resolveWorkspace: (theaterId: string, theaterRoot: string) => Promise<CodexWorkspaceResolution>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export interface CodexWorkspaceRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

export function createCodexWorkspaceRouter(
  deps: CodexWorkspaceRouteDeps,
): (context: CodexWorkspaceRouteContext) => Promise<boolean> {
  return async function handleCodexWorkspaceRoute({ req, res, pathname }: CodexWorkspaceRouteContext): Promise<boolean> {
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
    } catch {
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
