import type http from "node:http";

import { describe, expect, it } from "vitest";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";

import { registerShellRoutes } from "../server/shell.js";
import type { TerminalRuntime, TerminalTicketContext } from "../server/shared/index.js";

/**
 * 등급 판정은 Console의 것이다. 이 테스트가 지키는 것은 "플러그인이 그 판정을 덮어쓰지 않는다"이다 —
 * 클라이언트가 control을 원해도, 새로고침이 control로 시작해도, Console이 viewer라고 하면 viewer다.
 */
describe("shell ticket role", () => {
  it("issues a viewer ticket when the console says this request may only watch", async () => {
    const issued: TerminalTicketContext[] = [];
    const { call, responses } = await mount({ role: "viewer", issued });

    await call({ theaterId: "theater-1", role: "control" });

    expect(issued).toHaveLength(1);
    expect(issued[0]!.role).toBe("viewer");
    expect(responses.at(-1)).toMatchObject({ status: 200, body: { role: "viewer" } });
  });

  it("leaves the ticket at control when nothing holds the console", async () => {
    const issued: TerminalTicketContext[] = [];
    const { call, responses } = await mount({ role: "control", issued });

    await call({ theaterId: "theater-1" });

    expect(issued[0]!.role).toBeUndefined();
    expect(responses.at(-1)).toMatchObject({ status: 200, body: { role: "control" } });
  });

  it("still honours an explicit viewer request while control is available", async () => {
    const issued: TerminalTicketContext[] = [];
    await mount({ role: "control", issued }).then(({ call }) => call({ theaterId: "theater-1", role: "viewer" }));

    expect(issued[0]!.role).toBe("viewer");
  });
});

interface MountOptions {
  readonly role: "control" | "viewer";
  readonly issued: TerminalTicketContext[];
}

async function mount(options: MountOptions): Promise<{
  call(body: Record<string, unknown>): Promise<void>;
  responses: Array<{ status: number; body: unknown }>;
}> {
  const responses: Array<{ status: number; body: unknown }> = [];
  const routes = new Map<string, RouteHandler>();
  let requestBody: Record<string, unknown> = {};

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
    terminate: () => true,
    onExit: () => () => {},
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
      operations: {
        get: () => ({ id: "op-1", type: "shell", pluginId: "terminal", theaterId: "theater-1", payload: {} }),
        list: () => [],
      },
      paths: {
        resolveTheaterPath: () => "/tmp/theater",
        workspaceHash: () => "theater-1",
        ensureWorkspaceDirectory: (cwd: string) => ({ path: `/tmp/ws/${cwd.replace(/\W+/g, "-")}`, id: "ws" }),
        withDirectoryLock: <T,>(_lockDir: string, operation: () => T): T => operation(),
      },
      storage: { readJson: async () => null, writeJson: async () => {} },
      events: { subscribe: () => () => {}, publish: () => {} },
      http: {
        writeJson: (_res: http.ServerResponse, status: number, body: unknown) => { responses.push({ status, body }); },
        readJsonBody: async <T,>() => requestBody as T,
        securityHeaders: (extra?: Readonly<Record<string, string>>) => ({ ...(extra ?? {}) }),
      },
      security: {
        validateHost: () => true,
        isTerminalAuthorized: () => true,
        isLockAuthorized: () => true,
        resolveTerminalSocketRole: () => options.role,
        isWriteAdmitted: () => true,
      },
      theaterFlags: { register: () => () => undefined },
      lifecycle: { registerCleanup: () => () => {} },
    },
  } as unknown as FleetPluginServerContext;

  registerShellRoutes(ctx, terminalRuntime);
  const handler = routes.get("shell/ticket");
  if (!handler) throw new Error("shell/ticket route was not registered");

  return {
    responses,
    async call(body) {
      requestBody = body;
      await handler({
        req: { method: "POST", url: "/plugins/terminal/shell/ticket", headers: {} } as http.IncomingMessage,
        res: {} as http.ServerResponse,
        pathname: "/plugins/terminal/shell/ticket",
      } as Parameters<RouteHandler>[0]);
    },
  };
}
