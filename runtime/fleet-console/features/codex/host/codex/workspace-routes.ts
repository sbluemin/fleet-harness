import type http from "node:http";

import type { CodexWorkspaceResolution } from "./gateway.js";

export interface CodexWorkspaceRouteDeps {
  /** 화면이 고른 사령관이 지금 있는가 — 지식은 사령관 UUID 로만 가리킨다. */
  readonly commodoreExists: (commodoreId: string) => boolean;
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
    // 플러그인 라우트는 자기 이름공간에 산다. 사령관은 경로가 아니라 본문이 싣는다 —
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
    const commodoreId = readCommodoreId(body);
    if (!commodoreId) {
      deps.writeJson(res, 400, { error: "invalid_commodore" });
      return true;
    }
    if (!deps.commodoreExists(commodoreId)) {
      deps.writeJson(res, 200, { hasWiki: false, id: null });
      return true;
    }
    try {
      deps.writeJson(res, 200, deps.resolveWorkspace(commodoreId));
    } catch {
      deps.writeJson(res, 500, { error: "internal_error" });
    }
    return true;
  };
}

function readCommodoreId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as { readonly commodoreId?: unknown }).commodoreId;
  return typeof value === "string" && value.length > 0 ? value : null;
}
