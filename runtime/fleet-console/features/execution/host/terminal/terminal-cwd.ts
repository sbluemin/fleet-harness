import { realpathSync } from "node:fs";
import path from "node:path";

import type { ConsoleRuntimeContext } from "../context.js";
import { registerRouter } from "../context.js";

/**
 * Agent 터미널 출력의 상대 경로 링크가 기댈 기준 — 그 Operation의 cwd를 자기 Theater 안의 상대 경로로
 * 바꾼 값이다. 브라우저는 절대 경로를 받지 않는다. cwd가 Theater 밖(외부 worktree 등)이면 상대 경로는
 * null이고, 그 터미널은 상대 경로 링크를 세우지 않는다.
 */
export function registerTerminalCwdRoute(ctx: ConsoleRuntimeContext): void {
  registerRouter(ctx, "terminal/cwd", ({ req, res }) => {
    if (req.method !== "GET") {
      ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const operationId = new URL(req.url ?? "", "http://localhost").searchParams.get("operationId");
    const operation = operationId ? ctx.host.operations.get(operationId) : null;
    if (!operation) {
      ctx.host.http.writeJson(res, 404, { error: "operation_not_found" });
      return true;
    }
    const cwd = typeof operation.payload.cwd === "string" ? operation.payload.cwd : "";
    const root = ctx.host.paths.resolveTheaterPath(operation.theaterId);
    ctx.host.http.writeJson(res, 200, { theaterId: operation.theaterId, relative: root && cwd ? relativeInside(root, cwd) : null });
    return true;
  }, {
    method: "GET",
    path: "",
    summary: "Read an Operation terminal's cwd relative to its Theater (null outside it).",
    category: "Console Execution",
    gate: "loopback",
    transport: "http",
  });
}

function relativeInside(root: string, cwd: string): string | null {
  let real: string;
  try {
    real = realpathSync.native(cwd);
  } catch {
    return null;
  }
  const relative = path.relative(root, real);
  if (relative === "") return "";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}
