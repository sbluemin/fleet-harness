import { homedir } from "node:os";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import type { TerminalRuntime } from "./shared/index.js";

type TicketBody = { readonly operationId?: unknown; readonly sessionId?: unknown };

const GLOBAL_SHELL_SESSION_ID = "global-shell";
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
    const body = await ctx.host.http.readJsonBody<TicketBody>(req);
    const operationId = typeof body?.operationId === "string" ? body.operationId : typeof body?.sessionId === "string" ? body.sessionId : null;
    if (!operationId) {
      ctx.host.http.writeJson(res, 400, { error: "operation_id_required" });
      return true;
    }
    if (operationId !== GLOBAL_SHELL_SESSION_ID) {
      ctx.host.http.writeJson(res, 409, { error: "invalid_global_shell_operation" });
      return true;
    }
    if (!runtime.canAttach(GLOBAL_SHELL_SESSION_ID)) {
      ctx.host.http.writeJson(res, 503, { error: "Terminal session capacity exhausted" });
      return true;
    }
    // 종료된 PTY가 세션 맵에 남는 드문 상태에서는 빈 write가 실패하므로, ticket 발급 전에 정리해 새 세션을 만들게 한다.
    if (!runtime.write(GLOBAL_SHELL_SESSION_ID, "")) runtime.terminate(GLOBAL_SHELL_SESSION_ID);
    ctx.host.http.writeJson(res, 200, runtime.issueTicket({
      cwd: homedir(),
      sessionId: GLOBAL_SHELL_SESSION_ID,
      operationId,
      operationType: GLOBAL_SHELL_OPERATION_TYPE,
      pluginId: ctx.pluginId,
      kind: "shell",
    }));
    return true;
  });
}
