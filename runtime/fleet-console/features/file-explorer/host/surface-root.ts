import type http from "node:http";

import { resolveSurfaceRoot, type SurfaceSelectorSource } from "../../workspace/host/path-selector.js";
import type { FileExplorerRouteContext } from "./index.js";

/** 탐색기 라우트의 루트. 실패면 응답을 쓰고 null. 감시 키는 selector id다. */
export function takeExplorerRoot(
  res: http.ServerResponse,
  ctx: FileExplorerRouteContext,
  source: SurfaceSelectorSource,
): { readonly root: string; readonly key: string } | null {
  const resolved = resolveSurfaceRoot(ctx.host.paths, source);
  if (!resolved.ok) {
    ctx.host.http.writeJson(res, resolved.status, { error: resolved.error });
    return null;
  }
  return { root: resolved.root, key: resolved.key };
}
