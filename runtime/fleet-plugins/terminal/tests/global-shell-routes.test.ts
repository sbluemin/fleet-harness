import { homedir } from "node:os";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it, vi } from "vitest";

import { registerGlobalShellRoutes } from "../server/global.js";
import { createTerminalSessionManager } from "../server/shared/session-manager.js";
import type { TerminalRuntime } from "../server/shared/index.js";
import type { TerminalLaunchSpec, TerminalPtyHandle, TerminalTicketContext } from "../server/shared/terminal-types.js";

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

interface HarnessOptions {
  readonly terminalAuthorized?: boolean;
  readonly body?: unknown;
  readonly canAttach?: boolean;
  readonly writeResult?: boolean;
}

class FakePty implements TerminalPtyHandle {
  readonly onDataCallbacks = new Set<(data: string) => void>();
  readonly onExitCallbacks = new Set<() => void>();

  onData(callback: (data: string) => void) {
    this.onDataCallbacks.add(callback);
    return { dispose: () => this.onDataCallbacks.delete(callback) };
  }

  onExit(callback: () => void) {
    this.onExitCallbacks.add(callback);
    return { dispose: () => this.onExitCallbacks.delete(callback) };
  }

  write(): void {
    // 테스트 PTY는 입력을 기록하지 않는다.
  }

  resize(): void {
    // 테스트 PTY는 크기 변경을 기록하지 않는다.
  }

  kill(): void {
    this.exit();
  }

  exit(): void {
    for (const callback of this.onExitCallbacks) callback();
  }
}

describe("global shell routes", () => {
  it("POST /plugins/terminal/global/ticket issues a home-directory singleton shell ticket without Theater lookup", async () => {
    const harness = createRouteHarness({ body: { operationId: "global-shell" }, writeResult: true });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 200, body: { ticket: "ticket-global-shell", ttlMs: 10_000 } }]);
    expect(harness.issueTicket).toHaveBeenCalledWith({
      cwd: homedir(),
      sessionId: "global-shell",
      operationId: "global-shell",
      operationType: "shell",
      pluginId: "terminal",
      kind: "shell",
    });
    expect(harness.operationGet).not.toHaveBeenCalled();
    expect(harness.resolveTheaterPath).not.toHaveBeenCalled();
  });

  it("rejects non-POST requests with the shell route method posture", async () => {
    const harness = createRouteHarness();
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 405, body: { error: "Method not allowed" } }]);
  });

  it("enforces terminal authorization before reading the request body", async () => {
    const harness = createRouteHarness({ terminalAuthorized: false, body: { operationId: "global-shell" } });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 401, body: { error: "Unauthorized" } }]);
    expect(harness.readJsonBody).not.toHaveBeenCalled();
  });

  it("rejects missing operationId/sessionId payloads", async () => {
    const harness = createRouteHarness({ body: {} });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 400, body: { error: "operation_id_required" } }]);
  });

  it("rejects non-global shell session ids", async () => {
    const harness = createRouteHarness({ body: { operationId: "operation-1" } });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 409, body: { error: "invalid_global_shell_operation" } }]);
    expect(harness.issueTicket).not.toHaveBeenCalled();
  });

  it("terminates a stale singleton session before issuing a replacement ticket", async () => {
    const harness = createRouteHarness({ body: { sessionId: "global-shell" }, writeResult: false });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.write).toHaveBeenCalledWith("global-shell", "");
    expect(harness.terminate).toHaveBeenCalledWith("global-shell");
    expect(harness.writes[0]?.status).toBe(200);
  });

  it("recreates the singleton session after the PTY exits", async () => {
    const ptys: FakePty[] = [];
    const sessions = createTerminalSessionManager({
      launch: async (cwd) => createLaunchSpec(cwd),
      startShell: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    const context = createGlobalShellTicketContext();

    await sessions.createSession(context);
    ptys[0]?.exit();
    await sessions.createSession(context);

    expect(ptys).toHaveLength(2);
    await sessions.stop();
  });
});

function createRouteHarness(options: HarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  const routers = new Map<string, Parameters<FleetPluginServerContext["registerRouter"]>[1]>();
  const operationGet = vi.fn();
  const resolveTheaterPath = vi.fn();
  const readJsonBody = vi.fn(async () => options.body ?? {});
  const issueTicket = vi.fn((context: TerminalTicketContext) => ({ ticket: `ticket-${context.sessionId}`, ttlMs: 10_000 }));
  const canAttach = vi.fn(() => options.canAttach ?? true);
  const write = vi.fn(() => options.writeResult ?? false);
  const terminate = vi.fn(() => true);
  const ctx = {
    pluginId: "terminal",
    manifest: { id: "terminal" },
    basePath: "/plugins/terminal",
    wsBasePath: "/plugins/terminal/ws",
    registerRouter: (path: string, handler: Parameters<FleetPluginServerContext["registerRouter"]>[1]) => { routers.set(path, handler); },
    registerWsHandler: () => undefined,
    host: {
      http: {
        readJsonBody,
        writeJson: (_res: http.ServerResponse, status: number, body: unknown) => { writes.push({ status, body }); },
      },
      operations: { get: operationGet },
      paths: { resolveTheaterPath },
      security: {
        validateHost: () => true,
        isTerminalAuthorized: () => options.terminalAuthorized ?? true,
        isLockAuthorized: () => true,
      },
    },
  } as unknown as FleetPluginServerContext;
  const runtime = {
    issueTicket,
    canAttach,
    write,
    terminate,
  } as unknown as TerminalRuntime;
  registerGlobalShellRoutes(ctx, runtime);
  const handle = routers.get("global/ticket");
  if (!handle) throw new Error("global shell router was not registered");
  return { handle, writes, operationGet, resolveTheaterPath, readJsonBody, issueTicket, write, terminate };
}

function req(method: string): http.IncomingMessage {
  return { method, headers: { "content-type": "application/json" } } as unknown as http.IncomingMessage;
}

function res(): http.ServerResponse {
  return {} as unknown as http.ServerResponse;
}

function createGlobalShellTicketContext(): TerminalTicketContext {
  return {
    cwd: homedir(),
    sessionId: "global-shell",
    operationId: "global-shell",
    operationType: "shell",
    pluginId: "terminal",
    kind: "shell",
  };
}

function createLaunchSpec(cwd: string | undefined): TerminalLaunchSpec {
  return {
    bin: "/bin/zsh",
    args: [],
    cwd: cwd ?? homedir(),
    env: {},
  };
}
