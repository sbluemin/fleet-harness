import { registerRouter, type ConsoleRuntimeContext } from "../context.js";
import { readSocketRole, type TerminalRuntime } from "../terminal/index.js";
import { createStandaloneCliLaunchResolver, type StandaloneCliLaunchDeps } from "./launch.js";

/**
 * 독립 Claude Code CLI — Console 하나에 하나다.
 *
 * 세션은 Objective이 아니다: 기록도 저널도 휴면도 없고, Console이 켜져 있는 동안만 산다. 패널을 숨겨도 PTY는
 * 그대로 돌고, 다시 붙는 소켓은 터미널 런타임의 scrollback 재생을 받는다. PTY가 끝나면(`/exit`) 자리가 비고,
 * 다음 열기가 그때 보고 있는 Theater에서 새로 띄운다. Console이 멈추면 터미널 런타임이 함께 접는다.
 *
 * 처음 뜰 때의 Theater가 이 CLI의 작업 위치다. Theater를 옮겨도 살아 있는 CLI는 따라가지 않으며, 브라우저는
 * 그 Theater의 불투명 id만 받는다 — 경로는 서버 밖으로 나가지 않는다.
 */
export const STANDALONE_CLI_SESSION_ID = "standalone-cli";
export const STANDALONE_CLI_RECORD_TYPE = "standalone-cli";

interface StandaloneCliPlacement {
  readonly cwd: string;
  readonly commodoreId: string;
  readonly theaterId: string;
}

export interface StandaloneCliState {
  readonly live: boolean;
  readonly commodoreId: string | null;
  readonly theaterId: string | null;
}

export function registerStandaloneCliRoutes(
  ctx: ConsoleRuntimeContext,
  terminalRuntime: TerminalRuntime,
  deps: Omit<StandaloneCliLaunchDeps, "env">,
): void {
  let placement: StandaloneCliPlacement | null = null;
  const unregisterLaunch = terminalRuntime.registerLaunchResolver(STANDALONE_CLI_RECORD_TYPE, createStandaloneCliLaunchResolver(deps));
  const unsubscribeExit = terminalRuntime.onExit((sessionId) => {
    if (sessionId !== STANDALONE_CLI_SESSION_ID) return;
    // 끝난 CLI의 자리를 비운다. 발급만 되고 쓰이지 않은 티켓이 끝난 CLI를 같은 자리에서 되살리지 못하게 한다.
    placement = null;
    terminalRuntime.invalidateTicketsForSession(STANDALONE_CLI_SESSION_ID);
  });
  ctx.host.lifecycle.registerCleanup(() => {
    unsubscribeExit();
    unregisterLaunch();
    placement = null;
  });

  const readState = (): StandaloneCliState => {
    const live = terminalRuntime.isLive(STANDALONE_CLI_SESSION_ID);
    // 티켓만 나간 채 아직 붙지 않은 자리도 이 CLI의 자리다 — 그 사이의 다시 열기가 다른 Theater로 갈라지지 않게 한다.
    return { live, commodoreId: placement?.commodoreId ?? null, theaterId: placement?.theaterId ?? null };
  };

  registerRouter(ctx, "standalone-cli", async ({ req, res, pathname }) => {
    const path = pathname.slice(`${ctx.basePath}/standalone-cli`.length) || "/";
    if (path === "/state") {
      if (req.method !== "GET") return methodNotAllowed(ctx, res);
      ctx.host.http.writeJson(res, 200, readState());
      return true;
    }
    if (path === "/ticket") {
      if (req.method !== "POST") return methodNotAllowed(ctx, res);
      if (!ctx.host.security.isTerminalAuthorized(req)) {
        ctx.host.http.writeJson(res, 401, { error: "Unauthorized" });
        return true;
      }
      const body = await ctx.host.http.readJsonBody<{ readonly commodoreId?: unknown; readonly theaterId?: unknown; readonly colorScheme?: unknown; readonly role?: unknown }>(req);
      const commodoreId = typeof body?.commodoreId === "string" && body.commodoreId.trim() ? body.commodoreId : null;
      const theaterId = typeof body?.theaterId === "string" && body.theaterId.trim() ? body.theaterId : null;
      // 살아 있는 CLI는 요청이 어느 Theater를 말하든 그 자리 그대로다. 아직 PTY가 서지 않은 자리(띄우다 실패한 자리 포함)는
      // 이 표면이 말하는 Theater로 다시 잡는다 — 붙지 못한 자리가 다음 열기를 옛 Theater에 묶어 두지 않게.
      let current = placement;
      if (current === null || (!terminalRuntime.isLive(STANDALONE_CLI_SESSION_ID) && commodoreId !== null && theaterId !== null)) {
        if (commodoreId === null || theaterId === null) {
          ctx.host.http.writeJson(res, 409, { error: "theater_required" });
          return true;
        }
        const cwd = ctx.host.paths.resolveCommodoreTheaterPath(commodoreId, theaterId);
        if (!cwd) {
          ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
          return true;
        }
        current = { cwd, commodoreId, theaterId };
        placement = current;
      }
      const colorScheme = body?.colorScheme === "light" || body?.colorScheme === "dark" ? body.colorScheme : undefined;
      const role = ctx.host.security.resolveTerminalSocketRole(req) === "viewer" ? "viewer" : readSocketRole(body?.role);
      const ticket = terminalRuntime.issueTicket({
        cwd: current.cwd,
        sessionId: STANDALONE_CLI_SESSION_ID,
        objectiveRecordType: STANDALONE_CLI_RECORD_TYPE,
        pluginId: null,
        theaterId: current.theaterId,
        ...(colorScheme ? { colorScheme } : {}),
        ...(role ? { role } : {}),
      });
      ctx.host.http.writeJson(res, 200, { ...ticket, commodoreId: current.commodoreId, theaterId: current.theaterId });
      return true;
    }
    return false;
  }, [
    { method: "GET", path: "/state", summary: "Read the standalone Claude Code CLI state.", category: "Console Execution", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/ticket", summary: "Issue a standalone Claude Code CLI Terminal WebSocket ticket.", category: "Console Execution", gate: "origin-write", transport: "http" },
  ]);
}

function methodNotAllowed(ctx: ConsoleRuntimeContext, res: Parameters<ConsoleRuntimeContext["host"]["http"]["writeJson"]>[0]): true {
  ctx.host.http.writeJson(res, 405, { error: "Method Not Allowed" });
  return true;
}
