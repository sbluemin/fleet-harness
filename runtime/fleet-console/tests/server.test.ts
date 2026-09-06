import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleLockPayload } from "../core/host/console-contract-types.js";
import { DESKTOP_FULLSCREEN_EVENT, DESKTOP_FULLSCREEN_PATH } from "../core/host/desktop-contract.js";
import { DESKTOP_THEME_EVENTS_PATH, DESKTOP_THEME_PATH } from "../core/host/desktop-contract.js";
import { DESKTOP_RESOURCE_ROOT_MARKER, formatDesktopResourceRootMarker } from "@fleet-console/desktop-protocol";
import { createConsoleLock } from "../core/host/lock.js";
import { deriveOperationLabel } from "../../fleet-plugins/terminal/server/agent-api/auto-name.js";
import { createConsoleObservabilityStore } from "../../fleet-plugins/terminal/server/agent-api/observability-store.js";
import { createConsoleServer, SERVER_API_CATALOG, type ConsoleServer, type ConsoleServerDeps } from "../core/host/server.js";
import type { AgentCliDetector } from "../../fleet-plugins/terminal/server/agent-api/agent-cli-detect.js";
import { canonicalizeTheaterPathSync, workspaceHash } from "../core/host/theaters/theater-domain.js";
import { TheaterRegistry } from "../core/host/theaters/theater-domain.js";
import { WorkspaceRegistry } from "../../fleet-plugins/codex/server/codex/workspaces.js";
import type { TerminalLaunchContext, TerminalLaunchSpec, TerminalPtyHandle } from "../../fleet-plugins/terminal/server/shared/terminal-types.js";
import { createPluginTerminalUpgradeHandler } from "../../fleet-plugins/terminal/server/shared/ws.js";

const fleetAdmiralMock = vi.hoisted(() => ({
  agentRuntimeQueue: [] as unknown[],
  esbuildExternals: [] as string[][],
  externalizeForReminderFixture: false,
  resolveProfile: null as null | ((...args: readonly unknown[]) => unknown),
}));

vi.mock("@dotobokuri/fleet-admiral", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dotobokuri/fleet-admiral")>();
  return {
    ...actual,
    createFleetGatewayAgentRuntimeLifecycle: (deps: Parameters<typeof actual.createFleetGatewayAgentRuntimeLifecycle>[0]) =>
      fleetAdmiralMock.agentRuntimeQueue.shift() ?? actual.createFleetGatewayAgentRuntimeLifecycle(deps),
    resolveAgentCliProfile: (...args: Parameters<typeof actual.resolveAgentCliProfile>) =>
      fleetAdmiralMock.resolveProfile?.(...args) ?? actual.resolveAgentCliProfile(...args),
  };
});

vi.mock("esbuild", async (importOriginal) => {
  const actual = await importOriginal<typeof import("esbuild")>();
  return {
    ...actual,
    build: (options: Parameters<typeof actual.build>[0]) => {
      if (!fleetAdmiralMock.externalizeForReminderFixture) {
        fleetAdmiralMock.esbuildExternals.push([...(options.external ?? [])]);
        return actual.build(options);
      }
      const external = [...(options.external ?? []), "@dotobokuri/fleet-admiral"];
      fleetAdmiralMock.esbuildExternals.push(external);
      return actual.build({ ...options, external });
    },
  };
});

interface ServerFixture {
  readonly dir: string;
  readonly fleetDataDir: string;
  readonly lockFile: string;
  readonly server: ConsoleServer;
  readonly endpoint: string;
  readonly lock: ConsoleLockPayload;
}

interface FakeConsoleRuntime {
  readonly dedicatedMcpSession: {
    getEndpoint(): Promise<{ readonly servers: readonly { readonly name: string; readonly url: string }[] }>;
    issueSessionToken(request: { readonly label: string; readonly cwd: string }): readonly { readonly name: string; readonly token: string }[];
    releaseSessionToken(label: string): void;
  };
  readonly mcpRegistry: {
    getAllAgentTools(): readonly unknown[];
  };
  readonly cleanup: ReturnType<typeof vi.fn>;
  emit(event: unknown): void;
}

interface ExitablePty extends TerminalPtyHandle {
  emitExit(): void;
}

const tempDirs: string[] = [];
const servers: ConsoleServer[] = [];
let previousStaticIndex: string | null | undefined;
const CONSOLE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  fleetAdmiralMock.externalizeForReminderFixture = false;
  for (const server of servers.splice(0)) await server.stop();
  fleetAdmiralMock.agentRuntimeQueue.length = 0;
  fleetAdmiralMock.esbuildExternals.length = 0;
  fleetAdmiralMock.resolveProfile = null;
  delete (globalThis as { __fleetTerminalLaunch?: unknown }).__fleetTerminalLaunch;
  delete (globalThis as { __fleetTerminalStartShell?: unknown }).__fleetTerminalStartShell;
  delete (globalThis as { __fleetAgentCliDetector?: unknown }).__fleetAgentCliDetector;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  restoreStaticIndex();
});

describe("console terminal observability", () => {

  it("serves local environment diagnostics only through the loopback Host and allowed Origin", async () => {
    const fixture = await startFixture({ release: { channel: "local", version: "test", packageRoot: CONSOLE_PACKAGE_ROOT } });
    const url = new URL("api/v1/environment", fixture.endpoint);
    const origin = new URL(fixture.endpoint).origin;

    expect(await requestWithHost(url, origin, "localhost:1", "GET")).toBe(403);
    const foreign = await fetch(url, { headers: { Origin: "http://127.0.0.1:9999" } });
    expect(foreign.status).toBe(401);
    const exact = await fetch(url, { headers: { Origin: origin } });
    expect(exact.status).toBe(200);
    expect(exact.headers.get("cache-control")).toBe("no-store");
    await expect(exact.json()).resolves.toEqual({
      channel: "local",
      version: "test",
      effectivePort: fixture.lock.port,
      dataDir: path.join(fixture.fleetDataDir, "console"),
      lockFile: fixture.lockFile,
    });
    expect((await fetch(url)).status).toBe(200);
  });

  it("injects dormant durable operations without exposing server-only provider data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-dormant-store-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore();

    const session = store.injectDormantOperation({
      sessionId: "session-a",
      theaterId: workspaceHash(fs.realpathSync.native(dir)),
      cwd: dir,
      createdAt: 1_000,
      session: {
        harness: "claude-code",
        id: "provider-session-secret",
        transcriptPath: "/secret/transcript.jsonl",
        source: "startup",
        capturedAt: "2026-06-16T00:00:00.000Z",
      },
    });
    const serialized = JSON.stringify({ session, sessions: store.listTerminalSessions() });

    expect(session).toMatchObject({
      sessionId: "session-a",
      status: "dormant",
      resumeAvailable: true,
    });
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain("provider-session-secret");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("providerSession");
  });

});

describe("console static and terminal ticket boundary", () => {

  it.skip("keeps MCP bearer tokens out of terminal tickets, observer snapshots, SSE frames, static HTML, and launch errors", async () => {
    const fakeToken = "mcp-token-seeded-secret";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-token-boundary-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
      terminalLaunch: async () => {
        throw new Error(fakeToken);
      },
    });
    ensureStaticIndex();
    const headers = { "Content-Type": "application/json" };

    const ticket = await (await fetch(`${fixture.endpoint}terminal/ticket`, { method: "POST", headers })).json();
    const grant = await issueTheaterFolderGrant(fixture, dir, headers);
    const failedLaunch = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId, cliId: "claude" }),
    });
    const failedBody = await failedLaunch.json();
    const terminalSessions = await getJson<unknown>(`${fixture.endpoint}terminal/sessions`);
    const observerTenants = await getJson<unknown>(`${fixture.endpoint}observer/tenants`);
    const observerJobs = await getJson<unknown>(`${fixture.endpoint}observer/jobs`);
    const sse = await readObserverChunk(fixture);
    const staticHtml = await (await fetch(`${fixture.endpoint}console/`)).text();
    const serialized = JSON.stringify({ ticket, failedBody, terminalSessions, observerTenants, observerJobs, sse, staticHtml });

    expect(failedLaunch.status).toBe(503);
    expect(failedBody).toEqual({ error: "terminal_unavailable" });
    expect(serialized).not.toContain(fakeToken);
    expect(serialized).not.toContain(dir);
  });

  it("rejects Theater folder routes when the browser Origin is not the console origin", async () => {
    const fixture = await startFixture();

    const response = await fetch(`${fixture.endpoint}api/v1/theaters/folder-listings`, {
      method: "POST",
      headers: { origin: "http://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ path: null }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects update apply without an exact console Origin", async () => {
    const fixture = await startFixture({
      release: { channel: "stable", version: "1.0.0", packageRoot: "/pkg" },
    });

    const response = await fetch(`${fixture.endpoint}api/v1/updates/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it.skip("creates terminal sessions from one-use folder grants and rejects raw cwd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-session-"));
    tempDirs.push(dir);
    const launches: TerminalLaunchSpec[] = [];
    const fixture = await startFixture({
      terminalLaunch: createMockLaunch,
      terminalStartShell: (launch) => {
        launches.push(launch);
        return createMockPty();
      },
    });
    const headers = { "Content-Type": "application/json" };

    const grant = await issueTheaterFolderGrant(fixture, dir, headers);
    const noCliGrant = await issueTheaterFolderGrant(fixture, dir, headers);
    const rawCwd = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: dir }),
    });
    const missingCli = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: noCliGrant.folderGrantId }),
    });
    const created = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId, cliId: "claude" }),
    });
    const replay = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId, cliId: "claude" }),
    });
    const list = await fetch(`${fixture.endpoint}terminal/sessions`, { headers });
    const session = await created.json() as { readonly sessionId: string; readonly status: string; readonly cwd?: unknown };

    expect(rawCwd.status).toBe(400);
    expect(missingCli.status).toBe(400);
    await expect(missingCli.json()).resolves.toEqual({ error: "agent_cli_required" });
    expect(created.status).toBe(200);
    expect(replay.status).toBe(400);
    expect(session.status).toBe("terminal-only");
    expect(session.cwd).toBeUndefined();
    expect(launches).toHaveLength(1);
    expect(launches[0]?.cwd).toBe(dir);
    expect(launches[0]?.env).toMatchObject({
      FLEET_CONSOLE_SESSION_ID: session.sessionId,
      INIT_CWD: dir,
      PWD: dir,
      TERM: "xterm-256color",
    });
    const stateFile = path.join(fixture.fleetDataDir, "console", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { version: number; operations: Array<{ id?: string; pluginId?: string; type?: string; payload?: { providerSession?: unknown } }> };
    expect(state.version).toBe(4);
    expect(state.operations).toHaveLength(1);
    expect(state.operations[0]).toMatchObject({ id: session.sessionId, pluginId: "terminal", type: "agent" });
    expect(state.operations[0]?.payload?.providerSession).toBeUndefined();
    if (process.platform !== "win32") expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    await expect(list.json()).resolves.toMatchObject({ sessions: [{ sessionId: session.sessionId, status: "terminal-only" }] });
  });

  it("does not overwrite a durable state with an unsupported version", async () => {
    const original = JSON.stringify({
      version: 0,
      theaters: [{ id: "future-theater" }],
      operations: [{ id: "future-operation" }],
    });
    let stateFile = "";
    await startFixture({
      beforeCreateServer: ({ fleetDataDir }) => {
        const consoleDir = path.join(fleetDataDir, "console");
        fs.mkdirSync(consoleDir, { recursive: true });
        stateFile = path.join(consoleDir, "state.json");
        fs.writeFileSync(stateFile, original);
      },
    });

    expect(fs.readFileSync(stateFile, "utf8")).toBe(original);
  });

  it("rehydrates durable provider titles as dormant without starting PTYs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-rehydrate-"));
    tempDirs.push(dir);
    const realpath = fs.realpathSync.native(dir);
    const theaterId = workspaceHash(realpath);
    const startedShells: string[] = [];
    const fixture = await startFixture({
      beforeCreateServer: ({ fleetDataDir }) => {
        const consoleDir = path.join(fleetDataDir, "console");
        fs.mkdirSync(consoleDir, { recursive: true });
        fs.writeFileSync(path.join(consoleDir, "state.json"), JSON.stringify({
          version: 2,
          theaters: [{
            id: theaterId,
            path: dir,
            realpath,
            label: path.basename(dir),
            registeredAt: "2026-06-16T00:00:00.000Z",
            lastOpenedAt: "2026-06-16T00:00:01.000Z",
          }],
          operations: [{
            id: "session-a",
            theaterId,
            title: "Durable provider title",
            pluginId: "terminal",
            type: "agent",
            payload: {
              cwd: dir,
              providerTitle: { source: "provider" },
              session: {
                harness: "claude-code",
                id: "provider-session-secret",
                capturedAt: "2026-06-16T00:00:02.000Z",
              },
            },
            ts: { createdAt: 1_000, updatedAt: 1_000 },
          }],
        }));
      },
      terminalStartShell: (launch) => {
        startedShells.push(launch.cwd);
        return createMockPty();
      },
    });

    const theaters = await getJson<{ readonly theaters: readonly Record<string, unknown>[] }>(`${fixture.endpoint}api/v1/theaters`);
    const sessions = await getJson<{ readonly sessions: readonly Record<string, unknown>[] }>(`${fixture.endpoint}plugins/terminal/agent/sessions`);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.fleetDataDir, "console", "state.json"), "utf8")) as { readonly operations: ReadonlyArray<{ readonly title?: unknown; readonly payload?: { readonly session?: unknown; readonly providerTitle?: unknown } }> };
    const serialized = JSON.stringify({ theaters, sessions });

    expect(startedShells).toEqual([]);
    expect(theaters.theaters[0]).toMatchObject({ id: theaterId, label: path.basename(dir) });
    expect(sessions.sessions[0]).toMatchObject({ sessionId: "session-a", status: "dormant", resumeAvailable: true });
    expect(sessions.sessions[0]).toMatchObject({ label: "Durable provider title" });
    expect(state.operations[0]?.payload?.session).toMatchObject({ harness: "claude-code", id: "provider-session-secret" });
    expect(state.operations[0]).toMatchObject({ title: "Durable provider title", payload: { providerTitle: { source: "provider" } } });
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain("provider-session-secret");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("providerSession");
    expect(serialized).not.toContain("providerTitle");
  });

  it("rejects Theater registration without a valid folder grant", async () => {
    const failed = await startFixture();

    const errorResponse = await fetch(`${failed.endpoint}api/v1/theaters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderGrantId: "missing-grant" }),
    });
    await expect(errorResponse.json()).resolves.toEqual({ error: "invalid_folder_grant" });
    expect(errorResponse.status).toBe(400);
  });

  it("rejects terminal WebSocket upgrades without a valid ticket boundary", () => {
    let destroyed = 0;
    const handler = createPluginTerminalUpgradeHandler({
      tickets: { consume: () => null },
      sessions: { canAttach: () => true, createSession: async () => undefined, attach: async () => undefined, attachViewer: () => false, renegotiateSockets: () => {}, getSessionMessagePolicy: () => undefined, getSessionRenameCommand: () => undefined, getSessionLastActivityAt: () => null, resolveSessionIdentity: async () => null, terminate: () => false, stop: async () => undefined, writeToSession: () => false },
      isAuthorized: () => true,
    });

    const handled = handler.handleUpgrade({
      req: {
        url: `${"/plugins/terminal"}/ws`,
        headers: { origin: "http://127.0.0.1:37283" },
        rawHeaders: ["Host", "127.0.0.1:37283"],
      } as never,
      socket: { destroy: () => { destroyed += 1; } } as never,
      head: Buffer.alloc(0),
      pathname: `${"/plugins/terminal"}/ws`,
    });

    expect(handled).toBe(true);
    expect(destroyed).toBe(1);
    handler.close();
  });
});

async function startReminderFixture(options: Parameters<typeof startFixture>[0] = {}): Promise<ServerFixture> {
  fleetAdmiralMock.externalizeForReminderFixture = true;
  try {
    return await startFixture(options);
  } finally {
    fleetAdmiralMock.externalizeForReminderFixture = false;
  }
}

const MANAGED_ROOTS: string[] = [];
afterEach(() => { for (const dir of MANAGED_ROOTS.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function startFixture(options: {
  readonly agentRuntime?: ConsoleServerDeps["agentRuntime"];
  readonly agentCliDetector?: AgentCliDetector;
  readonly beforeCreateServer?: (paths: { readonly fleetDataDir: string }) => void;
  readonly terminalLaunch?: (cwd?: string, context?: TerminalLaunchContext) => Promise<TerminalLaunchSpec>;
  readonly terminalStartShell?: (launch: TerminalLaunchSpec) => TerminalPtyHandle;
  readonly release?: ConsoleServerDeps["release"];
  readonly updateApply?: ConsoleServerDeps["updateApply"];
  readonly updateCheck?: ConsoleServerDeps["updateCheck"];
  readonly useDefaultPort?: boolean;
} = {}): Promise<ServerFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-server-"));
  const fleetDataDir = path.join(dir, "fleet-home");
  options.beforeCreateServer?.({ fleetDataDir });
  const terminalHooks = globalThis as {
    __fleetTerminalLaunch?: typeof options.terminalLaunch;
    __fleetTerminalStartShell?: typeof options.terminalStartShell;
    __fleetAgentCliDetector?: AgentCliDetector;
  };
  if (options.terminalLaunch) terminalHooks.__fleetTerminalLaunch = options.terminalLaunch;
  if (options.terminalStartShell) terminalHooks.__fleetTerminalStartShell = options.terminalStartShell;
  // 플러그인은 호스트와 별개 모듈 인스턴스라 createConsoleServer 인자로는 detector가 닿지 않는다.
  // 설치 여부를 여기서 고정하지 않으면 세션 생성 테스트가 이 기계의 PATH에 Claude Code가 있는지에
  // 좌우된다 — 개발기에서는 통과하고 CI에서만 409로 떨어진다.
  terminalHooks.__fleetAgentCliDetector = options.agentCliDetector ?? createStubAgentCliDetector();
  // 설치 판정을 통과해도 실행 스펙을 만들 때 바이너리를 한 번 더 해석한다. terminalLaunch를 주입하지
  // 않는 테스트는 그 해석까지 도달하므로, 문서화된 오버라이드로 존재하는 실행파일을 가리켜 둔다.
  process.env.CLAUDE_BIN ??= process.execPath;
  tempDirs.push(dir);
  const lockFile = path.join(dir, "console.lock");
  const server = createConsoleServer({
    ...(options.useDefaultPort ? {} : { port: 0 }),
    version: "test",
    agentRuntime: options.agentRuntime,
    dataDir: fleetDataDir,
    release: options.release,
    updateApply: options.updateApply,
    updateCheck: options.updateCheck,
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile });
  const lock = createConsoleLock().readLock(lockFile)!;
  return { dir, fleetDataDir, lockFile, server, endpoint, lock };
}

function createStubAgentCliDetector(overrides: Record<string, boolean> = {}): AgentCliDetector {
  // cliCommand 단위 바이너리(claude/codex/cursor-agent)별 설치 여부를 stub한다. 기본 모두 설치됨.
  const commands = ["claude", "codex", "cursor-agent"];
  return {
    detect: async () => commands.map((id) => ({
      id,
      displayName: id,
      available: overrides[id] ?? true,
      version: null,
    })),
  };
}

function createPluginPackageRoot(options: { readonly demoRoutes: string; readonly demoRoutesFile?: "routes.mjs" | "routes.ts" }): { readonly release: ConsoleServerDeps["release"] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-package-"));
  tempDirs.push(dir);
  const packageRoot = path.join(dir, "runtime", "fleet-console");
  const pluginsRoot = path.join(dir, "runtime", "fleet-plugins");
  writeTestPlugin(path.join(pluginsRoot, "terminal"), "terminal", [
    "export function register(ctx) {",
    "}",
  ].join("\n"));
  writeTestPlugin(path.join(pluginsRoot, "demo"), "demo", options.demoRoutes, options.demoRoutesFile);
  fs.mkdirSync(packageRoot, { recursive: true });
  return { release: { channel: "local", version: "test", packageRoot } };
}

function writeTestPlugin(pluginRoot: string, id: string, routes: string, routesFile: "routes.mjs" | "routes.ts" = "routes.mjs"): void {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify({ id, routes: routesFile }));
  fs.writeFileSync(path.join(pluginRoot, routesFile), routes);
}

function createDeferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function createTerminalSession(fixture: ServerFixture, headers: Record<string, string>, cwd: string): Promise<{ readonly sessionId: string }> {
  const grant = await issueTheaterFolderGrant(fixture, cwd, headers);
  const created = await fetch(`${fixture.endpoint}terminal/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ folderGrantId: grant.folderGrantId, cliId: "claude" }),
  });
  expect(created.status).toBe(200);
  return created.json() as Promise<{ readonly sessionId: string }>;
}

async function createAgentTerminalSession(fixture: ServerFixture, theaterId: string, headers: Record<string, string>): Promise<{ readonly sessionId: string }> {
  const created = await fetch(`${fixture.endpoint}plugins/terminal/agent/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ theaterId, cliId: "claude" }),
  });
  expect(created.status).toBe(200);
  return created.json() as Promise<{ readonly sessionId: string }>;
}

async function createOperation(fixture: ServerFixture, theaterId: string, input: { readonly type: string; readonly pluginId: string }): Promise<{ readonly id: string }> {
  const response = await fetch(`${fixture.endpoint}api/v1/operations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      theaterId,
      type: input.type,
      pluginId: input.pluginId,
      title: input.type === "shell" ? "Shell" : "Agent",
      payload: {},
    }),
  });
  expect(response.status).toBe(201);
  const payload = await response.json() as { readonly operation?: { readonly id?: unknown } };
  const operationId = payload.operation?.id;
  expect(typeof operationId).toBe("string");
  return { id: operationId as string };
}

async function issueTheaterFolderGrant(fixture: ServerFixture, cwd: string, headers: Record<string, string> = { "Content-Type": "application/json" }): Promise<{ readonly folderGrantId: string }> {
  const response = await fetch(`${fixture.endpoint}api/v1/theaters/folder-grants`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path: cwd }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ readonly folderGrantId: string }>;
}

async function createTheater(fixture: ServerFixture, cwd: string): Promise<{ readonly id: string }> {
  const grant = await issueTheaterFolderGrant(fixture, cwd);
  const response = await fetch(`${fixture.endpoint}api/v1/theaters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderGrantId: grant.folderGrantId }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ readonly id: string }>;
}

async function fetchWithBlockedPortRetry(request: (fixture: ServerFixture) => Promise<Response>): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fixture = await startFixture();
    try {
      return await request(fixture);
    } catch (error) {
      lastError = error;
      if (!String(error).includes("bad port")) throw error;
    }
  }
  throw lastError;
}

function createFakeConsoleRuntime(
  issuedLabels: string[],
  releasedLabels: string[],
  tokenRequests: Array<{ readonly label: string; readonly cwd: string }> = [],
): FakeConsoleRuntime {
  const handlers = new Set<(event: unknown) => void>();
  return {
    dedicatedMcpSession: {
      getEndpoint: async () => ({ servers: [{ name: "fleet-tools", url: "http://127.0.0.1/fleet-tools" }] }),
      issueSessionToken(request) {
        issuedLabels.push(request.label);
        tokenRequests.push(request);
        return [{ name: "fleet-tools", token: `token-${request.label}` }];
      },
      releaseSessionToken(label) {
        releasedLabels.push(label);
      },
    },
    mcpRegistry: {
      getAllAgentTools: () => [{ name: "carrier_dispatch" }],
    },
    cleanup: vi.fn(async () => undefined),
    emit(event) {
      for (const handler of handlers) handler(event);
    },
  };
}

function createFakePty(): TerminalPtyHandle {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function readObserverChunk(fixture: ServerFixture, pathname = "observer/events"): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(`${fixture.endpoint}${pathname}`, { signal: controller.signal });
  const chunk = new TextDecoder().decode((await response.body!.getReader().read()).value);
  controller.abort();
  return chunk;
}

function ensureStaticIndex(content = "<!doctype html><title>console-test-index</title>"): string {
  const indexPath = path.resolve("dist/client/index.html");
  if (previousStaticIndex === undefined) {
    previousStaticIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : null;
  }
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, content);
  return indexPath;
}

function restoreStaticIndex(): void {
  if (previousStaticIndex === undefined) return;
  const indexPath = path.resolve("dist/client/index.html");
  if (previousStaticIndex === null) {
    fs.rmSync(indexPath, { force: true });
  } else {
    fs.writeFileSync(indexPath, previousStaticIndex);
  }
  previousStaticIndex = undefined;
}

function createMockPty(): TerminalPtyHandle {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
  };
}

function createExitablePty(): ExitablePty {
  const exitListeners: Array<() => void> = [];
  return {
    emitExit() {
      for (const listener of exitListeners) listener();
    },
    onData: () => ({ dispose: () => undefined }),
    onExit(callback) {
      exitListeners.push(callback);
      return {
        dispose() {
          const index = exitListeners.indexOf(callback);
          if (index >= 0) exitListeners.splice(index, 1);
        },
      };
    },
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
  };
}

function createRecordingPty(): TerminalPtyHandle & { readonly writes: string[] } {
  return {
    writes: [],
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write(data) {
      this.writes.push(typeof data === "string" ? data : data.toString("utf8"));
    },
    resize: () => undefined,
    kill: () => undefined,
  };
}

async function createMockLaunch(cwd?: string, context?: { readonly sessionId?: string; readonly cliId?: string; readonly resumeSessionId?: string }): Promise<TerminalLaunchSpec> {
  return {
    bin: "mock",
    args: [],
    cwd: cwd ?? "/",
    env: {
      ...(context?.sessionId ? { FLEET_CONSOLE_SESSION_ID: context.sessionId, INIT_CWD: cwd ?? "/", PWD: cwd ?? "/" } : {}),
      TERM: "xterm-256color",
    },
  };
}

function createWikiRoot(cwd: string): void {
  const knowledgeRoot = path.join(cwd, ".fleet", "knowledge");
  fs.mkdirSync(path.join(knowledgeRoot, "wiki"), { recursive: true });
  fs.mkdirSync(path.join(knowledgeRoot, "raw"), { recursive: true });
  fs.mkdirSync(path.join(knowledgeRoot, "queue"), { recursive: true });
  fs.mkdirSync(path.join(knowledgeRoot, "archive"), { recursive: true });
  fs.mkdirSync(path.join(knowledgeRoot, "conflicts"), { recursive: true });
  fs.writeFileSync(path.join(knowledgeRoot, "wiki", "index.md"), "# Index\n");
  fs.writeFileSync(path.join(knowledgeRoot, "log.md"), "## Log\n");
}

function makeWikiEntryMd(id: string): string {
  return [
    "---",
    `id: "${id}"`,
    `title: "Entry ${id}"`,
    "tags: []",
    'created: "2026-01-01T00:00:00.000Z"',
    'updated: "2026-01-01T00:00:00.000Z"',
    "version: 1",
    "---",
    "Test content",
  ].join("\n");
}

function createDesktopFullscreenSseReader(reader: ReadableStreamDefaultReader<Uint8Array>): () => Promise<{ readonly fullscreen: boolean }> {
  const decoder = new TextDecoder();
  let buffered = "";
  return async () => {
    while (true) {
      const frames = buffered.split(/\r?\n\r?\n/u);
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const event = new RegExp(`event: ${DESKTOP_FULLSCREEN_EVENT}\\ndata: (\\{[^\\n]+\\})`).exec(frame);
        if (event?.[1]) return JSON.parse(event[1]) as { readonly fullscreen: boolean };
      }
      const result = await readSseChunk(reader);
      if (result.done) throw new Error("desktop_fullscreen_sse_closed");
      buffered += decoder.decode(result.value, { stream: true });
    }
  };
}

async function readSseChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("desktop_fullscreen_sse_timeout")), 1_000); }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function putWithHost(url: URL, origin: string, host: string, body: unknown): Promise<number> {
  return requestWithHost(url, origin, host, "PUT", body);
}

function requestWithHost(url: URL, origin: string, host: string, method: string, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers: { Host: host, Origin: origin, "Content-Type": "application/json" } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
