import type http from "node:http";

import { resolveSurfaceRoot, type SurfaceSelectorSource } from "../../workspace/host/path-selector.js";
import type { RepositoryRouteContext } from "./index.js";

/** 저장소 라우트의 루트. 실패면 응답을 쓰고 null. 절대 경로는 응답에 싣지 않는다. */
export function takeRepositoryRoot(
  res: http.ServerResponse,
  ctx: RepositoryRouteContext,
  source: SurfaceSelectorSource,
): string | null {
  const resolved = resolveSurfaceRoot(ctx.host.paths, source);
  if (!resolved.ok) {
    ctx.host.http.writeJson(res, resolved.status, { error: resolved.error });
    return null;
  }
  return resolved.root;
}
