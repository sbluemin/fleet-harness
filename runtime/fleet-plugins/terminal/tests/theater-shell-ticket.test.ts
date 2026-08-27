import type http from "node:http";

import { describe, expect, it } from "vitest";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";

import { registerShellRoutes } from "../server/shell.js";
import type { TerminalRuntime, TerminalTicketContext } from "../server/shared/index.js";

/**
 * Theater 셸은 Operation 없이 PTY에 붙는다. 이 테스트가 지키는 것은 그 대가로 생기는 위험이다 —
 * 세션 id를 **서버가** 짓지 않으면, 클라이언트가 보낸 id로 남의 Theater PTY에 붙는 티켓을
 * 스스로 발급하게 된다.
 */
describe("theater shell ticket", () => {
  it("derives the session id from the Theater and ignores any id the client sends", async () => {
    const issued: TerminalTicketContext[] = [];
    const { call, responses } = await mount({ issued });

    await call({ theaterId: "theater-1", sessionId: "shell:someone-else", operationId: "op-9" });

    expect(issued).toHaveLength(1);
    expect(issued[0]!.sessionId).toBe("shell:theater-1");
    // Operation을 만들지도, 참조하지도 않는다.
    expect(issued[0]!.operationId).toBeUndefined();
    expect(issued[0]!.cwd).toBe("/tmp/theater");
    expect(responses.at(-1)).toMatchObject({ status: 200 });
  });

  it("refuses a request that names no Theater", async () => {
    const { call, responses } = await mount({ issued: [] });
    await call({});
    expect(responses.at(-1)).toMatchObject({ status: 400, body: { error: "theater_id_required" } });
  });

  it("refuses a Theater whose path cannot be resolved", async () => {
    const { call, responses } = await mount({ issued: [], theaterPath: null });
    await call({ theaterId: "ghost" });
    expect(responses.at(-1)).toMatchObject({ status: 404, body: { error: "theater_not_found" } });
  });

  it("keeps the Console's role verdict over the requested one", async () => {
    const issued: TerminalTicketContext[] = [];
    const { call } = await mount({ issued, role: "viewer" });
    await call({ theaterId: "theater-1", role: "control" });
    expect(issued[0]!.role).toBe("viewer");
  });

  it("terminates the Theater session by the same derived id", async () => {
    const terminated: string[] = [];
    const { callDelete, responses } = await mount({ issued: [], terminated });
    await callDelete("theater-1");
    expect(terminated).toEqual(["shell:theater-1"]);
    expect(responses.at(-1)).toMatchObject({ status: 200 });
  });
});

interface MountOptions {
  readonly issued: TerminalTicketContext[];
  readonly role?: "control" | "viewer";
  readonly theaterPath?: string | null;
  readonly terminated?: string[];
}

async function mount(options: MountOptions): Promise<{
  call(body: Record<string, unknown>): Promise<void>;
  callDelete(theaterId: string): Promise<void>;
  responses: Array<{ status: number; body: unknown }>;
}> {
  const responses: Array<{ status: number; body: unknown }> = [];
  const routes = new Map<string, RouteHandler>();
  let requestBody: Record<string, unknown> = {};
  const theaterPath = options.theaterPath === undefined ? "/tmp/theater" : options.theaterPath;

  const terminalRuntime = {
    handleUpgrade: () => false,
    issueTicket: (context: TerminalTicketContext) => {
      options.issued.push(context);
      return { ticket: "ticket", ttlMs: 1_000, role: context.role ?? "control" };
    },
    renegotiateSockets: () => {},
    invalidateTicketsForSession: () => {},
    canAttach: () => true,
    attach: async () => {},
    attachViewer: () => true,
    createSession: async () => {},
    getSessionMessagePolicy: () => undefined,
    getSessionRenameCommand: () => undefined,
    getSessionLastActivityAt: () => null,
    resolveSessionIdentity: async () => null,
    terminate: (sessionId: string) => { options.terminated?.push(sessionId); return true; },
    stop: async () => {},
    writeToSession: () => false,
  } as unknown as TerminalRuntime;

  const ctx = {
    pluginId: "terminal",
    manifest: { id: "terminal" },
    basePath: "/plugins/terminal",
    wsBasePath: "/plugins/terminal/ws",
    registerRouter: (routePath: string, handler: RouteHandler) => { routes.set(routePath, handler); },
    registerWsHandler: () => {},
    host: {
      operations: { get: () => null, list: () => [], patch: () => {}, delete: () => {} },
      paths: { resolveTheaterPath: () => theaterPath, workspaceHash: () => "theater-1" },
      storage: { readJson: async () => null, writeJson: async () => {} },
      events: { subscribe: () => () => {}, publish: () => {} },
      http: {
        writeJson: (_res: http.ServerResponse, status: number, body: unknown) => { responses.push({ status, body }); },
        readJsonBody: async <T,>() => requestBody as T,
      },
      security: {
        validateHost: () => true,
        isTerminalAuthorized: () => true,
        isLockAuthorized: () => true,
        resolveTerminalSocketRole: () => options.role ?? "control",
      },
      lifecycle: { registerCleanup: () => () => {} },
    },
  } as unknown as FleetPluginServerContext;

  registerShellRoutes(ctx, terminalRuntime);

  return {
    responses,
    async call(body) {
      requestBody = body;
      const handler = routes.get("shell/theater-ticket");
      if (!handler) throw new Error("shell/theater-ticket route was not registered");
      await handler({
        req: { method: "POST", url: "/plugins/terminal/shell/theater-ticket", headers: {} } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: "/plugins/terminal/shell/theater-ticket",
      } as Parameters<RouteHandler>[0]);
    },
    async callDelete(theaterId) {
      const handler = routes.get("shell/theater-sessions");
      if (!handler) throw new Error("shell/theater-sessions route was not registered");
      await handler({
        req: { method: "DELETE", url: "", headers: {} } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: `/plugins/terminal/shell/theater-sessions/${theaterId}`,
      } as Parameters<RouteHandler>[0]);
    },
  };
}
