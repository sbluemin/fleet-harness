import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { initStore, resetStoreForTests } from "@dotobokuri/fleet-carriers";

import type { ConsoleLockPayload } from "../src/api-types.js";
import { createConsoleLock } from "../src/lock.js";
import { createConsoleObservabilityStore } from "../src/observability-store.js";
import { createConsoleServer, type ConsoleServer, type ConsoleServerDeps } from "../src/server.js";
import { workspaceHash } from "../src/theater.js";
import { TheaterRegistry } from "../src/theaters.js";
import { WorkspaceRegistry } from "../src/codex/workspaces.js";
import type { TerminalLaunchSpec, TerminalPtyHandle } from "../src/terminal/types.js";
import { createTerminalUpgradeHandler } from "../src/terminal/ws-handler.js";

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

  it("replays existing observer events over SSE resync", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-sse-"));
    tempDirs.push(dir);
    const runtime = createFakeConsoleRuntime([], []);
    const runtimeFixture = await startFixture({
      agentRuntime: runtime as never,
      terminalLaunchResolverDeps: {
        cwd: dir,
        env: { PATH: "/bin" } as NodeJS.ProcessEnv,
        injectProfile: (async (profile: { readonly cwd: string; readonly args: readonly string[] }) => ({ ...profile, args: [...profile.args, "--fleet-test"] })) as never,
        resolveProfile: (async (env: NodeJS.ProcessEnv, cwd: string) => ({
          id: "claude",
          label: "Claude Code",
          bin: "/bin/claude",
          args: [],
          cwd,
          env: { ...env },
        })) as never,
      },
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

  it("does not expose a live workspace when PTY spawn fails after runtime profile injection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-spawn-fail-"));
    tempDirs.push(dir);
    const runtime = createFakeConsoleRuntime([], []);
    const fixture = await startFixture({
      agentRuntime: runtime as never,
      terminalLaunchResolverDeps: {
        cwd: dir,
        env: { PATH: "/bin" } as NodeJS.ProcessEnv,
        injectProfile: (async (profile: { readonly cwd: string; readonly args: readonly string[] }) => ({ ...profile, args: [...profile.args, "--fleet-test"] })) as never,
        resolveProfile: (async (env: NodeJS.ProcessEnv, cwd: string) => ({
          id: "claude",
          label: "Claude Code",
          bin: "/bin/claude",
          args: [],
          cwd,
          env: { ...env },
        })) as never,
      },
      terminalStartShell: () => {
        throw new Error("spawn failed");
      },
    });
    const headers = { "Content-Type": "application/json" };

    const grant = await issueFolderGrant(fixture, dir, headers);
    const failed = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId }),
    });
    const failedBody = await failed.json();
    const observerTenants = await getJson<{ readonly tenants: readonly unknown[] }>(`${fixture.endpoint}observer/tenants`);
    const observerStatus = await getJson<{ readonly workspaces: number }>(`${fixture.endpoint}observer/status`);
    const terminalSessions = await getJson<{ readonly sessions: ReadonlyArray<{ readonly status: string }> }>(`${fixture.endpoint}terminal/sessions`);

    expect(failed.status).toBe(503);
    expect(failedBody).toEqual({ error: "terminal_unavailable" });
    expect(observerTenants.tenants).toEqual([]);
    expect(observerStatus.workspaces).toBe(0);
    expect(terminalSessions.sessions[0]?.status).toBe("error");
  });

  it("registers the runtime workspace only after PTY spawn succeeds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-spawn-success-"));
    tempDirs.push(dir);
    const runtime = createFakeConsoleRuntime([], []);
    const fixture = await startFixture({
      agentRuntime: runtime as never,
      terminalLaunchResolverDeps: {
        cwd: dir,
        env: { PATH: "/bin" } as NodeJS.ProcessEnv,
        injectProfile: (async (profile: { readonly cwd: string; readonly args: readonly string[] }) => ({ ...profile, args: [...profile.args, "--fleet-test"] })) as never,
        resolveProfile: (async (env: NodeJS.ProcessEnv, cwd: string) => ({
          id: "claude",
          label: "Claude Code",
          bin: "/bin/claude",
          args: [],
          cwd,
          env: { ...env },
        })) as never,
      },
      terminalStartShell: () => createMockPty(),
    });
    const theater = await createTheater(fixture, dir);
    const created = await fetch(`${fixture.endpoint}observer/theaters/${encodeURIComponent(theater.id)}/sessions`, { method: "POST", body: JSON.stringify({ cliId: "claude" }) });
    expect(created.status).toBe(200);
    const session = await created.json() as { readonly sessionId: string };
    runtime.emit({ type: "track:text", jobId: "job-a", originSessionId: session.sessionId, trackId: "t1", text: "hello" });

    const observerTenants = await getJson<{ readonly tenants: ReadonlyArray<{ readonly tenantId: string; readonly tenantLabel: string; readonly terminalSessionId?: string }> }>(`${fixture.endpoint}observer/tenants`);
    const observerJobs = await getJson<{ readonly tenants: ReadonlyArray<{ readonly jobs: ReadonlyArray<{ readonly jobId: string }> }> }>(`${fixture.endpoint}observer/jobs`);

    expect(observerTenants.tenants).toEqual([
      expect.objectContaining({ tenantId: session.sessionId, tenantLabel: "Claude Code", terminalSessionId: session.sessionId }),
    ]);
    expect(observerJobs.tenants[0]?.jobs[0]?.jobId).toBe("job-a");
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

  it("issues terminal tickets without browser tokens and selects session cwd internally", async () => {
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

  it("rejects terminal tickets for unknown session ids without falling back to process cwd", async () => {
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
    const shell = await fetch(`${fixture.endpoint}terminal/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "shell" }),
    });
    const shellBody = await shell.json() as { readonly ticket?: unknown; readonly cwd?: unknown };

    expect(missingSession.status).toBe(404);
    expect(missingBody).toEqual({ error: "terminal_session_not_found" });
    expect(missingId.status).toBe(400);
    expect(missingIdBody).toEqual({ error: "terminal_session_not_found" });
    expect(shell.status).toBe(200);
    expect(typeof shellBody.ticket).toBe("string");
    expect(shellBody.cwd).toBeUndefined();
  });

  it("issues theater-shell tickets resolving Theater cwd server-side and rejects unknown Theaters", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-theater-shell-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
      terminalStartShell: () => createMockPty(),
    });
    const theater = await createTheater(fixture, dir);

    const issued = await fetch(`${fixture.endpoint}terminal/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "shell:1", kind: "shell", theaterId: theater.id }),
    });
    const issuedBody = await issued.json() as { readonly ticket?: unknown; readonly cwd?: unknown };

    const unknownTheater = await fetch(`${fixture.endpoint}terminal/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "shell:2", kind: "shell", theaterId: "deadbeefdead" }),
    });
    const unknownBody = await unknownTheater.json();

    expect(issued.status).toBe(200);
    expect(typeof issuedBody.ticket).toBe("string");
    // theater-shell ticket도 raw Theater 경로를 응답에 노출하지 않는다(cwd는 서버 측에서만 해석).
    expect(issuedBody.cwd).toBeUndefined();
    expect(unknownTheater.status).toBe(404);
    expect(unknownBody).toEqual({ error: "theater_not_found" });
  });

  it("keeps MCP bearer tokens out of terminal tickets, observer snapshots, SSE frames, static HTML, and launch errors", async () => {
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
    const grant = await issueFolderGrant(fixture, dir, headers);
    const failedLaunch = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId }),
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

  it("keeps one shared runtime active across two terminal sessions and releases only the closed session token", async () => {
    const fakeToken = "mcp-success-flow-secret";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-shared-runtime-"));
    tempDirs.push(dir);
    const issuedLabels: string[] = [];
    const releasedLabels: string[] = [];
    const runtime = createFakeConsoleRuntime(issuedLabels, releasedLabels);
    const terminalLaunchResolverDeps = {
      cwd: dir,
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      injectProfile: (async (profile: { readonly cwd: string; readonly args: readonly string[] }, options: { readonly dedicatedMcpSession: FakeConsoleRuntime["dedicatedMcpSession"]; readonly onCleanup?: (cleanup: () => void) => void }) => {
        const opts = options as typeof options & { readonly mcpSessionLabel: string };
        options.dedicatedMcpSession.issueSessionToken({ label: opts.mcpSessionLabel, cwd: profile.cwd });
        options.onCleanup?.(() => options.dedicatedMcpSession.releaseSessionToken(opts.mcpSessionLabel));
        return { ...profile, args: [...profile.args, "--fleet-test"] };
      }) as never,
      resolveProfile: (async (env: NodeJS.ProcessEnv, cwd: string) => ({
        id: "claude",
        label: "Claude Code",
        bin: "/bin/claude",
        args: [],
        cwd,
        env: { ...env },
      })) as never,
    };
    const fixture = await startFixture({
      agentRuntime: runtime as never,
      terminalLaunchResolverDeps,
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

  it("injects finalized carrier reminders only into the originating live terminal session", async () => {
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

  it("keeps carrier reminder payloads out of browser snapshots and SSE frames", async () => {
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

  it("cleans up internally created agent runtime when console startup fails before lock commit", async () => {
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

  it("lists terminal folders through the browser API without native cancellation", async () => {
    const response = await fetchWithBlockedPortRetry((fixture) =>
      fetch(`${fixture.endpoint}terminal/folders/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: null }),
      }));
    const body = await response.json() as { readonly path?: unknown; readonly entries?: unknown };

    expect(response.status).toBe(200);
    expect(typeof body.path).toBe("string");
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it("rejects terminal routes when the browser Origin is not the console origin", async () => {
    const fixture = await startFixture();

    const response = await fetch(`${fixture.endpoint}terminal/folders/list`, {
      method: "POST",
      headers: { origin: "http://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ path: null }),
    });

    expect(response.status).toBe(401);
  });

  it("creates terminal sessions from one-use folder grants and rejects raw cwd", async () => {
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

    const grant = await issueFolderGrant(fixture, dir, headers);
    const rawCwd = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: dir }),
    });
    const created = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId }),
    });
    const replay = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId }),
    });
    const list = await fetch(`${fixture.endpoint}terminal/sessions`, { headers });
    const session = await created.json() as { readonly sessionId: string; readonly status: string; readonly cwd?: unknown };

    expect(rawCwd.status).toBe(400);
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
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { readonly version: number; readonly operations: readonly Record<string, unknown>[] };
    expect(state.version).toBe(1);
    expect(state.operations).toHaveLength(1);
    expect(state.operations[0]).toMatchObject({ sessionId: session.sessionId, cwd: dir });
    expect(state.operations[0]?.providerSession).toBeUndefined();
    if (process.platform !== "win32") expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    await expect(list.json()).resolves.toMatchObject({ sessions: [{ sessionId: session.sessionId, status: "terminal-only" }] });
  });

  it("rehydrates a created operation from a later capture without an intermediate persist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-restart-"));
    tempDirs.push(dir);
    const startedShells: string[] = [];
    const fixture = await startFixture({
      terminalLaunch: createMockLaunch,
      terminalStartShell: (launch) => {
        startedShells.push(launch.cwd);
        return createMockPty();
      },
    });
    const theater = await createTheater(fixture, dir);
    const created = await fetch(`${fixture.endpoint}observer/theaters/${encodeURIComponent(theater.id)}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cliId: "codex" }),
    });
    const session = await created.json() as { readonly sessionId: string; readonly status: string };
    const statePath = path.join(fixture.carrierStoreDir, "console", "state.json");
    const initialState = JSON.parse(fs.readFileSync(statePath, "utf8")) as { readonly operations: ReadonlyArray<{ readonly providerSession?: unknown; readonly sessionId?: unknown }> };
    const capturesDir = path.join(fixture.carrierStoreDir, "console", "captures");
    const capturePath = path.join(capturesDir, `${session.sessionId}.json`);

    fs.mkdirSync(capturesDir, { recursive: true });
    fs.writeFileSync(capturePath, JSON.stringify({
      provider: "codex",
      sessionId: "codex-provider-session-secret",
      transcriptPath: "/secret/codex/transcript.jsonl",
      source: "user-prompt-submit",
      capturedAt: "2026-06-16T00:00:02.000Z",
    }));
    await fixture.server.stop();
    const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-restart-lock-"));
    tempDirs.push(restartDir);
    const restartedServer = createConsoleServer({
      port: 0,
      version: "test",
      dataDir: fixture.carrierStoreDir,
      terminalLaunch: createMockLaunch,
      terminalStartShell: (launch) => {
        startedShells.push(launch.cwd);
        return createMockPty();
      },
    });
    servers.push(restartedServer);
    const restartedEndpoint = await restartedServer.start({ dir: restartDir, lockFile: path.join(restartDir, "console.lock") });

    const sessions = await getJson<{ readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly status: string; readonly resumeAvailable: boolean }> }>(`${restartedEndpoint}terminal/sessions`);
    const persistedState = JSON.parse(fs.readFileSync(statePath, "utf8")) as { readonly operations: ReadonlyArray<{ readonly providerSession?: unknown }> };
    const serialized = JSON.stringify(sessions);

    expect(created.status).toBe(200);
    expect(session.status).toBe("terminal-only");
    expect(initialState.operations[0]).toMatchObject({ sessionId: session.sessionId });
    expect(initialState.operations[0]?.providerSession).toBeUndefined();
    expect(startedShells).toEqual([dir]);
    expect(sessions.sessions[0]).toMatchObject({ sessionId: session.sessionId, status: "dormant", resumeAvailable: true });
    expect(persistedState.operations[0]?.providerSession).toMatchObject({ provider: "codex", sessionId: "codex-provider-session-secret" });
    expect(fs.existsSync(capturePath)).toBe(false);
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain("codex-provider-session-secret");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("providerSession");
  });

  it("keeps a wiki Theater's hasWiki true after a console restart by re-registering its Codex workspace", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-haswiki-"));
    tempDirs.push(dir);
    // Theater 디렉터리에 Fleet Wiki 지식 루트를 만들어 hasWiki=true 조건을 충족시킨다.
    fs.mkdirSync(path.join(dir, ".fleet", "knowledge"), { recursive: true });
    const fixture = await startFixture();
    const theater = await createTheater(fixture, dir);

    const beforeRestart = await getJson<{ readonly theaters: ReadonlyArray<{ readonly id: string; readonly hasWiki: boolean }> }>(`${fixture.endpoint}observer/theaters`);
    await fixture.server.stop();

    const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-haswiki-lock-"));
    tempDirs.push(restartDir);
    const restartedServer = createConsoleServer({ port: 0, version: "test", dataDir: fixture.carrierStoreDir });
    servers.push(restartedServer);
    const restartedEndpoint = await restartedServer.start({ dir: restartDir, lockFile: path.join(restartDir, "console.lock") });

    const afterRestart = await getJson<{ readonly theaters: ReadonlyArray<{ readonly id: string; readonly hasWiki: boolean }> }>(`${restartedEndpoint}observer/theaters`);

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

    // 등록 직후에는 codex 워크스페이스 라우트가 위키 health를 200으로 서빙한다.
    const beforeForget = await fetch(`${fixture.endpoint}console/codex/w/${encodeURIComponent(theater.id)}/api/health`, { redirect: "manual" });
    const deleted = await fetch(`${fixture.endpoint}observer/theaters/${encodeURIComponent(theater.id)}`, { method: "DELETE" });
    // forget 후에는 워크스페이스가 해제되어 같은 라우트가 codex 홈으로 302 리다이렉트된다.
    const afterForget = await fetch(`${fixture.endpoint}console/codex/w/${encodeURIComponent(theater.id)}/api/health`, { redirect: "manual" });
    const remaining = await getJson<{ readonly theaters: ReadonlyArray<{ readonly id: string }> }>(`${fixture.endpoint}observer/theaters`);

    expect(beforeForget.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(afterForget.status).toBe(302);
    expect(remaining.theaters.find((entry) => entry.id === theater.id)).toBeUndefined();
  });

  it("promotes the next most-recent Codex workspace as MRU when the active Theater is forgotten", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-mru-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-mru-b-"));
    tempDirs.push(dirA, dirB);
    fs.mkdirSync(path.join(dirA, ".fleet", "knowledge"), { recursive: true });
    fs.mkdirSync(path.join(dirB, ".fleet", "knowledge"), { recursive: true });
    const fixture = await startFixture();
    await createTheater(fixture, dirA);
    const theaterB = await createTheater(fixture, dirB); // 마지막 등록 = MRU

    // MRU(B)를 forget하면 남은 A가 MRU로 승격되어, getMru() 기반 비프리픽스 라우트가
    // deps.cwd 폴백이 아니라 A의 위키를 서빙해야 한다.
    const deleted = await fetch(`${fixture.endpoint}observer/theaters/${encodeURIComponent(theaterB.id)}`, { method: "DELETE" });
    const health = await fetch(`${fixture.endpoint}console/codex/api/health`, { redirect: "manual" });
    const body = await health.json() as { readonly knowledgeRoot?: string };

    expect(deleted.status).toBe(200);
    expect(health.status).toBe(200);
    expect(body.knowledgeRoot).toBe(path.join(fs.realpathSync.native(dirA), ".fleet", "knowledge"));
  });

  it("restores the most-recently-opened Codex workspace as MRU after a restart", async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-restart-mru-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-codex-restart-mru-b-"));
    tempDirs.push(dirA, dirB);
    fs.mkdirSync(path.join(dirA, ".fleet", "knowledge"), { recursive: true });
    fs.mkdirSync(path.join(dirB, ".fleet", "knowledge"), { recursive: true });
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

    // 재시작 후 codex MRU는 가장 최근에 열린 B여야 하므로 비프리픽스 health가 B의 knowledgeRoot를 서빙한다.
    const health = await fetch(`${restartedEndpoint}console/codex/api/health`, { redirect: "manual" });
    const body = await health.json() as { readonly knowledgeRoot?: string };

    expect(health.status).toBe(200);
    expect(body.knowledgeRoot).toBe(path.join(fs.realpathSync.native(dirB), ".fleet", "knowledge"));
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

    const bootstrap = await getJson<{ readonly theaters: ReadonlyArray<{ readonly id: string; readonly hasWiki: boolean }> }>(`${restartedEndpoint}observer/theaters`);

    expect(bootstrap.theaters.find((entry) => entry.id === theater.id)?.hasWiki).toBe(true);
  });

  it("rehydrates durable state as dormant without starting PTYs and merges capture files server-side", async () => {
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

    const theaters = await getJson<{ readonly theaters: readonly Record<string, unknown>[] }>(`${fixture.endpoint}observer/theaters`);
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

  it("does not restore durable operations without provider sessions", async () => {
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

  it("returns 404 or 409 for unavailable dormant resume requests", async () => {
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

  it("resumes a dormant operation lazily with provider session id kept server-side", async () => {
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
      terminalLaunchResolverDeps: {
        cwd: dir,
        env: { PATH: "/bin" } as NodeJS.ProcessEnv,
        injectProfile: (async (profile: { readonly args: readonly string[] }, options: { readonly resumeSessionId?: string }) => {
          injectedResumeIds.push(options.resumeSessionId);
          return { ...profile, args: [...profile.args, "--resume-from-admiral"] };
        }) as never,
        resolveProfile: (async (env: NodeJS.ProcessEnv, cwd: string) => ({
          id: "claude",
          label: "Claude Code",
          bin: "/bin/claude",
          args: [],
          cwd,
          env: { ...env },
          terminalName: "xterm-256color",
        })) as never,
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

  it("forgets dormant terminal sessions from durable state and capture files", async () => {
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

  it("forgets a Theater with its child operations and capture files", async () => {
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

    const deleted = await fetch(`${fixture.endpoint}observer/theaters/${encodeURIComponent(theaterId)}`, { method: "DELETE" });
    const theaters = await getJson<{ readonly theaters: readonly unknown[] }>(`${fixture.endpoint}observer/theaters`);
    const sessions = await getJson<{ readonly sessions: readonly unknown[] }>(`${fixture.endpoint}terminal/sessions`);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "console", "state.json"), "utf8")) as { readonly theaters: readonly unknown[]; readonly operations: readonly unknown[] };

    expect(deleted.status).toBe(200);
    expect(theaters.theaters).toEqual([]);
    expect(sessions.sessions).toEqual([]);
    expect(state.theaters).toEqual([]);
    expect(state.operations).toEqual([]);
    expect(fs.existsSync(path.join(fixture.carrierStoreDir, "console", "captures", "session-a.json"))).toBe(false);
  });

  it("moves a resumed live session with provider state back to dormant on natural PTY exit", async () => {
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

  it("keeps a newly captured live session dormant after natural PTY exit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-capture-exit-"));
    tempDirs.push(dir);
    const ptys: ExitablePty[] = [];
    const fixture = await startFixture({
      terminalLaunchResolverDeps: {
        cwd: dir,
        env: { PATH: "/bin" } as NodeJS.ProcessEnv,
        injectProfile: (async (profile: { readonly cwd: string; readonly args: readonly string[] }) => ({ ...profile, args: [...profile.args, "--fleet-test"] })) as never,
        resolveProfile: (async (env: NodeJS.ProcessEnv, cwd: string) => ({
          id: "claude",
          label: "Claude Code",
          bin: "/bin/claude",
          args: [],
          cwd,
          env: { ...env },
        })) as never,
      },
      terminalStartShell: () => {
        const pty = createExitablePty();
        ptys.push(pty);
        return pty;
      },
    });
    const theaterGrant = await issueFolderGrant(fixture, dir);
    const theaterResponse = await fetch(`${fixture.endpoint}observer/theaters`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderGrantId: theaterGrant.folderGrantId }) });
    expect(theaterResponse.status).toBe(200);
    const theater = await theaterResponse.json() as { readonly id: string };
    const created = await fetch(`${fixture.endpoint}observer/theaters/${encodeURIComponent(theater.id)}/sessions`, { method: "POST", body: JSON.stringify({ cliId: "claude" }) });
    expect(created.status).toBe(200);
    const session = await created.json() as { readonly sessionId: string };
    const capturesDir = path.join(fixture.carrierStoreDir, "console", "captures");
    const capturePath = path.join(capturesDir, `${session.sessionId}.json`);
    fs.mkdirSync(capturesDir, { recursive: true });
    fs.writeFileSync(capturePath, JSON.stringify({
      provider: "claude",
      sessionId: "provider-session-secret",
      capturedAt: "2026-06-16T00:00:00.000Z",
    }));

    expect(ptys).toHaveLength(1);
    ptys[0]!.emitExit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessions = await getJson<{ readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly status: string; readonly resumeAvailable: boolean }> }>(`${fixture.endpoint}terminal/sessions`);
    const tenants = await getJson<{ readonly tenants: readonly unknown[] }>(`${fixture.endpoint}observer/tenants`);
    const theaters = await getJson<{ readonly theaters: ReadonlyArray<{ readonly activeAdmiralCount: number }> }>(`${fixture.endpoint}observer/theaters`);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "console", "state.json"), "utf8")) as { readonly operations: ReadonlyArray<{ readonly providerSession?: unknown }> };

    expect(sessions.sessions[0]).toMatchObject({ sessionId: session.sessionId, status: "dormant", resumeAvailable: true });
    expect(tenants.tenants).toEqual([]);
    expect(theaters.theaters[0]?.activeAdmiralCount).toBe(0);
    expect(state.operations[0]?.providerSession).toMatchObject({ provider: "claude", sessionId: "provider-session-secret" });
    expect(fs.existsSync(capturePath)).toBe(false);
  });

  it("registers wiki-less Theaters as the observer superset without browser tokens", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-theater-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
    });

    const theaterGrant = await issueFolderGrant(fixture, dir);
    const created = await fetch(`${fixture.endpoint}observer/theaters`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderGrantId: theaterGrant.folderGrantId }) });
    const payload = await created.json() as Record<string, unknown>;
    const listed = await getJson<{ agentClis?: readonly Record<string, unknown>[]; theaters: readonly Record<string, unknown>[] }>(`${fixture.endpoint}observer/theaters`);
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
    expect(listed.agentClis).toEqual([
      { id: "claude", label: "Claude" },
      { id: "claude-kimi", label: "Claude Kimi" },
      { id: "codex", label: "Codex" },
    ]);
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

    const theaterGrant = await issueFolderGrant(fixture, dir);
    const created = await fetch(`${fixture.endpoint}observer/theaters`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderGrantId: theaterGrant.folderGrantId }) });
    const payload = await created.json() as { readonly id: string; readonly hasWiki: boolean };
    const health = await fetch(`${fixture.endpoint}console/codex/w/${payload.id}/api/health`);

    expect(created.status).toBe(200);
    expect(payload).toMatchObject({ id: workspaceHash(fs.realpathSync.native(dir)), hasWiki: true });
    expect(health.status).toBe(200);
  });

  it("serves sanitized observer status with active Theater wiki availability", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-status-wiki-"));
    tempDirs.push(dir);
    createWikiRoot(dir);
    const fixture = await startFixture({
    });

    const theaterGrant = await issueFolderGrant(fixture, dir);
    const created = await fetch(`${fixture.endpoint}observer/theaters`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderGrantId: theaterGrant.folderGrantId }) });
    const theater = await created.json() as { readonly id: string };
    const status = await getJson<Record<string, unknown>>(`${fixture.endpoint}observer/status?theaterId=${encodeURIComponent(theater.id)}`);
    const serialized = JSON.stringify(status);

    expect(status).toMatchObject({
      workspaces: 0,
      jobs: 0,
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

  it("serves sanitized carrier readiness entries without persona or credential details", async () => {
    const fixture = await startFixture();

    const payload = await getJson<{ readonly carriers: readonly Record<string, unknown>[] }>(`${fixture.endpoint}observer/carriers`);
    const first = payload.carriers[0];
    const serialized = JSON.stringify(payload);

    expect(payload.carriers.length).toBeGreaterThan(0);
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {}).sort()).toEqual([
      "carrierId",
      "category",
      "cliType",
      "displayName",
      "effort",
      "model",
      "role",
      "slot",
      "subagentMode",
      "taskForceBackendCount",
    ]);
    expect(first).toMatchObject({
      carrierId: expect.any(String),
      displayName: expect.any(String),
      model: expect.any(String),
      role: expect.any(String),
      slot: expect.any(Number),
      subagentMode: expect.any(Boolean),
      taskForceBackendCount: expect.any(Number),
    });
    for (const carrier of payload.carriers) {
      expect(carrier).not.toHaveProperty("token");
      expect(carrier).not.toHaveProperty("key");
      expect(carrier).not.toHaveProperty("credential");
      expect(carrier).not.toHaveProperty("cwd");
      expect(carrier).not.toHaveProperty("path");
      expect(carrier).not.toHaveProperty("persona");
      expect(carrier).not.toHaveProperty("prompt");
      expect(carrier).not.toHaveProperty("toolAllowlist");
      expect(carrier).not.toHaveProperty("allowedExecutorTools");
    }
    expect(serialized).not.toContain(fixture.lock.token);
    expect(serialized).not.toContain("permissions");
    expect(serialized).not.toContain("outputFormat");
    expect(serialized).not.toContain("allowedExecutorTools");
  });

  it("serves carrier readiness from the persisted carrier store", async () => {
    const fixture = await startFixture({
      beforeCreateServer: ({ carrierStoreDir }) => {
        fs.writeFileSync(path.join(carrierStoreDir, "carriers.json"), JSON.stringify({
          carriers: {
            nimitz: { displayName: "Nimitz Persisted" },
          },
        }), "utf8");
      },
    });

    const payload = await getJson<{ readonly carriers: readonly Record<string, unknown>[] }>(`${fixture.endpoint}observer/carriers`);
    const nimitz = payload.carriers.find((carrier) => carrier.carrierId === "nimitz");

    expect(nimitz).toMatchObject({
      carrierId: "nimitz",
      displayName: "Nimitz Persisted",
    });
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

    const errorResponse = await fetch(`${failed.endpoint}observer/theaters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderGrantId: "missing-grant" }),
    });
    await expect(errorResponse.json()).resolves.toEqual({ error: "invalid_folder_grant" });
    expect(errorResponse.status).toBe(400);
  });

  it("launches Theater sessions from the registered path and rejects unknown Theater ids", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-theater-launch-"));
    tempDirs.push(dir);
    const launches: TerminalLaunchSpec[] = [];
    const cliIds: Array<string | undefined> = [];
    const fixture = await startFixture({
      terminalLaunch: async (cwd, context) => {
        cliIds.push(context?.cliId);
        return createMockLaunch(cwd, context);
      },
      terminalStartShell: (launch) => {
        launches.push(launch);
        return createMockPty();
      },
    });
    const theater = await createTheater(fixture, dir);
    const unknown = await fetch(`${fixture.endpoint}observer/theaters/missing/sessions`, { method: "POST", body: JSON.stringify({ cwd: "/tmp/other" }) });
    const invalid = await fetch(`${fixture.endpoint}observer/theaters/${encodeURIComponent(theater.id)}/sessions`, { method: "POST", body: JSON.stringify({ cliId: "bogus" }) });
    const created = await fetch(`${fixture.endpoint}observer/theaters/${encodeURIComponent(theater.id)}/sessions`, { method: "POST", body: JSON.stringify({ cliId: "codex", cwd: "/tmp/ignored" }) });
    const session = await created.json() as { readonly sessionId: string; readonly theaterId: string; readonly cliId?: string; readonly cwd?: unknown };
    const sessions = await getJson<{ sessions: ReadonlyArray<{ readonly theaterId: string; readonly cwd?: unknown }> }>(`${fixture.endpoint}terminal/sessions`);
    const serialized = JSON.stringify({ session, sessions });

    expect(unknown.status).toBe(404);
    expect(invalid.status).toBe(400);
    expect(created.status).toBe(200);
    expect(session).toMatchObject({ theaterId: theater.id, cliId: "codex" });
    expect(session.cwd).toBeUndefined();
    expect(sessions.sessions[0]).not.toHaveProperty("cwd");
    expect(serialized).not.toContain(dir);
    expect(launches[0]?.cwd).toBe(dir);
    expect(cliIds).toEqual(["codex"]);
    expect(sessions.sessions[0]?.theaterId).toBe(theater.id);
  });

  it("terminates a terminal session over DELETE and drops it from the session list", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-session-delete-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
      terminalLaunch: createMockLaunch,
      terminalStartShell: () => createMockPty(),
    });
    const headers = { "Content-Type": "application/json" };

    const grant = await issueFolderGrant(fixture, dir, headers);
    const created = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId }),
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

  it("renames a terminal session over PATCH without exposing raw cwd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-session-rename-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
      terminalLaunch: createMockLaunch,
      terminalStartShell: () => createMockPty(),
    });
    const headers = { "Content-Type": "application/json" };

    const grant = await issueFolderGrant(fixture, dir, headers);
    const created = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId }),
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

  it("injects '/rename <label>' into the session PTY and neutralizes control characters", async () => {
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

  it("skips rename injection for sessions without a rename-capable CLI", async () => {
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
    const handler = createTerminalUpgradeHandler({
      expectedHost: "127.0.0.1",
      getExpectedPort: () => 37283,
      tickets: { consume: () => null },
      sessions: { canAttach: () => true, createSession: async () => undefined, attach: async () => undefined, getSessionMessagePolicy: () => undefined, getSessionRenameCommand: () => undefined, terminate: () => false, stop: async () => undefined, writeToSession: () => false },
      validateHost: () => true,
    });

    const handled = handler.handleUpgrade(
      {
        url: "/terminal/ws",
        headers: { origin: "http://127.0.0.1:37283" },
        rawHeaders: ["Host", "127.0.0.1:37283"],
      } as never,
      { destroy: () => { destroyed += 1; } } as never,
      Buffer.alloc(0),
    );

    expect(handled).toBe(true);
    expect(destroyed).toBe(1);
    handler.close();
  });

  it("checks terminal WebSocket capacity with the ticket sessionId", () => {
    let destroyed = 0;
    const checkedSessionIds: string[] = [];
    const handler = createTerminalUpgradeHandler({
      expectedHost: "127.0.0.1",
      getExpectedPort: () => 37283,
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
      },
      validateHost: () => true,
    });

    const handled = handler.handleUpgrade(
      {
        url: "/terminal/ws?ticket=ticket-a",
        headers: { origin: "http://127.0.0.1:37283" },
        rawHeaders: ["Host", "127.0.0.1:37283"],
      } as never,
      { destroy: () => { destroyed += 1; } } as never,
      Buffer.alloc(0),
    );

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

    const forget = await fetch(`${fixture.endpoint}observer/theaters/${encodeURIComponent(theater.id)}`, { method: "DELETE" });
    expect(forget.status).toBe(200);

    const remaining = await getJson<{ readonly theaters: ReadonlyArray<{ readonly id: string }> }>(`${fixture.endpoint}observer/theaters`);
    expect(remaining.theaters).toEqual([]);
  });

  it("treats forget of an unknown/already-removed Theater as success (idempotent DELETE)", async () => {
    const fixture = await startFixture();

    const forget = await fetch(`${fixture.endpoint}observer/theaters/deadbeefdead`, { method: "DELETE" });
    expect(forget.status).toBe(200);
    expect(await forget.json()).toEqual({ ok: true });
  });
});

async function startFixture(options: {
  readonly agentRuntime?: ConsoleServerDeps["agentRuntime"];
  readonly beforeCreateServer?: (paths: { readonly carrierStoreDir: string }) => void;
  readonly terminalLaunch?: ConsoleServerDeps["terminalLaunch"];
  readonly terminalLaunchResolverDeps?: ConsoleServerDeps["terminalLaunchResolverDeps"];
  readonly terminalStartShell?: ConsoleServerDeps["terminalStartShell"];
  readonly updateCheck?: ConsoleServerDeps["updateCheck"];
} = {}): Promise<ServerFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-server-"));
  const carrierStoreDir = path.join(dir, "fleet-home");
  initStore(carrierStoreDir);
  options.beforeCreateServer?.({ carrierStoreDir });
  tempDirs.push(dir);
  const lockFile = path.join(dir, "console.lock");
  const server = createConsoleServer({
    port: 0,
    version: "test",
    agentRuntime: options.agentRuntime,
    dataDir: carrierStoreDir,
    terminalLaunch: options.terminalLaunch,
    terminalLaunchResolverDeps: options.terminalLaunchResolverDeps,
    terminalStartShell: options.terminalStartShell,
    updateCheck: options.updateCheck,
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile });
  const lock = createConsoleLock().readLock(lockFile)!;
  return { dir, carrierStoreDir, lockFile, server, endpoint, lock };
}

async function createTerminalSession(fixture: ServerFixture, headers: Record<string, string>, cwd: string): Promise<{ readonly sessionId: string }> {
  const grant = await issueFolderGrant(fixture, cwd, headers);
  const created = await fetch(`${fixture.endpoint}terminal/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ folderGrantId: grant.folderGrantId }),
  });
  expect(created.status).toBe(200);
  return created.json() as Promise<{ readonly sessionId: string }>;
}

async function issueFolderGrant(fixture: ServerFixture, cwd: string, headers: Record<string, string> = { "Content-Type": "application/json" }): Promise<{ readonly folderGrantId: string }> {
  const response = await fetch(`${fixture.endpoint}terminal/folders/grants`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path: cwd }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ readonly folderGrantId: string }>;
}

async function createTheater(fixture: ServerFixture, cwd: string): Promise<{ readonly id: string }> {
  const grant = await issueFolderGrant(fixture, cwd);
  const response = await fetch(`${fixture.endpoint}observer/theaters`, {
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

async function createMockLaunch(cwd?: string, context?: { readonly sessionId?: string }): Promise<TerminalLaunchSpec> {
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
