import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RailPanelContext } from "@fleet-console/sdk/rail";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { globalShellPanel } from "../client/global-shell/rail-panel.js";
import { registerGlobalShellRoutes } from "../server/global.js";
import { createTerminalSessionManager } from "../server/shared/session-manager.js";
import type { TerminalRuntime } from "../server/shared/index.js";
import type { TerminalLaunchSpec, TerminalPtyHandle, TerminalSocket, TerminalSocketData, TerminalTicketContext } from "../server/shared/terminal-types.js";

vi.mock("../client/shared/index.js", () => ({ TerminalSurface: () => null }));

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

interface HarnessOptions {
  readonly terminalAuthorized?: boolean;
  readonly body?: unknown;
  readonly bodies?: readonly unknown[];
  readonly canAttach?: boolean;
  readonly theaterPaths?: Readonly<Record<string, string | null>>;
}

const GLOBAL_SHELL_PREFIX = "global-shell:theater:";
const THEATER_A_ID = "theater-a";
const THEATER_B_ID = "theater-b";
const THEATER_A_OPERATION_ID = `${GLOBAL_SHELL_PREFIX}${THEATER_A_ID}`;
const THEATER_B_OPERATION_ID = `${GLOBAL_SHELL_PREFIX}${THEATER_B_ID}`;
const THEATER_A_PATH = "/theaters/a";
const THEATER_B_PATH = "/theaters/b";

class FakePty implements TerminalPtyHandle {
  readonly onDataCallbacks = new Set<(data: string) => void>();
  readonly onExitCallbacks = new Set<() => void>();
  killCalls = 0;

  onData(callback: (data: string) => void) {
    this.onDataCallbacks.add(callback);
    return { dispose: () => this.onDataCallbacks.delete(callback) };
  }

  onExit(callback: () => void) {
    this.onExitCallbacks.add(callback);
    return { dispose: () => this.onExitCallbacks.delete(callback) };
  }

  write(): void {
    // 입력 전달은 이 테스트의 관찰 대상이 아니다.
  }

  resize(): void {
    // geometry는 이 테스트의 관찰 대상이 아니다.
  }

  kill(): void {
    this.killCalls += 1;
    this.exit();
  }

  emitData(data: string): void {
    for (const callback of this.onDataCallbacks) callback(data);
  }

  exit(): void {
    for (const callback of [...this.onExitCallbacks]) callback();
  }
}

class FakeSocket implements TerminalSocket {
  readonly readyState = 1;
  readonly sent: string[] = [];
  private readonly closeCallbacks = new Set<() => void>();

  send(data: Buffer, options: { readonly binary: boolean }): void {
    if (options.binary) this.sent.push(data.toString("utf8"));
  }

  close(): void {
    this.disconnect();
  }

  on(_event: "message", _listener: (data: TerminalSocketData, isBinary: boolean) => void): void {
    // 입력 프레임은 이 테스트의 관찰 대상이 아니다.
  }

  once(_event: "close", listener: () => void): void {
    this.closeCallbacks.add(listener);
  }

  disconnect(): void {
    for (const callback of [...this.closeCallbacks]) callback();
    this.closeCallbacks.clear();
  }
}

describe("Global Shell rail identity", () => {
  it("derives deterministic A→B→A operation identities from the active Theater", () => {
    expect(panelOperationId(THEATER_A_ID)).toBe(THEATER_A_OPERATION_ID);
    expect(panelOperationId(THEATER_B_ID)).toBe(THEATER_B_OPERATION_ID);
    expect(panelOperationId(THEATER_A_ID)).toBe(THEATER_A_OPERATION_ID);
    expect(panelOperationId(null)).toBe(GLOBAL_SHELL_PREFIX);
  });
});

describe("global shell ticket route", () => {
  it("issues A→B→A tickets with Theater-specific identity and root cwd", async () => {
    const harness = createRouteHarness({
      bodies: [
        { operationId: THEATER_A_OPERATION_ID },
        { operationId: THEATER_B_OPERATION_ID },
        { operationId: THEATER_A_OPERATION_ID },
      ],
      theaterPaths: { [THEATER_A_ID]: THEATER_A_PATH, [THEATER_B_ID]: THEATER_B_PATH },
    });

    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.resolveTheaterPath.mock.calls).toEqual([[THEATER_A_ID], [THEATER_B_ID], [THEATER_A_ID]]);
    expect(harness.canAttach.mock.calls).toEqual([[THEATER_A_OPERATION_ID], [THEATER_B_OPERATION_ID], [THEATER_A_OPERATION_ID]]);
    expect(harness.issueTicket.mock.calls.map(([context]) => context)).toEqual([
      globalShellContext(THEATER_A_ID, THEATER_A_PATH),
      globalShellContext(THEATER_B_ID, THEATER_B_PATH),
      globalShellContext(THEATER_A_ID, THEATER_A_PATH),
    ]);
    expect(harness.writes.map(({ status }) => status)).toEqual([200, 200, 200]);
  });

  it("keeps the sessionId request alias", async () => {
    const harness = createRouteHarness({
      body: { sessionId: THEATER_A_OPERATION_ID },
      theaterPaths: { [THEATER_A_ID]: THEATER_A_PATH },
    });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.issueTicket).toHaveBeenCalledWith(globalShellContext(THEATER_A_ID, THEATER_A_PATH));
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.terminate).not.toHaveBeenCalled();
  });

  it("rejects non-POST requests before authorization or body work", async () => {
    const harness = createRouteHarness({ terminalAuthorized: false });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 405, body: { error: "Method not allowed" } }]);
    expect(harness.readJsonBody).not.toHaveBeenCalled();
    expect(harness.resolveTheaterPath).not.toHaveBeenCalled();
  });

  it("enforces terminal authorization before Origin, body, or Theater resolution", async () => {
    const harness = createRouteHarness({ terminalAuthorized: false, body: { operationId: THEATER_A_OPERATION_ID } });
    await harness.handle({ req: req("POST", null), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 401, body: { error: "Unauthorized" } }]);
    expect(harness.readJsonBody).not.toHaveBeenCalled();
    expect(harness.resolveTheaterPath).not.toHaveBeenCalled();
    expect(harness.canAttach).not.toHaveBeenCalled();
  });

  it("rejects missing Origin before body or Theater resolution", async () => {
    const harness = createRouteHarness({ body: { operationId: THEATER_A_OPERATION_ID } });
    await harness.handle({ req: req("POST", null), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 401, body: { error: "Unauthorized" } }]);
    expect(harness.readJsonBody).not.toHaveBeenCalled();
    expect(harness.resolveTheaterPath).not.toHaveBeenCalled();
    expect(harness.canAttach).not.toHaveBeenCalled();
  });

  it("rejects missing operationId/sessionId without Theater or PTY work", async () => {
    const harness = createRouteHarness({ body: {} });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 400, body: { error: "operation_id_required" } }]);
    expectNoTheaterOrPtyWork(harness);
  });

  it("rejects an empty reserved Theater identity without Theater or PTY work", async () => {
    const harness = createRouteHarness({ body: { operationId: GLOBAL_SHELL_PREFIX } });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 400, body: { error: "theater_id_required" } }]);
    expectNoTheaterOrPtyWork(harness);
  });

  it.each([
    "operation-1",
    `${GLOBAL_SHELL_PREFIX}%E0%A4%A`,
    `${GLOBAL_SHELL_PREFIX}%2f`,
  ])("rejects malformed or non-canonical Global Shell identity %s", async (operationId) => {
    const harness = createRouteHarness({ body: { operationId } });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 409, body: { error: "invalid_global_shell_operation" } }]);
    expectNoTheaterOrPtyWork(harness);
  });

  it("rejects an unresolved Theater before canAttach or ticket issuance", async () => {
    const harness = createRouteHarness({
      body: { operationId: THEATER_A_OPERATION_ID },
      theaterPaths: { [THEATER_A_ID]: null },
    });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 404, body: { error: "theater_not_found" } }]);
    expect(harness.resolveTheaterPath).toHaveBeenCalledWith(THEATER_A_ID);
    expect(harness.canAttach).not.toHaveBeenCalled();
    expect(harness.issueTicket).not.toHaveBeenCalled();
  });

  it("resolves the Theater before reporting capacity exhaustion", async () => {
    const harness = createRouteHarness({
      body: { operationId: THEATER_A_OPERATION_ID },
      canAttach: false,
      theaterPaths: { [THEATER_A_ID]: THEATER_A_PATH },
    });
    await harness.handle({ req: req("POST"), res: res(), pathname: "/plugins/terminal/global/ticket" });

    expect(harness.writes).toEqual([{ status: 503, body: { error: "Terminal session capacity exhausted" } }]);
    expect(harness.resolveTheaterPath).toHaveBeenCalledBefore(harness.canAttach);
    expect(harness.issueTicket).not.toHaveBeenCalled();
  });
});

describe("Global Shell Theater session persistence", () => {
  it("isolates A/B PTYs and scrollback, reuses A on return, and recreates only exited A", async () => {
    const ptys: FakePty[] = [];
    const launchCwds: Array<string | undefined> = [];
    const sessions = createTerminalSessionManager({
      launch: async (cwd) => {
        launchCwds.push(cwd);
        return createLaunchSpec(cwd);
      },
      startShell: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    const contextA = globalShellContext(THEATER_A_ID, THEATER_A_PATH);
    const contextB = globalShellContext(THEATER_B_ID, THEATER_B_PATH);

    const socketA = new FakeSocket();
    await sessions.attach(socketA, contextA);
    ptys[0]?.emitData("A-only-marker\n");
    socketA.disconnect();
    expect(ptys[0]?.killCalls).toBe(0);

    const socketB = new FakeSocket();
    await sessions.attach(socketB, contextB);
    ptys[1]?.emitData("B-only-marker\n");
    expect(socketB.sent.join("")).toContain("B-only-marker");
    expect(socketB.sent.join("")).not.toContain("A-only-marker");
    socketB.disconnect();

    const socketAReturn = new FakeSocket();
    await sessions.attach(socketAReturn, contextA);
    expect(ptys).toHaveLength(2);
    expect(launchCwds).toEqual([THEATER_A_PATH, THEATER_B_PATH]);
    expect(socketAReturn.sent.join("")).toContain("A-only-marker");
    expect(socketAReturn.sent.join("")).not.toContain("B-only-marker");

    ptys[0]?.exit();
    const socketAFresh = new FakeSocket();
    await sessions.attach(socketAFresh, contextA);
    expect(ptys).toHaveLength(3);
    expect(launchCwds).toEqual([THEATER_A_PATH, THEATER_B_PATH, THEATER_A_PATH]);
    expect(socketAFresh.sent.join("")).not.toContain("A-only-marker");
    expect(ptys[1]?.killCalls).toBe(0);

    await sessions.stop();
  });
});

function panelOperationId(theaterId: string | null): unknown {
  const rendered = globalShellPanel.render({ theaterId } as RailPanelContext);
  expect(isValidElement(rendered)).toBe(true);
  const child = (rendered as ReactElement<{ readonly children: unknown }>).props.children;
  expect(isValidElement(child)).toBe(true);
  return (child as ReactElement<{ readonly operationId?: unknown }>).props.operationId;
}

function createRouteHarness(options: HarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  const routers = new Map<string, Parameters<FleetPluginServerContext["registerRouter"]>[1]>();
  const queuedBodies = [...(options.bodies ?? [])];
  const readJsonBody = vi.fn(async () => queuedBodies.length > 0 ? queuedBodies.shift() : options.body ?? {});
  const resolveTheaterPath = vi.fn((theaterId: string) => {
    if (options.theaterPaths && Object.hasOwn(options.theaterPaths, theaterId)) return options.theaterPaths[theaterId] ?? null;
    return null;
  });
  const issueTicket = vi.fn((context: TerminalTicketContext) => ({ ticket: `ticket-${context.sessionId}`, ttlMs: 10_000 }));
  const canAttach = vi.fn(() => options.canAttach ?? true);
  const write = vi.fn(() => false);
  const terminate = vi.fn(() => true);
  const ctx = {
    pluginId: "terminal",
    manifest: { id: "terminal" },
    basePath: "/plugins/terminal",
    wsBasePath: "/plugins/terminal/ws",
    registerRouter: (routerPath: string, handler: Parameters<FleetPluginServerContext["registerRouter"]>[1]) => { routers.set(routerPath, handler); },
    registerWsHandler: () => undefined,
    host: {
      http: {
        readJsonBody,
        writeJson: (_res: http.ServerResponse, status: number, body: unknown) => { writes.push({ status, body }); },
      },
      paths: { resolveTheaterPath },
      security: {
        validateHost: () => true,
        isTerminalAuthorized: () => options.terminalAuthorized ?? true,
        isLockAuthorized: () => true,
      },
    },
  } as unknown as FleetPluginServerContext;
  const runtime = { issueTicket, canAttach, write, terminate } as unknown as TerminalRuntime;
  registerGlobalShellRoutes(ctx, runtime);
  const handle = routers.get("global/ticket");
  if (!handle) throw new Error("global shell router was not registered");
  return { handle, writes, resolveTheaterPath, readJsonBody, issueTicket, canAttach, write, terminate };
}

function expectNoTheaterOrPtyWork(harness: ReturnType<typeof createRouteHarness>): void {
  expect(harness.resolveTheaterPath).not.toHaveBeenCalled();
  expect(harness.canAttach).not.toHaveBeenCalled();
  expect(harness.issueTicket).not.toHaveBeenCalled();
}

function req(method: string, origin: string | null = "http://127.0.0.1:7777"): http.IncomingMessage {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  return { method, headers } as unknown as http.IncomingMessage;
}

function res(): http.ServerResponse {
  return {} as unknown as http.ServerResponse;
}

function globalShellContext(theaterId: string, cwd: string): TerminalTicketContext {
  const operationId = `${GLOBAL_SHELL_PREFIX}${encodeURIComponent(theaterId)}`;
  return {
    cwd,
    sessionId: operationId,
    operationId,
    operationType: "shell",
    pluginId: "terminal",
    theaterId,
    kind: "shell",
  };
}

function createLaunchSpec(cwd: string | undefined): TerminalLaunchSpec {
  return {
    bin: "/bin/zsh",
    args: [],
    cwd: cwd ?? "/",
    env: {},
  };
}
