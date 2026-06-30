import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { initStore, resetStoreForTests } from "@dotobokuri/fleet-carriers";

import type { ConsoleLockPayload } from "../core/host/api-types.js";
import { createConsoleLock } from "../core/host/lock.js";
import { createConsoleObservabilityStore } from "../../fleet-plugins/terminal/server/agent-api/observability-store.js";
import { createConsoleServer, type ConsoleServer, type ConsoleServerDeps } from "../core/host/server.js";
import type { AgentCliDetector } from "../../fleet-plugins/terminal/server/agent-api/agent-cli-detect.js";
import { workspaceHash } from "../core/host/theater.js";
import { TheaterRegistry } from "../core/host/theaters.js";
import { WorkspaceRegistry } from "../core/host/codex/workspaces.js";
import type { TerminalLaunchSpec, TerminalPtyHandle } from "../../fleet-plugins/terminal/server/shared/terminal-types.js";
import { createPluginTerminalUpgradeHandler } from "../../fleet-plugins/terminal/server/shared/ws.js";

const fleetAdmiralMock = vi.hoisted(() => ({
  agentRuntimeQueue: [] as unknown[],
}));

vi.mock("@dotobokuri/fleet-admiral", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dotobokuri/fleet-admiral")>();
  return {
    ...actual,
    createFleetAgentRuntimeLifecycle: (deps: Parameters<typeof actual.createFleetAgentRuntimeLifecycle>[0]) =>
      fleetAdmiralMock.agentRuntimeQueue.shift() ?? actual.createFleetAgentRuntimeLifecycle(deps),
  };
});

interface ServerFixture {
  readonly dir: string;
  readonly carrierStoreDir: string;
  readonly lockFile: string;
  readonly server: ConsoleServer;
  readonly endpoint: string;
  readonly lock: ConsoleLockPayload;
}

interface FakeConsoleRuntime {
  readonly carrierRuntime: {
    readonly jobs: {
      readonly streaming: {
        register(callback: (event: unknown) => void): () => void;
      };
    };
  };
  readonly dedicatedMcpSession: {
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

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  fleetAdmiralMock.agentRuntimeQueue.length = 0;
  delete (globalThis as { __fleetTerminalLaunch?: unknown }).__fleetTerminalLaunch;
  delete (globalThis as { __fleetTerminalStartShell?: unknown }).__fleetTerminalStartShell;
  resetStoreForTests();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  restoreStaticIndex();
});

describe("console terminal observability", () => {
  it("resolves terminal launch cwd from the selected console-owned session", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-bind-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore();
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: dir, createdAt: 1_000 });

    expect(store.getLaunchCwd("session-a")).toBe(dir);
    expect(store.getLaunchCwd("missing-session")).toBeNull();

    store.registerTerminalRuntimeSession({ sessionId: "session-a", label: "Claude Code", mcpToolCount: 3 });

    expect(store.getLaunchCwd("session-a")).toBe(dir);
  });

  it("registers console-owned terminal runtime sessions without CLI ingest tokens and appends carrier events", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-direct-runtime-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore();
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: dir, createdAt: 1_000 });

    const session = store.registerTerminalRuntimeSession({ sessionId: "session-a", label: "Claude Code", mcpToolCount: 3 });
    store.appendTerminalRuntimeEvent("session-a", { type: "track:text", jobId: "job-a", text: "hello" }, 2_000);
    const workspaces = store.listWorkspaces();
    const jobs = store.listJobs("session-a");
    const serialized = JSON.stringify({ session, workspaces, jobs });

    expect(session).toMatchObject({ sessionId: "session-a", status: "registered", cliRunId: "session-a", tenantId: "session-a" });
    expect(workspaces[0]).toMatchObject({ tenantId: "session-a", tenantLabel: "Claude Code", terminalSessionId: "session-a" });
    expect(jobs[0]?.events[0]?.event).toMatchObject({ text: "hello" });
    expect(serialized).not.toContain(dir);
  });

  it("redacts system reminders from browser observer payloads for terminal runtime events", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-redact-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore();
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: dir, createdAt: 1_000 });
    store.registerTerminalRuntimeSession({ sessionId: "session-a", label: "Claude Code", mcpToolCount: 3 });

    store.appendTerminalRuntimeEvent("session-a", { type: "job:finalized", jobId: "job-runtime", status: "done", finishedAt: 2, summary: "done", systemReminder: "runtime-secret" }, 2_000);

    const serialized = JSON.stringify({
      runtimeJobs: store.listJobs("session-a"),
    });

    expect(serialized).not.toContain("systemReminder");
    expect(serialized).not.toContain("runtime-secret");
    expect(serialized).toContain("job-runtime");
  });

  it("numbers pending terminal sessions per Theater, isolating the #1 starting value", () => {
    const theaterA = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-seq-a-"));
    const theaterB = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-seq-b-"));
    tempDirs.push(theaterA, theaterB);
    const store = createConsoleObservabilityStore();

    const a1 = store.createPendingTerminalSession({ sessionId: "a1", cwd: theaterA, createdAt: 1 });
    const a2 = store.createPendingTerminalSession({ sessionId: "a2", cwd: theaterA, createdAt: 2 });
    const b1 = store.createPendingTerminalSession({ sessionId: "b1", cwd: theaterB, createdAt: 3 });

    expect(a1.sequence).toBe(1);
    expect(a2.sequence).toBe(2);
    expect(b1.sequence).toBe(1);
  });

  it("injects dormant durable operations without exposing server-only provider data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-dormant-store-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore();

    const session = store.injectDormantOperation({
      sessionId: "session-a",
      theaterId: workspaceHash(fs.realpathSync.native(dir)),
      cwd: dir,
      cwdLabel: path.basename(dir),
      sequence: 7,
      cliId: "claude",
      cliLabel: "Claude",
      createdAt: 1_000,
      providerSession: {
        provider: "claude",
        sessionId: "provider-session-secret",
        transcriptPath: "/secret/transcript.jsonl",
        source: "startup",
        capturedAt: "2026-06-16T00:00:00.000Z",
      },
    });
    const serialized = JSON.stringify({ session, sessions: store.listTerminalSessions() });

    expect(session).toMatchObject({
      sessionId: "session-a",
      status: "dormant",
      sequence: 7,
      resumeAvailable: true,
    });
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain("provider-session-secret");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("providerSession");
  });

  it("drops live workspace indexes when a terminal session transitions to dormant", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-dormant-index-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore();
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: dir, createdAt: 1_000 });
    store.registerTerminalRuntimeSession({ sessionId: "session-a", label: "Claude Code", mcpToolCount: 3 });

    const dormant = store.transitionTerminalSessionToDormant("session-a", {
      provider: "claude",
      sessionId: "provider-session-secret",
      capturedAt: "2026-06-16T00:00:00.000Z",
    });

    expect(dormant).toMatchObject({ status: "dormant", resumeAvailable: true });
    expect(store.listWorkspaces()).toEqual([]);
    expect(store.getWorkspace("session-a")).toBeNull();
  });

  it("renames pending terminal sessions in memory and emits a separate session update frame", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-rename-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore();
    const frames: unknown[] = [];
    store.subscribeAll((event) => frames.push(event));
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: dir, createdAt: 1_000 });

    const longLabel = `  ${"x".repeat(205)}  `;
    const renamed = store.renameTerminalSession("session-a", longLabel);
    store.notifySessionUpdated(renamed!);
    const reset = store.renameTerminalSession("session-a", "   ");

    expect(renamed?.label).toHaveLength(200);
    expect(reset?.label).toBeUndefined();
    expect(frames).toEqual([{ type: "session:updated", session: renamed }]);
    expect(JSON.stringify(renamed)).not.toContain(dir);
  });

  it("auto-names operations only on the first user prompt when the operator has not set a label", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-autoname-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore();
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: dir, createdAt: 1_000 });

    // 첫 자동 작명: label 없음 → auto 적용 + labelSource "auto" 기록(영속 투영에 반영).
    const first = store.autoNameTerminalSession("session-a", "Fix the login redirect bug");
    expect(first).toMatchObject({ changed: true, renamed: true });
    expect(first?.session.label).toBe("Fix the login redirect bug");
    expect(store.listDurableOperations()[0]).toMatchObject({ label: "Fix the login redirect bug", labelSource: "auto", autoNamePromptSeen: true });

    // 두 번째 UserPromptSubmit부터는 같은 라벨이든 다른 라벨이든 작전명을 바꾸지 않는다.
    expect(store.autoNameTerminalSession("session-a", "Fix the login redirect bug")).toMatchObject({ changed: false, renamed: false });
    expect(store.autoNameTerminalSession("session-a", "Add the search index")).toMatchObject({ changed: false, renamed: false });
    expect(store.listDurableOperations()[0]?.label).toBe("Fix the login redirect bug");

    // 사용자가 수동 rename → labelSource "user" 기록.
    store.renameTerminalSession("session-a", "Bridge Watch");
    expect(store.listDurableOperations()[0]).toMatchObject({ label: "Bridge Watch", labelSource: "user", autoNamePromptSeen: true });
    // 사용자 라벨은 자동 작명이 절대 덮지 않는다.
    expect(store.autoNameTerminalSession("session-a", "A brand new prompt topic")).toMatchObject({ changed: false, renamed: false });
    expect(store.listDurableOperations()[0]?.label).toBe("Bridge Watch");

    // 빈 rename은 label, labelSource, first-prompt marker를 함께 비워 다음 최초 프롬프트 자동 작명을 재활성화한다.
    store.renameTerminalSession("session-a", "   ");
    const cleared = store.listDurableOperations()[0];
    expect(cleared?.label).toBeUndefined();
    expect(cleared?.labelSource).toBeUndefined();
    expect(cleared?.autoNamePromptSeen).toBeUndefined();
    expect(store.autoNameTerminalSession("session-a", "Re-enabled auto label")?.session.label).toBe("Re-enabled auto label");
  });

  it("records a low-signal first user prompt so later prompts cannot auto-name the operation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-autoname-empty-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore();
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: dir, createdAt: 1_000 });

    expect(store.autoNameTerminalSession("session-a", null)).toMatchObject({ changed: true, renamed: false });
    expect(store.listDurableOperations()[0]).toMatchObject({ autoNamePromptSeen: true });
    expect(store.autoNameTerminalSession("session-a", "Add the search index")).toMatchObject({ changed: false, renamed: false });
    expect(store.listDurableOperations()[0]?.label).toBeUndefined();
  });

  it("protects legacy operator labels that predate labelSource from auto-naming", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-autoname-legacy-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore();
    // labelSource 없이 label만 있는 레거시 dormant Operation을 복원한다.
    store.injectDormantOperation({
      sessionId: "legacy",
      theaterId: workspaceHash(fs.realpathSync.native(dir)),
      cwd: dir,
      cwdLabel: path.basename(dir),
      sequence: 1,
      label: "Operator named",
      createdAt: 1,
    });
    // read-time 해석: label이 있고 labelSource가 없으면 user로 보수 해석 → 자동 작명 차단.
    expect(store.autoNameTerminalSession("legacy", "New auto topic")).toMatchObject({ changed: false, renamed: false });
    expect(store.listDurableOperations()[0]?.label).toBe("Operator named");
  });

  it("treats restored auto labels without a first-prompt marker as already auto-named", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-autoname-legacy-auto-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore();
    store.injectDormantOperation({
      sessionId: "legacy-auto",
      theaterId: workspaceHash(fs.realpathSync.native(dir)),
      cwd: dir,
      cwdLabel: path.basename(dir),
      sequence: 1,
      label: "Existing auto label",
      labelSource: "auto",
      autoNamePromptSeen: true,
      createdAt: 1,
    });

    expect(store.autoNameTerminalSession("legacy-auto", "New auto topic")).toMatchObject({ changed: false, renamed: false });
    expect(store.listDurableOperations()[0]).toMatchObject({ label: "Existing auto label", labelSource: "auto", autoNamePromptSeen: true });
  });

  it.skip("replays existing observer events over SSE resync", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-sse-"));
    tempDirs.push(dir);
    const runtime = createFakeConsoleRuntime([], []);
    const runtimeFixture = await startFixture({
      agentRuntime: runtime as never,
      terminalStartShell: () => createMockPty(),
    });
    const session = await createTerminalSession(runtimeFixture, { "Content-Type": "application/json" }, dir);
    runtime.emit({ type: "track:text", jobId: "job-a", originSessionId: session.sessionId, trackId: "t1", text: "hello" });

    const controller = new AbortController();
    const response = await fetch(`${runtimeFixture.endpoint}observer/events`, { signal: controller.signal });
    const chunk = new TextDecoder().decode((await response.body!.getReader().read()).value);
    controller.abort();

    expect(chunk).toContain("event: track:text");
    expect(chunk).toContain("\"id\":1");
  });

  it.skip("does not expose a live workspace when PTY spawn fails after runtime profile injection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-spawn-fail-"));
    tempDirs.push(dir);
    const runtime = createFakeConsoleRuntime([], []);
    const fixture = await startFixture({
      agentRuntime: runtime as never,
      terminalStartShell: () => {
        throw new Error("spawn failed");
      },
    });
    const headers = { "Content-Type": "application/json" };

    const grant = await issueTheaterFolderGrant(fixture, dir, headers);
    const failed = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId, cliId: "claude" }),
    });
    const failedBody = await failed.json();
    const observerTenants = await getJson<{ readonly tenants: readonly unknown[] }>(`${fixture.endpoint}observer/tenants`);
    const observerStatus = await getJson<{ readonly workspaces: number }>(`${fixture.endpoint}api/v1/status`);
    const terminalSessions = await getJson<{ readonly sessions: ReadonlyArray<{ readonly status: string }> }>(`${fixture.endpoint}terminal/sessions`);

    expect(failed.status).toBe(503);
    expect(failedBody).toEqual({ error: "terminal_unavailable" });
    expect(observerTenants.tenants).toEqual([]);
    expect(observerStatus.workspaces).toBe(0);
    expect(terminalSessions.sessions[0]?.status).toBe("error");
  });

});

describe("console static and terminal ticket boundary", () => {
  it("serves /console/ fallback from its own dist/client", async () => {
    const fixture = await startFixture();
    const indexPath = ensureStaticIndex();
    const response = await fetch(`${fixture.endpoint}console/operations`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("console-test-index");
    expect(indexPath.endsWith(path.join("dist", "client", "index.html"))).toBe(true);
  });

  it.skip("issues terminal tickets without browser tokens and selects session cwd internally", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-ticket-cwd-"));
    tempDirs.push(dir);
    const launches: string[] = [];
    const fixture = await startFixture({
      terminalLaunch: async (cwd) => {
        launches.push(cwd ?? "");
        return { bin: "mock", args: [], cwd: cwd ?? "/", env: { TERM: "xterm-256color" } };
      },
      terminalStartShell: () => createMockPty(),
    });
    const session = await createTerminalSession(fixture, { "Content-Type": "application/json" }, dir);
    launches.length = 0;

    const issued = await fetch(`${fixture.endpoint}terminal/ticket`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
    const payload = await issued.json() as { readonly ticket?: unknown; readonly ttlMs?: unknown; readonly cwd?: unknown };

    expect(issued.status).toBe(200);
    expect(typeof payload.ticket).toBe("string");
    expect(payload.ttlMs).toBe(10_000);
    expect(payload.cwd).toBeUndefined();
    expect(launches).toEqual([]);
  });

  it.skip("rejects terminal tickets for unknown session ids without falling back to process cwd", async () => {
    const fixture = await startFixture();

    const missingSession = await fetch(`${fixture.endpoint}terminal/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "missing-session" }),
    });
    const missingBody = await missingSession.json();
    const missingId = await fetch(`${fixture.endpoint}terminal/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const missingIdBody = await missingId.json();
    const shell = await fetch(`${fixture.endpoint}plugins/terminal/shell/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "shell" }),
    });
    const shellBody = await shell.json();

    expect(missingSession.status).toBe(404);
    expect(missingBody).toEqual({ error: "terminal_session_not_found" });
    expect(missingId.status).toBe(400);
    expect(missingIdBody).toEqual({ error: "terminal_session_not_found" });
    expect(shell.status).toBe(400);
    expect(shellBody).toEqual({ error: "operation_id_required" });
  });

  it("issues shell tickets for existing shell OperationNodes only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-theater-shell-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
      terminalStartShell: () => createMockPty(),
    });
    const theater = await createTheater(fixture, dir);
    const shellOperation = await createShellOperation(fixture, theater.id);
    const agentOperation = await createOperation(fixture, theater.id, { type: "agent", pluginId: "terminal" });

    const issued = await fetch(`${fixture.endpoint}plugins/terminal/shell/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: shellOperation.id, kind: "shell" }),
    });
    const issuedBody = await issued.json() as { readonly ticket?: unknown; readonly cwd?: unknown };

    const missing = await fetch(`${fixture.endpoint}plugins/terminal/shell/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "missing-shell", kind: "shell" }),
    });
    const missingBody = await missing.json();
    const wrongKind = await fetch(`${fixture.endpoint}plugins/terminal/shell/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: agentOperation.id, kind: "shell" }),
    });
    const wrongKindBody = await wrongKind.json();

    expect(issued.status).toBe(200);
    expect(typeof issuedBody.ticket).toBe("string");
    // shell ticket도 raw Theater 경로를 응답에 노출하지 않는다(cwd는 서버 측에서만 해석).
    expect(issuedBody.cwd).toBeUndefined();
    expect(missing.status).toBe(404);
    expect(missingBody).toEqual({ error: "operation_not_found" });
    expect(wrongKind.status).toBe(409);
    expect(wrongKindBody).toEqual({ error: "invalid_shell_operation" });
  });

  it("loads plugin routes without exposing host terminal runtime capabilities", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-launch-"));
    tempDirs.push(dir);
    const pluginPackage = createPluginPackageRoot({
      demoRoutes: [
        "export function register(ctx) {",
        "  ctx.registerRouter('start', async ({ req, res }) => {",
        "    if (req.method !== 'POST') { ctx.host.http.writeJson(res, 405, { error: 'Method not allowed' }); return true; }",
        "    ctx.host.http.writeJson(res, 200, { terminal: 'terminal' in ctx.host });",
        "    return true;",
        "  });",
        "}",
      ].join("\n"),
    });
    const fixture = await startFixture({ release: pluginPackage.release });
    const theater = await createTheater(fixture, dir);
    const operation = await createOperation(fixture, theater.id, { type: "demo", pluginId: "demo" });

    const response = await fetch(`${fixture.endpoint}plugins/demo/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: operation.id }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ terminal: false });
  });

  it("serves plugin runtime manifest and shims through core routes", async () => {
    const fixture = await startFixture();

    const manifest = await fetch(`${fixture.endpoint}plugin-runtime/manifest`);
    const shim = await fetch(`${fixture.endpoint}plugin-runtime/shim/sdk-plugin-browser.mjs`);
    const missing = await fetch(`${fixture.endpoint}plugin-runtime/shim/missing.mjs`);
    const manifestBody = await manifest.json() as { readonly plugins?: readonly Record<string, unknown>[] };
    const serializedManifest = JSON.stringify(manifestBody);
    const shimSource = await shim.text();

    expect(manifest.status).toBe(200);
    expect(Array.isArray(manifestBody.plugins)).toBe(true);
    for (const plugin of manifestBody.plugins ?? []) {
      expect(Object.keys(plugin).sort()).toEqual(expect.arrayContaining(["apiVersion", "clientUrl", "id"]));
      expect(plugin.clientUrl).toMatch(/^\/plugin-runtime\/client\/[^/]+\.mjs$/u);
    }
    expect(serializedManifest).not.toContain("root");
    expect(serializedManifest).not.toContain("clientEntry");
    expect(serializedManifest).not.toContain("routesEntry");
    expect(serializedManifest).not.toContain("sensitiveFields");
    expect(shim.status).toBe(200);
    expect(shim.headers.get("content-type")).toContain("text/javascript");
    expect(shimSource).toContain("globalThis.__fleetConsoleRuntime__?.[\"@fleet-console/sdk/plugin/browser\"]");
    expect(missing.status).toBe(404);
  });

  it("awaits async plugin cleanup callbacks before server stop settles", async () => {
    const cleanupGate = createDeferred<void>();
    const cleanup = vi.fn(() => cleanupGate.promise);
    const globals = globalThis as { __fleetConsolePluginCleanup?: () => Promise<void> };
    globals.__fleetConsolePluginCleanup = cleanup;
    const pluginPackage = createPluginPackageRoot({
      demoRoutes: [
        "export function register(ctx) {",
        "  ctx.host.lifecycle.registerCleanup(() => globalThis.__fleetConsolePluginCleanup());",
        "}",
      ].join("\n"),
    });
    const fixture = await startFixture({ release: pluginPackage.release });
    let stopped = false;

    const stopping = fixture.server.stop().then(() => {
      stopped = true;
    });
    try {
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
      expect(stopped).toBe(false);
      cleanupGate.resolve();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      cleanupGate.resolve();
      delete globals.__fleetConsolePluginCleanup;
    }
  });

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

  it.skip("keeps one shared runtime active across two terminal sessions and releases only the closed session token", async () => {
    const fakeToken = "mcp-success-flow-secret";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-shared-runtime-"));
    tempDirs.push(dir);
    const issuedLabels: string[] = [];
    const releasedLabels: string[] = [];
    const runtime = createFakeConsoleRuntime(issuedLabels, releasedLabels);
    const fixture = await startFixture({
      agentRuntime: runtime as never,
      terminalStartShell: () => createFakePty(),
    });
    const headers = { "Content-Type": "application/json" };

    const first = await createTerminalSession(fixture, headers, dir);
    runtime.emit({ type: "track:text", jobId: "job-a", originSessionId: first.sessionId, trackId: "t1", text: "a", mcpToken: fakeToken });
    const second = await createTerminalSession(fixture, headers, dir);
    runtime.emit({ type: "track:text", jobId: "job-a2", originSessionId: first.sessionId, trackId: "t1", text: "a2" });
    const stopSecond = await fetch(`${fixture.endpoint}terminal/sessions/${encodeURIComponent(second.sessionId)}`, { method: "DELETE" });
    runtime.emit({ type: "track:text", jobId: "job-a3", originSessionId: first.sessionId, trackId: "t1", text: "a3" });
    const jobsBeforeStop = await getJson<{ tenants: Array<{ readonly tenantId: string; readonly jobs: Array<{ readonly jobId: string }> }> }>(`${fixture.endpoint}observer/jobs`);
    const sse = await readObserverChunk(fixture);
    const serialized = JSON.stringify({ jobsBeforeStop, sse });
    const firstTenant = jobsBeforeStop.tenants.find((tenant) => tenant.tenantId === first.sessionId);

    expect(stopSecond.status).toBe(200);
    expect(issuedLabels).toEqual([first.sessionId, second.sessionId]);
    expect(releasedLabels).toEqual([second.sessionId]);
    expect(runtime.cleanup).not.toHaveBeenCalled();
    expect(firstTenant?.jobs.map((job) => job.jobId).sort()).toEqual(["job-a", "job-a2", "job-a3"]);
    expect(serialized).not.toContain(fakeToken);
    expect(serialized).not.toContain("originSessionId");

    await fixture.server.stop();
    expect(runtime.cleanup).not.toHaveBeenCalled();
  });

  it.skip("injects finalized carrier reminders only into the originating live terminal session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-reminder-"));
    tempDirs.push(dir);
    const runtime = createFakeConsoleRuntime([], []);
    const ptys = new Map<string, TerminalPtyHandle & { readonly writes: string[] }>();
    const fixture = await startFixture({
      agentRuntime: runtime as never,
      terminalLaunch: async (cwd, context) => ({
        bin: "mock",
        args: [],
        cwd: cwd ?? "/",
        env: {
          ...(context?.sessionId ? { FLEET_CONSOLE_SESSION_ID: context.sessionId, INIT_CWD: cwd ?? "/", PWD: cwd ?? "/" } : {}),
          TERM: "xterm-256color",
        },
        messagePolicy: { bracketedPaste: true, multilineStrategy: "paste-mode" },
      }),
      terminalStartShell: (launch) => {
        const pty = createRecordingPty();
        ptys.set(String(launch.env.FLEET_CONSOLE_SESSION_ID), pty);
        return pty;
      },
    });
    const headers = { "Content-Type": "application/json" };
    const first = await createTerminalSession(fixture, headers, dir);
    const second = await createTerminalSession(fixture, headers, dir);

    runtime.emit({ type: "track:text", jobId: "job-a", originSessionId: first.sessionId, trackId: "t1", text: "progress" });
    runtime.emit({ type: "track:text", jobId: "job-a", originSessionId: first.sessionId, trackId: "t1", text: "ignored", systemReminder: "not-final" });
    runtime.emit({ type: "job:finalized", jobId: "missing-origin", status: "done", finishedAt: 1, summary: "missing", systemReminder: "drop me" });
    runtime.emit({ type: "job:finalized", jobId: "job-a", status: "done", finishedAt: 2, summary: "done", systemReminder: "line 1\nline 2\x1b[201~\x07" });

    expect(ptys.get(first.sessionId)?.writes).toEqual(["\x1b[200~line 1\nline 2\x1b[201~", "\r"]);
    expect(ptys.get(second.sessionId)?.writes).toEqual([]);

    runtime.emit({ type: "track:text", jobId: "job-b", originSessionId: second.sessionId, trackId: "t1", text: "progress" });
    const deleted = await fetch(`${fixture.endpoint}terminal/sessions/${encodeURIComponent(second.sessionId)}`, { method: "DELETE" });
    runtime.emit({ type: "job:finalized", jobId: "job-b", status: "done", finishedAt: 3, summary: "done", systemReminder: "after delete" });
    runtime.emit({ type: "job:finalized", jobId: "job-c", originSessionId: "unknown", status: "done", finishedAt: 4, summary: "done", systemReminder: "unknown" });

    expect(deleted.status).toBe(200);
    expect(ptys.get(second.sessionId)?.writes).toEqual([]);
    expect(ptys.get(first.sessionId)?.writes).toEqual(["\x1b[200~line 1\nline 2\x1b[201~", "\r"]);
  });

  it.skip("keeps carrier reminder payloads out of browser snapshots and SSE frames", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-reminder-browser-"));
    tempDirs.push(dir);
    const runtime = createFakeConsoleRuntime([], []);
    const secret = "server-only-system-reminder-secret";
    const fixture = await startFixture({
      agentRuntime: runtime as never,
      terminalLaunch: async (cwd, context) => ({
        bin: "mock",
        args: [],
        cwd: cwd ?? "/",
        env: {
          ...(context?.sessionId ? { FLEET_CONSOLE_SESSION_ID: context.sessionId, INIT_CWD: cwd ?? "/", PWD: cwd ?? "/" } : {}),
          TERM: "xterm-256color",
        },
        messagePolicy: { bracketedPaste: true, multilineStrategy: "paste-mode" },
      }),
      terminalStartShell: () => createRecordingPty(),
    });
    const session = await createTerminalSession(fixture, { "Content-Type": "application/json" }, dir);

    runtime.emit({ type: "track:text", jobId: "job-secret", originSessionId: session.sessionId, trackId: "t1", text: "visible" });
    runtime.emit({ type: "job:finalized", jobId: "job-secret", status: "done", finishedAt: 1, summary: "done", systemReminder: secret });

    const terminalSessions = await getJson<unknown>(`${fixture.endpoint}terminal/sessions`);
    const observerTenants = await getJson<unknown>(`${fixture.endpoint}observer/tenants`);
    const observerJobs = await getJson<unknown>(`${fixture.endpoint}observer/jobs`);
    const sse = await readObserverChunk(fixture);
    const serialized = JSON.stringify({ terminalSessions, observerTenants, observerJobs, sse });

    expect(serialized).not.toContain("systemReminder");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(fixture.lock.token);
    expect(serialized).not.toContain("terminalTicket");
    expect(serialized).not.toContain("sessionToken");
  });

  it("leaves injected agent runtime cleanup to the caller when the server stops", async () => {
    const runtime = createFakeConsoleRuntime([], []);
    const fixture = await startFixture({
      agentRuntime: runtime as never,
    });

    await expect(fixture.server.stop()).resolves.toBeUndefined();
    expect(createConsoleLock().readLock(fixture.lockFile)).toBeNull();
    expect(runtime.cleanup).not.toHaveBeenCalled();
  });

  it.skip("cleans up internally created agent runtime when console startup fails before lock commit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-start-fail-"));
    const carrierStoreDir = path.join(dir, "fleet-home");
    const lockDirFile = path.join(dir, "not-a-dir");
    const runtime = createFakeConsoleRuntime([], []);
    tempDirs.push(dir);
    initStore(carrierStoreDir);
    fs.writeFileSync(lockDirFile, "block lock dir");
    fleetAdmiralMock.agentRuntimeQueue.push(runtime);
    const server = createConsoleServer({
      port: 0,
      version: "test",
      dataDir: carrierStoreDir,
    });

    await expect(server.start({ dir: lockDirFile, lockFile: path.join(lockDirFile, "console.lock") })).rejects.toThrow();
    expect(runtime.cleanup).toHaveBeenCalledTimes(1);
    await expect(server.stop()).resolves.toBeUndefined();
    expect(runtime.cleanup).toHaveBeenCalledTimes(1);
  });

  it("lists Theater folders through the browser API without native cancellation", async () => {
    const response = await fetchWithBlockedPortRetry((fixture) =>
      fetch(`${fixture.endpoint}api/v1/theaters/folder-listings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: null }),
      }));
    const body = await response.json() as { readonly path?: unknown; readonly entries?: unknown };

    expect(response.status).toBe(200);
    expect(typeof body.path).toBe("string");
    expect(Array.isArray(body.entries)).toBe(true);
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

  it("rejects update apply when the browser provides package or version targets", async () => {
    const fixture = await startFixture({
      release: { channel: "stable", version: "1.0.0", packageRoot: "/pkg" },
    });

    const response = await fetch(`${fixture.endpoint}api/v1/updates/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: new URL(fixture.endpoint).origin },
      body: JSON.stringify({ packageName: "@dotobokuri/fleet-console", version: "9.9.9" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_update_apply_body" });
  });

  it("rejects update apply for local release channels", async () => {
    const fixture = await startFixture({
      release: { channel: "local", version: "1.0.0", packageRoot: "/pkg" },
    });

    const response = await fetch(`${fixture.endpoint}api/v1/updates/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: new URL(fixture.endpoint).origin },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "local_channel" });
  });

  it.skip("rejects update apply while a live terminal session exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-update-live-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
      release: { channel: "stable", version: "1.0.0", packageRoot: process.cwd() },
      terminalLaunch: createMockLaunch,
      terminalStartShell: () => createMockPty(),
    });
    await createTerminalSession(fixture, { "Content-Type": "application/json" }, dir);

    const response = await fetch(`${fixture.endpoint}api/v1/updates/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: new URL(fixture.endpoint).origin },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "active_terminal_sessions" });
  });

  it("accepts update apply after fresh recheck and starts shutdown after the 202 response", async () => {
    const updateApplyStart = vi.fn().mockResolvedValue({ accepted: true });
    const refresh = vi.fn().mockResolvedValue({ updateAvailable: true, latestVersion: "1.2.3" });
    const fixture = await startFixture({
      release: { channel: "stable", version: "1.0.0", packageRoot: "/pkg" },
      updateApply: { start: updateApplyStart },
      updateCheck: {
        getStatus: () => ({ updateAvailable: true, latestVersion: "1.2.3" }),
        refresh,
      },
    });

    const response = await fetch(`${fixture.endpoint}api/v1/updates/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: new URL(fixture.endpoint).origin },
      body: JSON.stringify({}),
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toEqual({ status: "accepted" });
    expect(refresh).toHaveBeenCalledWith({ force: true });
    expect(updateApplyStart).toHaveBeenCalledWith({
      currentEndpoint: fixture.endpoint,
      currentPackageRoot: "/pkg",
      currentPid: process.pid,
      dataDir: path.join(fixture.carrierStoreDir, "console"),
      lockFile: fixture.lockFile,
      targetVersion: "1.2.3",
    });
  });

  it("rejects concurrent update apply while the worker spawn is in flight", async () => {
    let releaseWorker!: () => void;
    let markWorkerStarted!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    const pendingWorker = new Promise<{ readonly accepted: true }>((resolve) => {
      releaseWorker = () => resolve({ accepted: true });
    });
    const fixture = await startFixture({
      release: { channel: "stable", version: "1.0.0", packageRoot: "/pkg" },
      updateApply: {
        start: vi.fn().mockImplementation(() => {
          markWorkerStarted();
          return pendingWorker;
        }),
      },
      updateCheck: {
        getStatus: () => ({ updateAvailable: true, latestVersion: "1.2.3" }),
        refresh: vi.fn().mockResolvedValue({ updateAvailable: true, latestVersion: "1.2.3" }),
      },
    });
    const request = () => fetch(`${fixture.endpoint}api/v1/updates/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: new URL(fixture.endpoint).origin },
      body: JSON.stringify({}),
    });

    const first = request();
    await workerStarted;
    const second = await request();
    releaseWorker();
    const firstResponse = await first;

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({ error: "update_already_in_progress" });
    expect(firstResponse.status).toBe(202);
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
    const stateFile = path.join(fixture.carrierStoreDir, "console", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { version: number; operations: Array<{ id?: string; pluginId?: string; type?: string; payload?: { providerSession?: unknown } }> };
    expect(state.version).toBe(3);
    expect(state.operations).toHaveLength(1);
    expect(state.operations[0]).toMatchObject({ id: session.sessionId, pluginId: "terminal", type: "agent" });
    expect(state.operations[0]?.payload?.providerSession).toBeUndefined();
    if (process.platform !== "win32") expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    await expect(list.json()).resolves.toMatchObject({ sessions: [{ sessionId: session.sessionId, status: "terminal-only" }] });
  });

  it("keeps a wiki Theater's hasWiki true after a console restart by re-registering its Codex workspace", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-haswiki-"));
    tempDirs.push(dir);
    // Theater 디렉터리에 Fleet Wiki 지식 루트를 만들어 hasWiki=true 조건을 충족시킨다.
    fs.mkdirSync(path.join(dir, ".fleet", "knowledge"), { recursive: true });
    const fixture = await startFixture();
    const theater = await createTheater(fixture, dir);

    const beforeRestart = await getJson<{ readonly theaters: ReadonlyArray<{ readonly id: string; readonly hasWiki: boolean }> }>(`${fixture.endpoint}api/v1/theaters`);
    await fixture.server.stop();

    const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-haswiki-lock-"));
    tempDirs.push(restartDir);
    const restartedServer = createConsoleServer({ port: 0, version: "test", dataDir: fixture.carrierStoreDir });
    servers.push(restartedServer);
    const restartedEndpoint = await restartedServer.start({ dir: restartDir, lockFile: path.join(restartDir, "console.lock") });

    const afterRestart = await getJson<{ readonly theaters: ReadonlyArray<{ readonly id: string; readonly hasWiki: boolean }> }>(`${restartedEndpoint}api/v1/theaters`);

    // 추가 직후에는 POST 경로가 워크스페이스를 등록하므로 hasWiki=true이고,
    // 재시작 후에도 복원된 Theater의 워크스페이스를 재등록해 hasWiki가 유지되어야 한다.
    expect(beforeRestart.theaters.find((entry) => entry.id === theater.id)?.hasWiki).toBe(true);
    expect(afterRestart.theaters.find((entry) => entry.id === theater.id)?.hasWiki).toBe(true);
  });

  it("unregisters a Theater's Codex workspace when the Theater is forgotten", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-forget-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".fleet", "knowledge"), { recursive: true });
    const fixture = await startFixture();
    const theater = await createTheater(fixture, dir);

    // 등록 직후에는 codex 워크스페이스 라우트가 conflicts API를 200으로 서빙한다.
    const beforeForget = await fetch(`${fixture.endpoint}console/codex/w/${encodeURIComponent(theater.id)}/api/conflicts`, { redirect: "manual" });
    const deleted = await fetch(`${fixture.endpoint}api/v1/theaters/${encodeURIComponent(theater.id)}`, { method: "DELETE" });
    // forget 후에는 워크스페이스가 해제되어 같은 라우트가 codex 홈으로 302 리다이렉트된다.
    const afterForget = await fetch(`${fixture.endpoint}console/codex/w/${encodeURIComponent(theater.id)}/api/conflicts`, { redirect: "manual" });
    const remaining = await getJson<{ readonly theaters: ReadonlyArray<{ readonly id: string }> }>(`${fixture.endpoint}api/v1/theaters`);

    expect(beforeForget.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(afterForget.status).toBe(302);
    expect(remaining.theaters.find((entry) => entry.id === theater.id)).toBeUndefined();
  });

  it("promotes the next most-recent Codex workspace as MRU when the active Theater is forgotten", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-mru-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-mru-b-"));
    tempDirs.push(dirA, dirB);
    createWikiRoot(dirA);
    createWikiRoot(dirB);
    // 각 워크스페이스에 고유 항목을 추가해 MRU를 search 결과로 식별한다.
    fs.writeFileSync(path.join(dirA, ".fleet", "knowledge", "wiki", "entry-mru-a.md"), makeWikiEntryMd("entry-mru-a"));
    fs.writeFileSync(path.join(dirB, ".fleet", "knowledge", "wiki", "entry-mru-b.md"), makeWikiEntryMd("entry-mru-b"));
    const fixture = await startFixture();
    await createTheater(fixture, dirA);
    const theaterB = await createTheater(fixture, dirB); // 마지막 등록 = MRU

    // MRU(B)를 forget하면 남은 A가 MRU로 승격되어, getMru() 기반 비프리픽스 라우트가
    // deps.cwd 폴백이 아니라 A의 위키를 서빙해야 한다.
    const deleted = await fetch(`${fixture.endpoint}api/v1/theaters/${encodeURIComponent(theaterB.id)}`, { method: "DELETE" });
    const search = await fetch(`${fixture.endpoint}console/codex/api/search`);
    const body = await search.json() as { readonly entries: ReadonlyArray<{ readonly id: string }> };

    expect(deleted.status).toBe(200);
    expect(search.status).toBe(200);
    expect(body.entries.some((e) => e.id === "entry-mru-a")).toBe(true);
    expect(body.entries.some((e) => e.id === "entry-mru-b")).toBe(false);
  });

  it("restores the most-recently-opened Codex workspace as MRU after a restart", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-restart-mru-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-restart-mru-b-"));
    tempDirs.push(dirA, dirB);
    createWikiRoot(dirA);
    createWikiRoot(dirB);
    // 각 워크스페이스에 고유 항목을 추가해 MRU를 search 결과로 식별한다.
    fs.writeFileSync(path.join(dirA, ".fleet", "knowledge", "wiki", "entry-restart-a.md"), makeWikiEntryMd("entry-restart-a"));
    fs.writeFileSync(path.join(dirB, ".fleet", "knowledge", "wiki", "entry-restart-b.md"), makeWikiEntryMd("entry-restart-b"));
    const fixture = await startFixture();
    await createTheater(fixture, dirA);
    const theaterB = await createTheater(fixture, dirB);

    // durable lastOpenedAt을 명시적으로 구분해 B를 가장 최근으로 만든다(생성 타이밍 의존 제거).
    const statePath = path.join(fixture.carrierStoreDir, "console", "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as { readonly theaters: { id: string; lastOpenedAt: string }[] };
    for (const theater of state.theaters) {
      theater.lastOpenedAt = theater.id === theaterB.id ? "2026-06-01T00:00:00.000Z" : "2026-01-01T00:00:00.000Z";
    }
    fs.writeFileSync(statePath, JSON.stringify(state));
    await fixture.server.stop();

    const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-restart-mru-lock-"));
    tempDirs.push(restartDir);
    const restartedServer = createConsoleServer({ port: 0, version: "test", dataDir: fixture.carrierStoreDir });
    servers.push(restartedServer);
    const restartedEndpoint = await restartedServer.start({ dir: restartDir, lockFile: path.join(restartDir, "console.lock") });

    // 재시작 후 codex MRU는 가장 최근에 열린 B여야 하므로 비프리픽스 search가 B의 항목을 서빙한다.
    const search = await fetch(`${restartedEndpoint}console/codex/api/search`);
    const body = await search.json() as { readonly entries: ReadonlyArray<{ readonly id: string }> };

    expect(search.status).toBe(200);
    expect(body.entries.some((e) => e.id === "entry-restart-b")).toBe(true);
    expect(body.entries.some((e) => e.id === "entry-restart-a")).toBe(false);
  });

  it("restores a symlinked Theater's Codex workspace from the durable realpath", async () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-symlink-real-"));
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-symlink-other-"));
    const linkDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-symlink-link-")), "theater");
    tempDirs.push(realDir, otherDir, path.dirname(linkDir));
    fs.mkdirSync(path.join(realDir, ".fleet", "knowledge"), { recursive: true });
    fs.mkdirSync(path.join(otherDir, ".fleet", "knowledge"), { recursive: true });
    fs.symlinkSync(realDir, linkDir);

    const fixture = await startFixture();
    const theater = await createTheater(fixture, linkDir); // 심볼릭 경로로 등록 → id는 realDir 기준
    await fixture.server.stop();

    // 정지 중 심볼릭 타깃을 다른 디렉터리로 바꾼다. theater.path를 다시 정규화하면 id가 달라지지만,
    // durable realpath로 복원하면 원래 id를 그대로 유지해 hasWiki 판정이 깨지지 않아야 한다.
    fs.unlinkSync(linkDir);
    fs.symlinkSync(otherDir, linkDir);

    const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-symlink-lock-"));
    tempDirs.push(restartDir);
    const restartedServer = createConsoleServer({ port: 0, version: "test", dataDir: fixture.carrierStoreDir });
    servers.push(restartedServer);
    const restartedEndpoint = await restartedServer.start({ dir: restartDir, lockFile: path.join(restartDir, "console.lock") });

    const bootstrap = await getJson<{ readonly theaters: ReadonlyArray<{ readonly id: string; readonly hasWiki: boolean }> }>(`${restartedEndpoint}api/v1/theaters`);

    expect(bootstrap.theaters.find((entry) => entry.id === theater.id)?.hasWiki).toBe(true);
  });

  it.skip("rehydrates durable state as dormant without starting PTYs and merges capture files server-side", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-rehydrate-"));
    tempDirs.push(dir);
    const realpath = fs.realpathSync.native(dir);
    const theaterId = workspaceHash(realpath);
    const startedShells: string[] = [];
    const fixture = await startFixture({
      beforeCreateServer: ({ carrierStoreDir }) => {
        const consoleDir = path.join(carrierStoreDir, "console");
        const capturesDir = path.join(consoleDir, "captures");
        fs.mkdirSync(capturesDir, { recursive: true });
        fs.writeFileSync(path.join(consoleDir, "state.json"), JSON.stringify({
          version: 1,
          theaters: [{
            id: theaterId,
            path: dir,
            realpath,
            label: path.basename(dir),
            registeredAt: "2026-06-16T00:00:00.000Z",
            lastOpenedAt: "2026-06-16T00:00:01.000Z",
          }],
          operations: [{
            sessionId: "session-a",
            theaterId,
            cwd: dir,
            cwdLabel: path.basename(dir),
            sequence: 1,
            cliId: "claude",
            cliLabel: "Claude",
            createdAt: 1_000,
          }],
        }));
        fs.writeFileSync(path.join(capturesDir, "session-a.json"), JSON.stringify({
          provider: "claude",
          sessionId: "provider-session-secret",
          transcriptPath: "/secret/transcript.jsonl",
          source: "startup",
          capturedAt: "2026-06-16T00:00:02.000Z",
        }));
      },
      terminalStartShell: (launch) => {
        startedShells.push(launch.cwd);
        return createMockPty();
      },
    });

    const theaters = await getJson<{ readonly theaters: readonly Record<string, unknown>[] }>(`${fixture.endpoint}api/v1/theaters`);
    const sessions = await getJson<{ readonly sessions: readonly Record<string, unknown>[] }>(`${fixture.endpoint}terminal/sessions`);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "console", "state.json"), "utf8")) as { readonly operations: ReadonlyArray<{ readonly providerSession?: unknown }> };
    const serialized = JSON.stringify({ theaters, sessions });

    expect(startedShells).toEqual([]);
    expect(theaters.theaters[0]).toMatchObject({ id: theaterId, label: path.basename(dir) });
    expect(sessions.sessions[0]).toMatchObject({ sessionId: "session-a", status: "dormant", resumeAvailable: true });
    expect(state.operations[0]?.providerSession).toMatchObject({ provider: "claude", sessionId: "provider-session-secret" });
    expect(fs.existsSync(path.join(fixture.carrierStoreDir, "console", "captures", "session-a.json"))).toBe(false);
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain("provider-session-secret");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("providerSession");
  });

  it("captures provider sessions through the session-scoped hook endpoint before exit persistence", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-capture-route-"));
    tempDirs.push(dir);
    const ptys: ExitablePty[] = [];
    const fixture = await startFixture({
      terminalStartShell: () => {
        const pty = createExitablePty();
        ptys.push(pty);
        return pty;
      },
    });
    const theater = await createTheater(fixture, dir);
    const created = await fetch(`${fixture.endpoint}plugins/terminal/agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: theater.id, cliId: "claude" }),
    });
    const session = await created.json() as { readonly sessionId: string };
    const capturePath = path.join(fixture.carrierStoreDir, "console", "captures", `${session.sessionId}.json`);

    const capture = await fetch(`${fixture.endpoint}plugins/terminal/agent/sessions/${encodeURIComponent(session.sessionId)}/capture`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.lock.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "claude",
        input: JSON.stringify({
          session_id: "provider-session-secret",
          transcript_path: "/secret/transcript.jsonl",
          source: "startup",
        }),
      }),
    });
    const captureBody = await capture.json();

    expect(created.status).toBe(200);
    expect(capture.status).toBe(200);
    expect(captureBody).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(capturePath, "utf8"))).toMatchObject({ provider: "claude", sessionId: "provider-session-secret" });
    const capturedState = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "console", "state.json"), "utf8")) as { readonly operations: ReadonlyArray<{ readonly payload?: { readonly providerSession?: unknown; readonly status?: unknown } }> };
    const operationsResponse = await getJson<{ readonly operations: ReadonlyArray<{ readonly payload?: Record<string, unknown> }> }>(`${fixture.endpoint}api/v1/operations`);
    const serializedOperations = JSON.stringify(operationsResponse);

    expect(capturedState.operations[0]?.payload?.providerSession).toMatchObject({ provider: "claude", sessionId: "provider-session-secret" });
    expect(capturedState.operations[0]?.payload?.status).not.toBe("dormant");
    expect(serializedOperations).not.toContain("providerSession");
    expect(serializedOperations).not.toContain("provider-session-secret");
    expect(operationsResponse.operations[0]?.payload).not.toHaveProperty("providerSession");
    expect(ptys).toHaveLength(1);

    ptys[0]!.emitExit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "console", "state.json"), "utf8")) as { readonly operations: ReadonlyArray<{ readonly payload?: { readonly providerSession?: unknown } }> };

    expect(state.operations[0]?.payload?.providerSession).toMatchObject({ provider: "claude", sessionId: "provider-session-secret" });
  });

  it("persists captured provider sessions as dormant operation payloads on server stop", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-capture-stop-"));
    tempDirs.push(dir);
    const ptys: ExitablePty[] = [];
    const fixture = await startFixture({
      terminalStartShell: () => {
        const pty = createExitablePty();
        ptys.push(pty);
        return pty;
      },
    });
    const theater = await createTheater(fixture, dir);
    const created = await fetch(`${fixture.endpoint}plugins/terminal/agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: theater.id, cliId: "claude" }),
    });
    const session = await created.json() as { readonly sessionId: string };
    const capture = await fetch(`${fixture.endpoint}plugins/terminal/agent/sessions/${encodeURIComponent(session.sessionId)}/capture`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.lock.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "claude",
        input: JSON.stringify({
          session_id: "provider-session-secret",
          transcript_path: "/secret/transcript.jsonl",
          source: "startup",
        }),
      }),
    });

    expect(created.status).toBe(200);
    expect(capture.status).toBe(200);
    expect(ptys).toHaveLength(1);

    await fixture.server.stop();
    const state = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "console", "state.json"), "utf8")) as { readonly operations: ReadonlyArray<{ readonly payload?: { readonly providerSession?: unknown; readonly status?: unknown } }> };

    expect(state.operations[0]?.payload?.providerSession).toMatchObject({ provider: "claude", sessionId: "provider-session-secret" });
    expect(state.operations[0]?.payload?.status).toBe("dormant");
  });

  it.skip("does not restore durable operations without provider sessions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-rehydrate-empty-"));
    tempDirs.push(dir);
    const realpath = fs.realpathSync.native(dir);
    const theaterId = workspaceHash(realpath);
    const fixture = await startFixture({
      beforeCreateServer: ({ carrierStoreDir }) => {
        const consoleDir = path.join(carrierStoreDir, "console");
        fs.mkdirSync(consoleDir, { recursive: true });
        fs.writeFileSync(path.join(consoleDir, "state.json"), JSON.stringify({
          version: 1,
          theaters: [{
            id: theaterId,
            path: dir,
            realpath,
            label: path.basename(dir),
            registeredAt: "2026-06-16T00:00:00.000Z",
            lastOpenedAt: "2026-06-16T00:00:01.000Z",
          }],
          operations: [{
            sessionId: "empty-session",
            theaterId,
            cwd: dir,
            cwdLabel: path.basename(dir),
            sequence: 1,
            cliId: "claude",
            createdAt: 1_000,
          }],
        }));
      },
    });

    const sessions = await getJson<{ readonly sessions: readonly unknown[] }>(`${fixture.endpoint}terminal/sessions`);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "console", "state.json"), "utf8")) as { readonly operations: readonly unknown[] };

    expect(sessions.sessions).toEqual([]);
    expect(state.operations).toEqual([]);
  });

  it.skip("returns 404 or 409 for unavailable dormant resume requests", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-resume-unavailable-"));
    tempDirs.push(dir);
    const realpath = fs.realpathSync.native(dir);
    const theaterId = workspaceHash(realpath);
    const fixture = await startFixture({
      beforeCreateServer: ({ carrierStoreDir }) => {
        const consoleDir = path.join(carrierStoreDir, "console");
        fs.mkdirSync(consoleDir, { recursive: true });
        fs.writeFileSync(path.join(consoleDir, "state.json"), JSON.stringify({
          version: 1,
          theaters: [{
            id: theaterId,
            path: dir,
            realpath,
            label: path.basename(dir),
            registeredAt: "2026-06-16T00:00:00.000Z",
            lastOpenedAt: "2026-06-16T00:00:01.000Z",
          }],
          operations: [
            {
              sessionId: "missing-provider",
              theaterId,
              cwd: dir,
              cwdLabel: path.basename(dir),
              sequence: 1,
              cliId: "claude",
              createdAt: 1_000,
            },
            {
              sessionId: "missing-cli",
              theaterId,
              cwd: dir,
              cwdLabel: path.basename(dir),
              sequence: 2,
              createdAt: 2_000,
              providerSession: {
                provider: "claude",
                sessionId: "provider-session-secret",
                capturedAt: "2026-06-16T00:00:00.000Z",
              },
            },
          ],
        }));
      },
    });

    const missing = await fetch(`${fixture.endpoint}terminal/sessions/nope/resume`, { method: "POST" });
    const noProvider = await fetch(`${fixture.endpoint}terminal/sessions/missing-provider/resume`, { method: "POST" });
    const noCli = await fetch(`${fixture.endpoint}terminal/sessions/missing-cli/resume`, { method: "POST" });

    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "session_not_found" });
    expect(noProvider.status).toBe(404);
    await expect(noProvider.json()).resolves.toEqual({ error: "session_not_found" });
    expect(noCli.status).toBe(409);
    await expect(noCli.json()).resolves.toEqual({ error: "resume_unavailable" });
  });

  it.skip("resumes a dormant operation lazily with provider session id kept server-side", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-resume-success-"));
    tempDirs.push(dir);
    const realpath = fs.realpathSync.native(dir);
    const theaterId = workspaceHash(realpath);
    const injectedResumeIds: Array<string | undefined> = [];
    const launchedArgs: Array<readonly string[]> = [];
    const runtime = createFakeConsoleRuntime([], []);
    const fixture = await startFixture({
      agentRuntime: runtime as never,
      beforeCreateServer: ({ carrierStoreDir }) => {
        const consoleDir = path.join(carrierStoreDir, "console");
        const capturesDir = path.join(consoleDir, "captures");
        fs.mkdirSync(capturesDir, { recursive: true });
        fs.writeFileSync(path.join(consoleDir, "state.json"), JSON.stringify({
          version: 1,
          theaters: [{
            id: theaterId,
            path: dir,
            realpath,
            label: path.basename(dir),
            registeredAt: "2026-06-16T00:00:00.000Z",
            lastOpenedAt: "2026-06-16T00:00:01.000Z",
          }],
          operations: [{
            sessionId: "session-a",
            theaterId,
            cwd: dir,
            cwdLabel: path.basename(dir),
            sequence: 1,
            cliId: "claude",
            cliLabel: "Claude",
            createdAt: 1_000,
          }],
        }));
        fs.writeFileSync(path.join(capturesDir, "session-a.json"), JSON.stringify({
          provider: "claude",
          sessionId: "provider-session-secret",
          transcriptPath: "/secret/transcript.jsonl",
          source: "resume",
          capturedAt: "2026-06-16T00:00:02.000Z",
        }));
      },
      terminalStartShell: (launch) => {
        launchedArgs.push(launch.args);
        return createMockPty();
      },
    });
    const capturePath = path.join(fixture.carrierStoreDir, "console", "captures", "session-a.json");

    const before = await getJson<{ readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly status: string; readonly resumeAvailable: boolean }> }>(`${fixture.endpoint}terminal/sessions`);
    const resumed = await fetch(`${fixture.endpoint}terminal/sessions/session-a/resume`, { method: "POST" });
    const body = await resumed.json() as Record<string, unknown>;
    const state = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "console", "state.json"), "utf8")) as { readonly operations: ReadonlyArray<{ readonly providerSession?: unknown }> };
    const serialized = JSON.stringify(body);

    expect(before.sessions[0]).toMatchObject({ sessionId: "session-a", status: "dormant", resumeAvailable: true });
    expect(resumed.status).toBe(200);
    expect(body).toMatchObject({ sessionId: "session-a", status: "registered", resumeAvailable: true });
    expect(injectedResumeIds).toEqual(["provider-session-secret"]);
    expect(launchedArgs).toEqual([["--resume-from-admiral"]]);
    expect(state.operations[0]?.providerSession).toMatchObject({ provider: "claude", sessionId: "provider-session-secret" });
    expect(fs.existsSync(capturePath)).toBe(false);
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain("provider-session-secret");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("providerSession");
  });

  it.skip("forgets dormant terminal sessions from durable state and capture files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-dormant-delete-"));
    tempDirs.push(dir);
    const realpath = fs.realpathSync.native(dir);
    const theaterId = workspaceHash(realpath);
    const fixture = await startFixture({
      beforeCreateServer: ({ carrierStoreDir }) => {
        const consoleDir = path.join(carrierStoreDir, "console");
        const capturesDir = path.join(consoleDir, "captures");
        fs.mkdirSync(capturesDir, { recursive: true });
        fs.writeFileSync(path.join(consoleDir, "state.json"), JSON.stringify({
          version: 1,
          theaters: [{
            id: theaterId,
            path: dir,
            realpath,
            label: path.basename(dir),
            registeredAt: "2026-06-16T00:00:00.000Z",
            lastOpenedAt: "2026-06-16T00:00:01.000Z",
          }],
          operations: [{
            sessionId: "session-a",
            theaterId,
            cwd: dir,
            cwdLabel: path.basename(dir),
            sequence: 1,
            cliId: "claude",
            createdAt: 1_000,
            providerSession: {
              provider: "claude",
              sessionId: "provider-session-secret",
              capturedAt: "2026-06-16T00:00:02.000Z",
            },
          }],
        }));
        fs.writeFileSync(path.join(capturesDir, "session-a.json"), JSON.stringify({
          provider: "claude",
          sessionId: "provider-session-secret",
          capturedAt: "2026-06-16T00:00:02.000Z",
        }));
      },
    });

    const deleted = await fetch(`${fixture.endpoint}terminal/sessions/session-a`, { method: "DELETE" });
    const sessions = await getJson<{ readonly sessions: readonly unknown[] }>(`${fixture.endpoint}terminal/sessions`);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "console", "state.json"), "utf8")) as { readonly operations: readonly unknown[] };

    expect(deleted.status).toBe(200);
    expect(sessions.sessions).toEqual([]);
    expect(state.operations).toEqual([]);
    expect(fs.existsSync(path.join(fixture.carrierStoreDir, "console", "captures", "session-a.json"))).toBe(false);
  });

  it.skip("forgets a Theater with its child operations and capture files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-theater-delete-"));
    tempDirs.push(dir);
    const realpath = fs.realpathSync.native(dir);
    const theaterId = workspaceHash(realpath);
    const fixture = await startFixture({
      beforeCreateServer: ({ carrierStoreDir }) => {
        const consoleDir = path.join(carrierStoreDir, "console");
        const capturesDir = path.join(consoleDir, "captures");
        fs.mkdirSync(capturesDir, { recursive: true });
        fs.writeFileSync(path.join(consoleDir, "state.json"), JSON.stringify({
          version: 3,
          theaters: [{
            id: theaterId,
            path: dir,
            realpath,
            label: path.basename(dir),
            registeredAt: "2026-06-16T00:00:00.000Z",
            lastOpenedAt: "2026-06-16T00:00:01.000Z",
          }],
          operations: [
            {
              id: "session-a",
              theaterId,
              type: "agent",
              pluginId: "terminal",
              title: "Terminal",
              payload: { terminalSessionId: "session-a", providerSession: { provider: "claude", sessionId: "provider-session-secret", capturedAt: "2026-06-16T00:00:02.000Z" } },
              geometry: null,
              state: {},
              ts: { createdAt: 1_000, updatedAt: 1_000 },
            },
            {
              id: "operation-root",
              theaterId,
              type: "operation",
              pluginId: "demo",
              title: "Operation Root",
              payload: { visible: true },
              geometry: null,
              state: {},
              ts: { createdAt: 1_001, updatedAt: 1_001 },
            },
          ],
        }));
        fs.writeFileSync(path.join(capturesDir, "session-a.json"), JSON.stringify({
          provider: "claude",
          sessionId: "provider-session-secret",
          capturedAt: "2026-06-16T00:00:02.000Z",
        }));
      },
    });

    const deleted = await fetch(`${fixture.endpoint}api/v1/theaters/${encodeURIComponent(theaterId)}`, { method: "DELETE" });
    const theaters = await getJson<{ readonly theaters: readonly unknown[] }>(`${fixture.endpoint}api/v1/theaters`);
    const sessions = await getJson<{ readonly sessions: readonly unknown[] }>(`${fixture.endpoint}terminal/sessions`);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "console", "state.json"), "utf8")) as { readonly theaters: readonly unknown[]; readonly operations: readonly unknown[] };

    expect(deleted.status).toBe(200);
    expect(theaters.theaters).toEqual([]);
    expect(sessions.sessions).toEqual([]);
    expect(state.theaters).toEqual([]);
    expect(state.operations).toEqual([]);
    expect(fs.existsSync(path.join(fixture.carrierStoreDir, "console", "captures", "session-a.json"))).toBe(false);
  });

  it.skip("moves a resumed live session with provider state back to dormant on natural PTY exit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-natural-dormant-"));
    tempDirs.push(dir);
    const realpath = fs.realpathSync.native(dir);
    const theaterId = workspaceHash(realpath);
    const ptys: ExitablePty[] = [];
    const fixture = await startFixture({
      beforeCreateServer: ({ carrierStoreDir }) => {
        const consoleDir = path.join(carrierStoreDir, "console");
        fs.mkdirSync(consoleDir, { recursive: true });
        fs.writeFileSync(path.join(consoleDir, "state.json"), JSON.stringify({
          version: 1,
          theaters: [{
            id: theaterId,
            path: dir,
            realpath,
            label: path.basename(dir),
            registeredAt: "2026-06-16T00:00:00.000Z",
            lastOpenedAt: "2026-06-16T00:00:01.000Z",
          }],
          operations: [{
            sessionId: "session-a",
            theaterId,
            cwd: dir,
            cwdLabel: path.basename(dir),
            sequence: 1,
            cliId: "claude",
            createdAt: 1_000,
            providerSession: {
              provider: "claude",
              sessionId: "provider-session-secret",
              capturedAt: "2026-06-16T00:00:02.000Z",
            },
          }],
        }));
      },
      terminalLaunch: createMockLaunch,
      terminalStartShell: () => {
        const pty = createExitablePty();
        ptys.push(pty);
        return pty;
      },
    });

    const resumed = await fetch(`${fixture.endpoint}terminal/sessions/session-a/resume`, { method: "POST" });
    expect(ptys).toHaveLength(1);
    ptys[0]!.emitExit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessions = await getJson<{ readonly sessions: ReadonlyArray<{ readonly status: string; readonly resumeAvailable: boolean }> }>(`${fixture.endpoint}terminal/sessions`);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "console", "state.json"), "utf8")) as { readonly operations: ReadonlyArray<{ readonly providerSession?: unknown }> };

    expect(resumed.status).toBe(200);
    expect(sessions.sessions[0]).toMatchObject({ status: "dormant", resumeAvailable: true });
    expect(state.operations[0]?.providerSession).toBeDefined();
  });

  it.skip("registers wiki-less Theaters as the observer superset without browser tokens", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-theater-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
    });

    const theaterGrant = await issueTheaterFolderGrant(fixture, dir);
    const created = await fetch(`${fixture.endpoint}api/v1/theaters`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderGrantId: theaterGrant.folderGrantId }) });
    const payload = await created.json() as Record<string, unknown>;
    const listed = await getJson<{ agentClis?: readonly Record<string, unknown>[]; theaters: readonly Record<string, unknown>[] }>(`${fixture.endpoint}api/v1/theaters`);
    const serialized = JSON.stringify({ payload, listed });

    expect(created.status).toBe(200);
    expect(payload).toMatchObject({
      id: workspaceHash(fs.realpathSync.native(dir)),
      label: path.basename(dir),
      hasWiki: false,
      activeAdmiralCount: 0,
    });
    expect(typeof payload.createdAt).toBe("string");
    expect(typeof payload.lastOpenedAt).toBe("string");
    expect(listed.theaters).toHaveLength(1);
    // id/label은 환경 무관하게 고정이지만 available/signedIn은 실제 설치/auth에 의존하므로
    // 매핑(id/label)만 단언하고 게이트 불린은 타입만 확인한다. 결합 로직은 별도 단위 테스트가 검증한다.
    expect((listed.agentClis ?? []).map((cli) => ({ id: cli.id, label: cli.label }))).toEqual([
      { id: "claude", label: "Claude" },
      { id: "claude-kimi", label: "Claude Kimi" },
      { id: "claude-glm", label: "Claude GLM" },
      { id: "codex", label: "Codex" },
    ]);
    for (const cli of listed.agentClis ?? []) {
      expect(typeof cli.available).toBe("boolean");
      expect(typeof cli.signedIn).toBe("boolean");
    }
    expect(payload).not.toHaveProperty("path");
    expect(listed.theaters[0]).not.toHaveProperty("path");
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain(fixture.lock.token);
    expect(serialized).not.toContain("folderGrantId");
    expect(serialized).not.toContain("ticket");
  });

  it("marks wiki-backed Theaters as the Codex workspace subset", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-theater-wiki-"));
    tempDirs.push(dir);
    createWikiRoot(dir);
    const fixture = await startFixture({
    });

    const theaterGrant = await issueTheaterFolderGrant(fixture, dir);
    const created = await fetch(`${fixture.endpoint}api/v1/theaters`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderGrantId: theaterGrant.folderGrantId }) });
    const payload = await created.json() as { readonly id: string; readonly hasWiki: boolean };
    // 등록된 codex 워크스페이스 라우트가 접근 가능한지 확인.
    const search = await fetch(`${fixture.endpoint}console/codex/w/${payload.id}/api/conflicts`);

    expect(created.status).toBe(200);
    expect(payload).toMatchObject({ id: workspaceHash(fs.realpathSync.native(dir)), hasWiki: true });
    expect(search.status).toBe(200);
  });

  it("serves sanitized observer status with active Theater wiki availability", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-status-wiki-"));
    tempDirs.push(dir);
    createWikiRoot(dir);
    const fixture = await startFixture({
    });

    const theaterGrant = await issueTheaterFolderGrant(fixture, dir);
    const created = await fetch(`${fixture.endpoint}api/v1/theaters`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderGrantId: theaterGrant.folderGrantId }) });
    const theater = await created.json() as { readonly id: string };
    const status = await getJson<Record<string, unknown>>(`${fixture.endpoint}api/v1/status?theaterId=${encodeURIComponent(theater.id)}`);
    const serialized = JSON.stringify(status);

    expect(status).toMatchObject({
      workspaces: 0,
      version: "test",
      updateAvailable: false,
      port: fixture.lock.port,
      wikiServerStatus: "available",
    });
    expect(status.channel === "local" || status.channel === "stable" || status.channel === "unknown").toBe(true);
    expect(status).not.toHaveProperty("token");
    expect(status).not.toHaveProperty("path");
    expect(status).not.toHaveProperty("cwd");
    expect(status).not.toHaveProperty("knowledgeRoot");
    expect(status).not.toHaveProperty("providerAuthStatus");
    expect(serialized).not.toContain(fixture.lock.token);
    expect(serialized).not.toContain(dir);
  });

  it("keeps Theater, Codex workspace, and session ids aligned for case-variant native realpaths", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-case-"));
    const variantDir = path.join(path.dirname(dir), path.basename(dir).toUpperCase());
    tempDirs.push(dir);
    createWikiRoot(dir);
    const nativeRealpath = fs.realpathSync.native;
    const realpathSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation((input) => {
      if (path.resolve(String(input)) === path.resolve(variantDir)) return nativeRealpath(dir);
      return nativeRealpath(input);
    });
    try {
      const theaters = new TheaterRegistry();
      const codexWorkspaces = new WorkspaceRegistry();
      const observability = createConsoleObservabilityStore();
      const theater = await theaters.register(variantDir);
      const codexWorkspace = await codexWorkspaces.register(variantDir);
      observability.createPendingTerminalSession({ sessionId: "session-a", cwd: variantDir });
      observability.registerTerminalRuntimeSession({ sessionId: "session-a", label: "Alpha", mcpToolCount: 1 });
      const session = observability.listWorkspaces()[0];

      expect(theater.id).toBe(workspaceHash(nativeRealpath(dir)));
      expect(codexWorkspace.id).toBe(theater.id);
      expect(session?.theaterId).toBe(theater.id);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("restores and removes Theaters while preserving id collision checks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-restore-theater-"));
    tempDirs.push(dir);
    const realpath = fs.realpathSync.native(dir);
    const id = workspaceHash(realpath);
    const theaters = new TheaterRegistry();

    theaters.restore([{
      id,
      path: dir,
      realpath,
      label: path.basename(dir),
      registeredAt: "2026-06-16T00:00:00.000Z",
      lastOpenedAt: "2026-06-16T00:00:01.000Z",
    }]);

    expect(theaters.get(id)?.path).toBe(dir);
    expect(theaters.remove(id)).toBe(true);
    expect(theaters.get(id)).toBeNull();
    expect(() => theaters.restore([
      { id, path: "/a", realpath: "/a", label: "a", registeredAt: "1", lastOpenedAt: "1" },
      { id, path: "/b", realpath: "/b", label: "b", registeredAt: "2", lastOpenedAt: "2" },
    ])).toThrow("theater_id_collision");
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

  it.skip("terminates a terminal session over DELETE and drops it from the session list", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-session-delete-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
      terminalLaunch: createMockLaunch,
      terminalStartShell: () => createMockPty(),
    });
    const headers = { "Content-Type": "application/json" };

    const grant = await issueTheaterFolderGrant(fixture, dir, headers);
    const created = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId, cliId: "claude" }),
    });
    const session = await created.json() as { readonly sessionId: string };
    const deleted = await fetch(`${fixture.endpoint}terminal/sessions/${encodeURIComponent(session.sessionId)}`, { method: "DELETE" });
    const afterList = await getJson<{ sessions: readonly unknown[] }>(`${fixture.endpoint}terminal/sessions`);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "console", "state.json"), "utf8")) as { readonly operations: readonly unknown[] };
    // 이미 종료된 세션 재삭제도 200으로 멱등 처리한다.
    const repeat = await fetch(`${fixture.endpoint}terminal/sessions/${encodeURIComponent(session.sessionId)}`, { method: "DELETE" });

    expect(created.status).toBe(200);
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ ok: true });
    expect(afterList.sessions).toHaveLength(0);
    expect(state.operations).toEqual([]);
    expect(repeat.status).toBe(200);
  });

  it.skip("renames a terminal session over PATCH without exposing raw cwd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-session-rename-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
      terminalLaunch: createMockLaunch,
      terminalStartShell: () => createMockPty(),
    });
    const headers = { "Content-Type": "application/json" };

    const grant = await issueTheaterFolderGrant(fixture, dir, headers);
    const created = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId, cliId: "claude" }),
    });
    const session = await created.json() as { readonly sessionId: string };
    const renamed = await fetch(`${fixture.endpoint}terminal/sessions/${encodeURIComponent(session.sessionId)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ label: "  Bridge Watch  " }),
    });
    const renamedBody = await renamed.json() as { readonly label?: string; readonly cwd?: unknown };
    const reset = await fetch(`${fixture.endpoint}terminal/sessions/${encodeURIComponent(session.sessionId)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ label: "" }),
    });
    const resetBody = await reset.json() as { readonly label?: string };
    const listed = await getJson<{ sessions: ReadonlyArray<{ readonly label?: string; readonly cwd?: unknown }> }>(`${fixture.endpoint}terminal/sessions`);
    const serialized = JSON.stringify({ renamedBody, resetBody, listed });

    expect(renamed.status).toBe(200);
    expect(renamedBody).toMatchObject({ label: "Bridge Watch" });
    expect(reset.status).toBe(200);
    expect(resetBody.label).toBeUndefined();
    expect(listed.sessions[0]?.label).toBeUndefined();
    expect(serialized).not.toContain(dir);
    expect(renamedBody.cwd).toBeUndefined();
  });

  it.skip("injects '/rename <label>' into the session PTY and neutralizes control characters", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-rename-inject-"));
    tempDirs.push(dir);
    const ptys = new Map<string, TerminalPtyHandle & { readonly writes: string[] }>();
    const fixture = await startFixture({
      // rename 슬래시 명령을 지원하는 CLI 프로파일로 launch된 세션(launch spec에 renameCommand 포함).
      terminalLaunch: async (cwd, context) => ({ ...(await createMockLaunch(cwd, context)), renameCommand: "/rename" }),
      terminalStartShell: (launch) => {
        const pty = createRecordingPty();
        ptys.set(String(launch.env.FLEET_CONSOLE_SESSION_ID), pty);
        return pty;
      },
    });
    const headers = { "Content-Type": "application/json" };
    const session = await createTerminalSession(fixture, headers, dir);
    const patchLabel = (label: string) =>
      fetch(`${fixture.endpoint}terminal/sessions/${encodeURIComponent(session.sessionId)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ label }),
      });

    // 정상 라벨 → '/rename <label>'과 엔터('\r')가 정확히 한 번 주입된다.
    await patchLabel("  Bridge Watch  ");
    // 개행/캐리지리턴/ESC/bell을 섞은 악성 라벨 → 단일 라인으로 강제되고 제어문자(ESC·bell)가
    // 제거되어 '/rename' 한 줄을 분리하는 추가 명령 주입이 불가능하다([31m은 ESC가 빠져 무해한 텍스트).
    await patchLabel("x\r\n/evil --pwn\u001b[31m\u0007");
    // 빈 라벨(콘솔 기본 표시명 복귀)에는 주입하지 않는다.
    await patchLabel("   ");
    // 제어문자만 있는 라벨 → sanitize 후 빈 값이므로 인자 없는 bare '/rename'을 주입하지 않는다.
    await patchLabel("\u0007\u001b");

    expect(ptys.get(session.sessionId)?.writes).toEqual([
      "/rename Bridge Watch\r",
      "/rename x /evil --pwn[31m\r",
    ]);
  });

  it.skip("skips rename injection for sessions without a rename-capable CLI", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-rename-skip-"));
    tempDirs.push(dir);
    const ptys = new Map<string, TerminalPtyHandle & { readonly writes: string[] }>();
    const fixture = await startFixture({
      terminalLaunch: createMockLaunch,
      terminalStartShell: (launch) => {
        const pty = createRecordingPty();
        ptys.set(String(launch.env.FLEET_CONSOLE_SESSION_ID), pty);
        return pty;
      },
    });
    const headers = { "Content-Type": "application/json" };
    // createMockLaunch는 renameCommand 없는 launch spec을 반환한다(FLEET_TERMINAL_CMD 임의 override·미지원
    // CLI 모사). 따라서 이 세션의 rename은 미지원 명령을 주입하지 않는다.
    const session = await createTerminalSession(fixture, headers, dir);
    await fetch(`${fixture.endpoint}terminal/sessions/${encodeURIComponent(session.sessionId)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ label: "Bridge Watch" }),
    });

    expect(ptys.get(session.sessionId)?.writes).toEqual([]);
  });

  it("rejects terminal WebSocket upgrades without a valid ticket boundary", () => {
    let destroyed = 0;
    const handler = createPluginTerminalUpgradeHandler({
      tickets: { consume: () => null },
      sessions: { canAttach: () => true, createSession: async () => undefined, attach: async () => undefined, getSessionMessagePolicy: () => undefined, getSessionRenameCommand: () => undefined, terminate: () => false, stop: async () => undefined, writeToSession: () => false, hasLiveSessions: () => false },
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

  it("checks terminal WebSocket capacity with the ticket sessionId", () => {
    let destroyed = 0;
    const checkedSessionIds: string[] = [];
    const handler = createPluginTerminalUpgradeHandler({
      tickets: { consume: () => ({ sessionId: "session-a", cwd: "/tmp" }) },
      sessions: {
        canAttach: (sessionId) => {
          checkedSessionIds.push(sessionId);
          return false;
        },
        createSession: async () => undefined,
        attach: async () => undefined,
        getSessionMessagePolicy: () => undefined,
        getSessionRenameCommand: () => undefined,
        terminate: () => false,
        stop: async () => undefined,
        writeToSession: () => false,
        hasLiveSessions: () => false,
      },
      isAuthorized: () => true,
    });

    const handled = handler.handleUpgrade({
      req: {
        url: `${"/plugins/terminal"}/ws?ticket=ticket-a`,
        headers: { origin: "http://127.0.0.1:37283" },
        rawHeaders: ["Host", "127.0.0.1:37283"],
      } as never,
      socket: { destroy: () => { destroyed += 1; } } as never,
      head: Buffer.alloc(0),
      pathname: `${"/plugins/terminal"}/ws`,
    });

    expect(handled).toBe(true);
    expect(checkedSessionIds).toEqual(["session-a"]);
    expect(destroyed).toBe(1);
    handler.close();
  });
});

describe("observer theater forget", () => {
  it("forgets a Theater whose directory was deleted on disk", async () => {
    const theaterDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-forget-deleted-"));
    const fixture = await startFixture();
    const theater = await createTheater(fixture, theaterDir);

    // 사용자 시나리오: 추가된 Theater의 디렉터리가 파일시스템에서 사라진 뒤 forget을 수행한다.
    fs.rmSync(theaterDir, { recursive: true, force: true });

    const forget = await fetch(`${fixture.endpoint}api/v1/theaters/${encodeURIComponent(theater.id)}`, { method: "DELETE" });
    expect(forget.status).toBe(200);

    const remaining = await getJson<{ readonly theaters: ReadonlyArray<{ readonly id: string }> }>(`${fixture.endpoint}api/v1/theaters`);
    expect(remaining.theaters).toEqual([]);
  });

  it("treats forget of an unknown/already-removed Theater as success (idempotent DELETE)", async () => {
    const fixture = await startFixture();

    const forget = await fetch(`${fixture.endpoint}api/v1/theaters/deadbeefdead`, { method: "DELETE" });
    expect(forget.status).toBe(200);
    expect(await forget.json()).toEqual({ ok: true });
  });
});

async function startFixture(options: {
  readonly agentRuntime?: ConsoleServerDeps["agentRuntime"];
  readonly agentCliDetector?: ConsoleServerDeps["agentCliDetector"];
  readonly beforeCreateServer?: (paths: { readonly carrierStoreDir: string }) => void;
  readonly terminalLaunch?: (cwd?: string, context?: { readonly sessionId?: string; readonly cliId?: string; readonly resumeSessionId?: string }) => Promise<TerminalLaunchSpec>;
  readonly terminalStartShell?: (launch: TerminalLaunchSpec) => TerminalPtyHandle;
  readonly release?: ConsoleServerDeps["release"];
  readonly updateApply?: ConsoleServerDeps["updateApply"];
  readonly updateCheck?: ConsoleServerDeps["updateCheck"];
} = {}): Promise<ServerFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-server-"));
  const carrierStoreDir = path.join(dir, "fleet-home");
  initStore(carrierStoreDir);
  options.beforeCreateServer?.({ carrierStoreDir });
  const terminalHooks = globalThis as {
    __fleetTerminalLaunch?: typeof options.terminalLaunch;
    __fleetTerminalStartShell?: typeof options.terminalStartShell;
  };
  if (options.terminalLaunch) terminalHooks.__fleetTerminalLaunch = options.terminalLaunch;
  if (options.terminalStartShell) terminalHooks.__fleetTerminalStartShell = options.terminalStartShell;
  tempDirs.push(dir);
  const lockFile = path.join(dir, "console.lock");
  const server = createConsoleServer({
    port: 0,
    version: "test",
    agentRuntime: options.agentRuntime,
    // 기본은 4개 바이너리 모두 설치된 것으로 stub해 기존 테스트(claude/codex 세션)가 PATH 환경에
    // 의존하지 않게 한다. 게이트 거부 케이스는 개별 테스트가 overrides로 미설치를 주입한다.
    agentCliDetector: options.agentCliDetector ?? createStubAgentCliDetector(),
    dataDir: carrierStoreDir,
    release: options.release,
    updateApply: options.updateApply,
    updateCheck: options.updateCheck,
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile });
  const lock = createConsoleLock().readLock(lockFile)!;
  return { dir, carrierStoreDir, lockFile, server, endpoint, lock };
}

function createStubAgentCliDetector(overrides: Record<string, boolean> = {}): AgentCliDetector {
  // cliCommand 단위 바이너리(claude/codex/opencode/cursor-agent)별 설치 여부를 stub한다. 기본 모두 설치됨.
  const commands = ["claude", "codex", "opencode", "cursor-agent"];
  return {
    detect: async () => commands.map((id) => ({
      id,
      displayName: id,
      available: overrides[id] ?? true,
      version: null,
    })),
  };
}

function createPluginPackageRoot(options: { readonly demoRoutes: string }): { readonly release: ConsoleServerDeps["release"] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-package-"));
  tempDirs.push(dir);
  const packageRoot = path.join(dir, "runtime", "fleet-console");
  const pluginsRoot = path.join(dir, "runtime", "fleet-plugins");
  writeTestPlugin(path.join(pluginsRoot, "terminal"), "terminal", [
    "export function register(ctx) {",
    "}",
  ].join("\n"));
  writeTestPlugin(path.join(pluginsRoot, "demo"), "demo", options.demoRoutes);
  fs.mkdirSync(packageRoot, { recursive: true });
  return { release: { channel: "local", version: "test", packageRoot } };
}

function writeTestPlugin(pluginRoot: string, id: string, routes: string): void {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify({ id, routes: "routes.mjs" }));
  fs.writeFileSync(path.join(pluginRoot, "routes.mjs"), routes);
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

async function createShellOperation(fixture: ServerFixture, theaterId: string): Promise<{ readonly id: string }> {
  return createOperation(fixture, theaterId, { type: "shell", pluginId: "terminal" });
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

function createFakeConsoleRuntime(issuedLabels: string[], releasedLabels: string[]): FakeConsoleRuntime {
  const handlers = new Set<(event: unknown) => void>();
  return {
    carrierRuntime: {
      jobs: {
        streaming: {
          register(callback) {
            handlers.add(callback);
            return () => handlers.delete(callback);
          },
        },
      },
    },
    dedicatedMcpSession: {
      issueSessionToken(request) {
        issuedLabels.push(request.label);
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

async function readObserverChunk(fixture: ServerFixture): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(`${fixture.endpoint}observer/events`, { signal: controller.signal });
  const chunk = new TextDecoder().decode((await response.body!.getReader().read()).value);
  controller.abort();
  return chunk;
}

function ensureStaticIndex(): string {
  const indexPath = path.resolve("dist/client/index.html");
  if (previousStaticIndex === undefined) {
    previousStaticIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : null;
  }
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, "<!doctype html><title>console-test-index</title>");
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
      this.writes.push(data);
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
