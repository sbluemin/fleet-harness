import type http from "node:http";

import { describe, expect, it, vi } from "vitest";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";

import { GLOBAL_SHELL_SESSION_ID, registerShellRoutes } from "../server/shell.js";
import type { TerminalRuntime, TerminalTicketContext } from "../server/shared/index.js";

/**
 * Shell은 콘솔 하나에 하나뿐인 전역 표면이다. 이 파일이 지키는 것은 두 가지다 —
 * 세션 키가 Operation id가 아니라 상수라는 것, 그리고 cwd가 첫 기동에 못 박혀
 * 사용자가 끝낼 때까지 Theater를 따라 움직이지 않는다는 것.
 */
describe("console-global Shell session", () => {
  it("keys the PTY on a console-wide constant rather than an Operation id", async () => {
    const { call, issued } = mount();

    await call({ theaterId: "theater-a" });

    expect(issued[0]!.sessionId).toBe(GLOBAL_SHELL_SESSION_ID);
    expect(issued[0]!.operationType).toBe("shell");
  });

  it("refuses the first ticket without a Theater to stand in", async () => {
    const { call, responses, issued } = mount();

    await call({});

    expect(responses.at(-1)).toMatchObject({ status: 400, body: { error: "theater_id_required" } });
    expect(issued).toHaveLength(0);
  });

  it("pins cwd at first launch and keeps it when the active Theater moves", async () => {
    const paths: Record<string, string> = { "theater-a": "/repos/a", "theater-b": "/repos/b" };
    const { call, issued } = mount({ resolveTheaterPath: (id: string) => paths[id] ?? null });

    await call({ theaterId: "theater-a" });
    // 사용자가 다른 Theater로 옮겨 간 뒤 셸을 다시 붙인다.
    await call({ theaterId: "theater-b" });

    expect(issued.map((ticket) => ticket.cwd)).toEqual(["/repos/a", "/repos/a"]);
  });

  it("releases the pin once the session is explicitly ended", async () => {
    const paths: Record<string, string> = { "theater-a": "/repos/a", "theater-b": "/repos/b" };
    const { call, del, issued, terminated } = mount({ resolveTheaterPath: (id: string) => paths[id] ?? null });

    await call({ theaterId: "theater-a" });
    await del();
    await call({ theaterId: "theater-b" });

    expect(terminated).toEqual([GLOBAL_SHELL_SESSION_ID]);
    expect(issued.map((ticket) => ticket.cwd)).toEqual(["/repos/a", "/repos/b"]);
  });

  it("releases the pin when the shell exits on its own", async () => {
    const paths: Record<string, string> = { "theater-a": "/repos/a", "theater-b": "/repos/b" };
    const { call, exit, issued } = mount({ resolveTheaterPath: (id: string) => paths[id] ?? null });

    await call({ theaterId: "theater-a" });
    exit(GLOBAL_SHELL_SESSION_ID);
    await call({ theaterId: "theater-b" });

    expect(issued.map((ticket) => ticket.cwd)).toEqual(["/repos/a", "/repos/b"]);
  });

  it("ignores an exit belonging to some other session", async () => {
    const paths: Record<string, string> = { "theater-a": "/repos/a", "theater-b": "/repos/b" };
    const { call, exit, issued } = mount({ resolveTheaterPath: (id: string) => paths[id] ?? null });

    await call({ theaterId: "theater-a" });
    exit("some-agent-operation");
    await call({ theaterId: "theater-b" });

    expect(issued.map((ticket) => ticket.cwd)).toEqual(["/repos/a", "/repos/a"]);
  });

  it("reports an unknown Theater rather than opening a shell somewhere arbitrary", async () => {
    const { call, responses, issued } = mount({ resolveTheaterPath: () => null });

    await call({ theaterId: "ghost" });

    expect(responses.at(-1)).toMatchObject({ status: 404, body: { error: "theater_not_found" } });
    expect(issued).toHaveLength(0);
  });
});

function mount(options: { resolveTheaterPath?: (id: string) => string | null } = {}) {
  const issued: TerminalTicketContext[] = [];
  const responses: Array<{ status: number; body: unknown }> = [];
  const terminated: string[] = [];
  const exitListeners = new Set<(sessionId: string) => void>();
  const routes = new Map<string, RouteHandler>();
  let requestBody: Record<string, unknown> = {};

  const runtime = {
    issueTicket: (context: TerminalTicketContext) => {
      issued.push(context);
      return { ticket: "ticket", ttlMs: 1_000, role: context.role ?? "control" };
    },
    canAttach: () => true,
    terminate: (sessionId: string) => { terminated.push(sessionId); return true; },
    onExit: (listener: (sessionId: string) => void) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  } as unknown as TerminalRuntime;

  const ctx = {
    pluginId: "terminal",
    basePath: "/plugins/terminal",
    registerRouter: (routePath: string, handler: RouteHandler) => { routes.set(routePath, handler); },
    host: {
      paths: { resolveTheaterPath: options.resolveTheaterPath ?? (() => "/repos/a") },
      http: {
        writeJson: (_res: http.ServerResponse, status: number, body: unknown) => { responses.push({ status, body }); },
        readJsonBody: async <T,>() => requestBody as T,
      },
      security: {
        isTerminalAuthorized: () => true,
        resolveTerminalSocketRole: () => "control" as const,
      },
      theaterFlags: { register: () => () => undefined },
      lifecycle: { registerCleanup: vi.fn() },
    },
  } as unknown as FleetPluginServerContext;

  registerShellRoutes(ctx, runtime);

  const invoke = async (routeKey: string, method: string, body: Record<string, unknown>) => {
    const handler = routes.get(routeKey);
    if (!handler) throw new Error(`${routeKey} was not registered`);
    requestBody = body;
    await handler({
      req: { method, url: `/plugins/terminal/${routeKey}`, headers: {} } as http.IncomingMessage,
      res: {} as http.ServerResponse,
      pathname: `/plugins/terminal/${routeKey}`,
    } as Parameters<RouteHandler>[0]);
  };

  return {
    issued,
    responses,
    terminated,
    call: (body: Record<string, unknown>) => invoke("shell/ticket", "POST", body),
    del: () => invoke("shell/session", "DELETE", {}),
    exit: (sessionId: string) => { for (const listener of exitListeners) listener(sessionId); },
  };
}

/**
 * cwd 폴백은 payload에 cwd가 없는 Operation을 Theater 경로로 구제하기 위한 것이다.
 * `readPayloadString`이 없는 키에 빈 문자열을 돌려주므로 `??`로는 절대 넘어가지 않았고,
 * 그래서 cwd가 찍히지 않은 agent Operation은 티켓을 영영 받지 못했다.
 */
describe("agent cwd fallback", () => {
  it("falls back to the Theater path when the payload carries no cwd", async () => {
    // 계약 자체를 소스에서 못 박는다 — `??`가 돌아오면 폴백이 다시 죽는다.
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = await fs.readFile(path.join(here, "..", "server", "agent.ts"), "utf8");

    expect(source).not.toMatch(/readPayloadString\((?:operation|node)\.payload, "cwd"\) \?\?/);
    expect(source).toMatch(/readPayloadString\((?:operation|node)\.payload, "cwd"\) \|\|/);
  });
});
