import type http from "node:http";

import type { KnowledgeOwnerResult } from "../knowledge-port.js";

import type { CodexWorkspaceResolution } from "./gateway.js";

export interface CodexWorkspaceRouteDeps {
  /** 화면이 고른 맥락의 사령관 — 대응은 호스트가 정한다(없으면 발급). Codex는 맥락 id를 해석하지 않는다. */
  readonly resolveContext: (contextId: string) => KnowledgeOwnerResult;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly resolveWorkspace: (commodoreId: string) => CodexWorkspaceResolution;
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
    // 플러그인 라우트는 자기 이름공간에 산다. Theater는 경로가 아니라 본문이 싣는다 —
    // `/api/v1/theaters/...`는 코어가 소유한 경로이고, 플러그인이 그 밑에 끼어들 수 없다.
    if (pathname !== "/api/v1/codex/workspace") return false;
    if (req.method !== "POST") {
      deps.writeJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!deps.isAuthorized(req)) {
      deps.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await deps.readJsonBody<unknown>(req);
    const theaterId = readTheaterId(body);
    if (!theaterId) {
      deps.writeJson(res, 400, { error: "invalid_theater" });
      return true;
    }
    const owner = deps.resolveContext(theaterId);
    if (!owner.ok && owner.reason === "unknown_context") {
      deps.writeJson(res, 400, { error: "invalid_theater" });
      return true;
    }
    if (!owner.ok) {
      deps.writeJson(res, 200, { hasWiki: false, id: null });
      return true;
    }
    try {
      deps.writeJson(res, 200, deps.resolveWorkspace(owner.commodoreId));
    } catch {
      deps.writeJson(res, 500, { error: "internal_error" });
    }
    return true;
  };
}

function readTheaterId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as { readonly theaterId?: unknown }).theaterId;
  return typeof value === "string" && value.length > 0 ? value : null;
}
