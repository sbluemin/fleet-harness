import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import { readSocketRole } from "./shared/index.js";
import type { TerminalRuntime } from "./shared/index.js";

type TicketBody = { readonly operationId?: unknown; readonly sessionId?: unknown; readonly colorScheme?: unknown; readonly role?: unknown };

const GLOBAL_SHELL_OPERATION_PREFIX = "global-shell:theater:";
const GLOBAL_SHELL_OPERATION_TYPE = "shell";

export function registerGlobalShellRoutes(ctx: FleetPluginServerContext, runtime: TerminalRuntime): void {
  registerRouter(ctx, "global/ticket", async ({ req, res }) => {
    if (req.method !== "POST") {
      ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    // Global Shell은 브라우저 rail 전용 표면이다. 브라우저 요청은 항상 Origin을 보내므로,
    // Origin이 없는 요청을 body 및 Theater 경로 해석 전에 차단한다.
    if (req.headers.origin === undefined) {
      ctx.host.http.writeJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    const body = await ctx.host.http.readJsonBody<TicketBody>(req);
    const operationId = typeof body?.operationId === "string" ? body.operationId : typeof body?.sessionId === "string" ? body.sessionId : null;
    if (!operationId) {
      ctx.host.http.writeJson(res, 400, { error: "operation_id_required" });
      return true;
    }
    if (!operationId.startsWith(GLOBAL_SHELL_OPERATION_PREFIX)) {
      ctx.host.http.writeJson(res, 409, { error: "invalid_global_shell_operation" });
      return true;
    }
    const encodedTheaterId = operationId.slice(GLOBAL_SHELL_OPERATION_PREFIX.length);
    if (encodedTheaterId.length === 0) {
      ctx.host.http.writeJson(res, 400, { error: "theater_id_required" });
      return true;
    }
    let theaterId: string;
    try {
      theaterId = decodeURIComponent(encodedTheaterId);
    } catch {
      ctx.host.http.writeJson(res, 409, { error: "invalid_global_shell_operation" });
      return true;
    }
    if (theaterId.length === 0 || encodeURIComponent(theaterId) !== encodedTheaterId) {
      ctx.host.http.writeJson(res, 409, { error: "invalid_global_shell_operation" });
      return true;
    }
    let theaterPath: string | null;
    try {
      theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
    } catch {
      theaterPath = null;
    }
    if (!theaterPath) {
      ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
      return true;
    }
    if (!runtime.canAttach(operationId)) {
      ctx.host.http.writeJson(res, 503, { error: "Terminal session capacity exhausted" });
      return true;
    }
    // 세션 매니저는 PTY 종료 시 onExit로 세션 맵에서 자가 제거하므로(종료 세션은 canAttach가 새 세션으로
    // 재생성), ticket 발급 경로에서 별도의 stale 정리를 하지 않는다. 여기서 빈 write로 정리를 시도하면
    // 일시적 write 예외가 살아있는 세션을 오판 종료할 수 있어 오히려 위험하다.
    const colorScheme = body?.colorScheme === "light" || body?.colorScheme === "dark" ? body.colorScheme : undefined;
    const role = readSocketRole(body?.role);
    ctx.host.http.writeJson(res, 200, runtime.issueTicket({
      cwd: theaterPath,
      sessionId: operationId,
      operationId,
      operationType: GLOBAL_SHELL_OPERATION_TYPE,
      pluginId: ctx.pluginId,
      theaterId,
      kind: "shell",
      ...(colorScheme ? { colorScheme } : {}),
      ...(role ? { role } : {}),
    }));
    return true;
  });
}
