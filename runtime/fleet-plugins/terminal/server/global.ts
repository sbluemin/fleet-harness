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
    // Global Shell은 브라우저 rail 전용 표면이다. 상류 인가는 Origin 헤더가 없는 비브라우저(CLI/도구)
    // 요청을 호환 목적으로 허용하지만, 이 라우트는 고정 session id와 고정 $HOME cwd 조합이라 사전지식
    // 없이도 사용자의 홈 셸 PTY를 열 수 있다. 브라우저 요청은 항상 Origin을 보내므로, Origin이 없는
    // 요청만 추가로 차단해 정상 기능을 해치지 않고 공격 표면을 좁힌다.
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
    if (operationId !== GLOBAL_SHELL_SESSION_ID) {
      ctx.host.http.writeJson(res, 409, { error: "invalid_global_shell_operation" });
      return true;
    }
    if (!runtime.canAttach(GLOBAL_SHELL_SESSION_ID)) {
      ctx.host.http.writeJson(res, 503, { error: "Terminal session capacity exhausted" });
      return true;
    }
    // 세션 매니저는 PTY 종료 시 onExit로 세션 맵에서 자가 제거하므로(종료 세션은 canAttach가 새 세션으로
    // 재생성), ticket 발급 경로에서 별도의 stale 정리를 하지 않는다. 여기서 빈 write로 정리를 시도하면
    // 일시적 write 예외가 살아있는 세션을 오판 종료할 수 있어 오히려 위험하다.
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
