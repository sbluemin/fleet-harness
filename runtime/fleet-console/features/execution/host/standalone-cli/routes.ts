import { randomUUID } from "node:crypto";

import { FLEET_BROWSER_MCP_SERVER, STANDALONE_BROWSER_OWNER_PREFIX } from "../../../browser/host/mcp.js";
import { registerRouter, type ConsoleRuntimeContext } from "../context.js";
import { readSocketRole, type TerminalRuntime } from "../terminal/index.js";
import {
  createStandaloneCliLaunchResolver,
  isStandaloneCliInstalled,
  isStandaloneCliKind,
  STANDALONE_CLI_KINDS,
  standaloneCliRecordType,
  standaloneCliSessionId,
  type StandaloneCliBrowserMcpBinding,
  type StandaloneCliKind,
  type StandaloneCliLaunchDeps,
} from "./launch.js";

/**
 * 독립 CLI(Claude Code) — Console 하나에 1슬롯이다.
 *
 * 세션은 Objective이 아니다: 기록도 저널도 휴면도 없고, Console이 켜져 있는 동안만 산다. 패널을 숨겨도 PTY는
 * 그대로 돌고, 다시 붙는 소켓은 터미널 런타임의 scrollback 재생을 받는다. PTY가 끝나면(`/exit` 또는 팔레트 종료)
 * 그 CLI의 자리와 그 CLI가 연 `fleet-browser` 탭만 정리한다. Console이 멈추면 터미널 런타임이 함께 접는다.
 *
 * 처음 뜰 때의 사령관·작전 구역이 이 CLI의 작업 위치와 `fleet-browser` 스페이스다. 다른 작전 구역으로 옮겨도
 * 살아 있는 CLI는 따라가지 않으며, 브라우저는 불투명 id만 받는다 — 경로는 서버 밖으로 나가지 않는다.
 */
interface StandaloneCliPlacement {
  readonly cwd: string;
  readonly commodoreId: string;
  readonly theaterId: string;
}

export interface StandaloneCliSlotServerState {
  readonly live: boolean;
  readonly installed: boolean;
  readonly commodoreId: string | null;
  readonly theaterId: string | null;
}

export interface StandaloneCliState {
  readonly slots: Readonly<Record<StandaloneCliKind, StandaloneCliSlotServerState>>;
}

export function registerStandaloneCliRoutes(
  ctx: ConsoleRuntimeContext,
  terminalRuntime: TerminalRuntime,
  deps: Omit<StandaloneCliLaunchDeps, "env" | "browserMcp">,
): void {
  const placements = new Map<StandaloneCliKind, StandaloneCliPlacement>();
  const browserMcpConn = ctx.host.browserMcp?.connect();
  if (browserMcpConn) ctx.host.lifecycle.registerCleanup(() => browserMcpConn.dispose());

  const browserMcp: StandaloneCliBrowserMcpBinding | undefined = ctx.host.browserMcp && browserMcpConn
    ? {
        prepare: async ({ cli, cwd, commodoreId }) => {
          const label = `${STANDALONE_BROWSER_OWNER_PREFIX}${cli}:${randomUUID()}`;
          ctx.host.browserMcp?.registerStandaloneSession?.(label, { commodoreId });
          try {
            const endpoint = await browserMcpConn.getEndpoint();
            const server = endpoint.servers.find((entry) => entry.name === FLEET_BROWSER_MCP_SERVER) ?? endpoint.servers[0];
            const tokens = browserMcpConn.issueSessionToken({ label, cwd });
            const issued = tokens.find((entry) => entry.name === FLEET_BROWSER_MCP_SERVER) ?? tokens[0];
            if (!server || !issued) throw new Error("standalone_cli_browser_mcp_unavailable");
            return {
              endpointUrl: server.url,
              bearerToken: issued.token,
              release: async () => {
                browserMcpConn.releaseSessionToken(label);
                await ctx.host.browserMcp?.releaseStandaloneSession?.(label);
              },
            };
          } catch (error) {
            browserMcpConn.releaseSessionToken(label);
            await ctx.host.browserMcp?.releaseStandaloneSession?.(label);
            throw error;
          }
        },
      }
    : undefined;

  const launchDeps: Omit<StandaloneCliLaunchDeps, "env"> = {
    ...deps,
    ...(browserMcp ? { browserMcp } : {}),
  };

  const unregisters = STANDALONE_CLI_KINDS.map((cli) =>
    terminalRuntime.registerLaunchResolver(standaloneCliRecordType(cli), createStandaloneCliLaunchResolver(launchDeps, cli)),
  );
  const cliBySessionId = new Map(STANDALONE_CLI_KINDS.map((cli) => [standaloneCliSessionId(cli), cli]));

  const unsubscribeExit = terminalRuntime.onExit((sessionId) => {
    const cli = cliBySessionId.get(sessionId);
    if (!cli) return;
    // 끝난 CLI의 자리를 비운다. 발급만 되고 쓰이지 않은 티켓이 끝난 CLI를 같은 자리에서 되살리지 못하게 한다.
    placements.delete(cli);
    terminalRuntime.invalidateTicketsForSession(sessionId);
  });

  ctx.host.lifecycle.registerCleanup(() => {
    unsubscribeExit();
    for (const unregister of unregisters) unregister();
    placements.clear();
  });

  const readState = async (): Promise<StandaloneCliState> => {
    const claudeInstalled = await isStandaloneCliInstalled("claude", deps);
    const slotOf = (cli: StandaloneCliKind, installed: boolean): StandaloneCliSlotServerState => {
      const live = terminalRuntime.isLive(standaloneCliSessionId(cli));
      const placement = placements.get(cli);
      return {
        live,
        installed,
        commodoreId: placement?.commodoreId ?? null,
        theaterId: placement?.theaterId ?? null,
      };
    };
    return {
      slots: {
        claude: slotOf("claude", claudeInstalled),
      },
    };
  };

  registerRouter(ctx, "standalone-cli", async ({ req, res, pathname }) => {
    const path = pathname.slice(`${ctx.basePath}/standalone-cli`.length) || "/";
    if (path === "/state") {
      if (req.method !== "GET") return methodNotAllowed(ctx, res);
      ctx.host.http.writeJson(res, 200, await readState());
      return true;
    }
    if (path === "/ticket") {
      if (req.method !== "POST") return methodNotAllowed(ctx, res);
      if (!ctx.host.security.isTerminalAuthorized(req)) {
        ctx.host.http.writeJson(res, 401, { error: "Unauthorized" });
        return true;
      }
      const body = await ctx.host.http.readJsonBody<{
        readonly cli?: unknown;
        readonly commodoreId?: unknown;
        readonly theaterId?: unknown;
        readonly colorScheme?: unknown;
        readonly role?: unknown;
      }>(req);
      const cli: StandaloneCliKind | null = body?.cli === undefined
        ? "claude"
        : isStandaloneCliKind(body.cli) ? body.cli : null;
      if (cli === null) {
        ctx.host.http.writeJson(res, 400, { error: "invalid_cli" });
        return true;
      }
      const sessionId = standaloneCliSessionId(cli);
      const commodoreId = typeof body?.commodoreId === "string" && body.commodoreId.trim() ? body.commodoreId : null;
      const theaterId = typeof body?.theaterId === "string" && body.theaterId.trim() ? body.theaterId : null;
      // 살아 있는 CLI는 요청이 어느 Theater를 말하든 그 자리 그대로다. 아직 PTY가 서지 않은 자리(띄우다 실패한 자리 포함)는
      // 이 표면이 말하는 Theater로 다시 잡는다 — 붙지 못한 자리가 다음 열기를 옛 Theater에 묶어 두지 않게.
      let current = placements.get(cli) ?? null;
      if (current === null || (!terminalRuntime.isLive(sessionId) && commodoreId !== null && theaterId !== null)) {
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
        placements.set(cli, current);
      }
      const colorScheme = body?.colorScheme === "light" || body?.colorScheme === "dark" ? body.colorScheme : undefined;
      const role = ctx.host.security.resolveTerminalSocketRole(req) === "viewer" ? "viewer" : readSocketRole(body?.role);
      const additionalDirectories = !terminalRuntime.isLive(sessionId)
        ? resolveAdditionalTheaterDirectories(ctx.host.paths, current.commodoreId, current.cwd)
        : undefined;
      const ticket = terminalRuntime.issueTicket({
        commodoreId: current.commodoreId,
        ...(additionalDirectories?.length ? { additionalDirectories } : {}),
        cwd: current.cwd,
        sessionId,
        objectiveRecordType: standaloneCliRecordType(cli),
        pluginId: null,
        theaterId: current.theaterId,
        ...(colorScheme ? { colorScheme } : {}),
        ...(role ? { role } : {}),
      });
      ctx.host.http.writeJson(res, 200, { ...ticket, cli, commodoreId: current.commodoreId, theaterId: current.theaterId });
      return true;
    }
    if (path === "/stop") {
      if (req.method !== "POST") return methodNotAllowed(ctx, res);
      if (!ctx.host.security.isTerminalAuthorized(req) || ctx.host.security.resolveTerminalSocketRole(req) === "viewer") {
        ctx.host.http.writeJson(res, 401, { error: "Unauthorized" });
        return true;
      }
      const body = await ctx.host.http.readJsonBody<{ readonly cli?: unknown }>(req);
      if (!isStandaloneCliKind(body?.cli)) {
        ctx.host.http.writeJson(res, 400, { error: "invalid_cli" });
        return true;
      }
      const sessionId = standaloneCliSessionId(body.cli);
      placements.delete(body.cli);
      terminalRuntime.invalidateTicketsForSession(sessionId);
      terminalRuntime.terminate(sessionId);
      ctx.host.http.writeJson(res, 200, { ok: true, cli: body.cli });
      return true;
    }
    return false;
  }, [
    { method: "GET", path: "/state", summary: "Read the standalone CLI slots state.", category: "Console Execution", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/ticket", summary: "Issue a standalone CLI Terminal WebSocket ticket.", category: "Console Execution", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/stop", summary: "Stop a running standalone CLI session.", category: "Console Execution", gate: "origin-write", transport: "http" },
  ]);
}

function resolveAdditionalTheaterDirectories(
  paths: ConsoleRuntimeContext["host"]["paths"],
  commodoreId: string,
  cwd: string,
): readonly string[] {
  const seen = new Set<string>([cwd]);
  const extra: string[] = [];
  for (const theater of paths.listCommodoreTheaters(commodoreId)) {
    const dir = paths.resolveCommodoreTheaterPath(commodoreId, theater.id);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    extra.push(dir);
  }
  return extra;
}

function methodNotAllowed(ctx: ConsoleRuntimeContext, res: Parameters<ConsoleRuntimeContext["host"]["http"]["writeJson"]>[0]): true {
  ctx.host.http.writeJson(res, 405, { error: "Method Not Allowed" });
  return true;
}
