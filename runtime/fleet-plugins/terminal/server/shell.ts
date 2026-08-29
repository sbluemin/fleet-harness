import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import { readSocketRole } from "./shared/index.js";
import type { TerminalRuntime } from "./shared/index.js";

type TicketBody = {
  readonly theaterId?: unknown;
  readonly colorScheme?: unknown;
  readonly role?: unknown;
};

/**
 * Shell은 Operation이 아니다 — 콘솔 하나에 하나뿐인 전역 표면이다.
 *
 * 그래서 세션 키는 Operation id가 아니라 이 상수다. 티켓·소켓·write·terminate가
 * 전부 이 하나를 쓴다. durable state에 들어가지 않으므로 콘솔이 죽으면 셸도 죽고,
 * 복원할 휴면 상태라는 것 자체가 없다.
 */
/**
 * `shell:` 접두를 쓰지 않는다. 세션 매니저는 그 접두를 "상태 미유지 theater-shell"의 표식으로
 * 읽어, 마지막 소켓이 떨어지고 4초 뒤 PTY를 정리한다. 전역 셸은 정반대 약속을 지고 있다 —
 * 레일에서 잠깐 치워 둔 셸은 돌아왔을 때 그 자리에 있어야 하고, cwd 고정도 함께 살아 있어야
 * 한다. 접두 하나가 그 약속을 4초짜리로 만든다.
 */
const GLOBAL_SHELL_SESSION_ID = "console-shell";
const GLOBAL_SHELL_OPERATION_TYPE = "shell";

export function registerShellRoutes(ctx: FleetPluginServerContext, runtime: TerminalRuntime): void {
  /**
   * cwd는 첫 기동 때 활성 Theater 경로로 한 번 못 박고, 사용자가 셸을 명시적으로
   * 끝낼 때까지 유지한다. Theater를 옮겨 다닌다고 발밑이 바뀌면 반쯤 친 명령이
   * 다른 저장소에서 실행된다 — 셸의 현재 위치는 사용자만 바꿀 수 있어야 한다.
   */
  let pinnedCwd: string | null = null;
  let pinnedTheaterId: string | null = null;

  const release = () => {
    pinnedCwd = null;
    pinnedTheaterId = null;
  };

  // PTY가 스스로 끝나면(exit, 사용자가 `exit` 입력) 고정도 함께 풀린다 —
  // 다음 기동은 그때의 활성 Theater에서 새로 시작한다.
  const unsubscribeExit = runtime.onExit((sessionId) => {
    if (sessionId === GLOBAL_SHELL_SESSION_ID) release();
  });
  ctx.host.lifecycle.registerCleanup(unsubscribeExit);

  registerRouter(ctx, "shell/ticket", async ({ req, res }) => {
    if (req.method !== "POST") {
      ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    const body = await ctx.host.http.readJsonBody<TicketBody>(req);

    if (pinnedCwd === null) {
      const theaterId = typeof body?.theaterId === "string" ? body.theaterId : null;
      if (!theaterId) {
        ctx.host.http.writeJson(res, 400, { error: "theater_id_required" });
        return true;
      }
      const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
      if (!theaterPath) {
        ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
        return true;
      }
      pinnedCwd = theaterPath;
      pinnedTheaterId = theaterId;
    }

    if (!runtime.canAttach(GLOBAL_SHELL_SESSION_ID)) {
      ctx.host.http.writeJson(res, 503, { error: "Terminal session capacity exhausted" });
      return true;
    }

    const colorScheme =
      body?.colorScheme === "light" || body?.colorScheme === "dark" ? body.colorScheme : undefined;
    // 등급은 Console이 정한다. 요청이 control을 원해도 제어를 쥔 원격이 있으면 관전으로 내려간다.
    const role =
      ctx.host.security.resolveTerminalSocketRole(req) === "viewer" ? "viewer" : readSocketRole(body?.role);

    ctx.host.http.writeJson(res, 200, runtime.issueTicket({
      cwd: pinnedCwd,
      sessionId: GLOBAL_SHELL_SESSION_ID,
      operationId: GLOBAL_SHELL_SESSION_ID,
      operationType: GLOBAL_SHELL_OPERATION_TYPE,
      pluginId: ctx.pluginId,
      ...(pinnedTheaterId ? { theaterId: pinnedTheaterId } : {}),
      kind: "shell",
      ...(colorScheme ? { colorScheme } : {}),
      ...(role ? { role } : {}),
    }));
    return true;
  }, {
    method: "POST",
    path: "",
    summary: "Issue a ticket for the console-global Shell.",
    category: "Terminal Plugin",
    gate: "origin-write",
    transport: "http",
  });

  registerRouter(ctx, "shell/session", ({ req, res }) => {
    if (req.method !== "DELETE") {
      ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    runtime.terminate(GLOBAL_SHELL_SESSION_ID);
    release();
    ctx.host.http.writeJson(res, 200, { ok: true });
    return true;
  }, {
    method: "DELETE",
    path: "",
    summary: "Terminate the console-global Shell session.",
    category: "Terminal Plugin",
    gate: "origin-write",
    transport: "http",
  });
}

export { GLOBAL_SHELL_SESSION_ID };
