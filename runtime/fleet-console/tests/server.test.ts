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
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
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
    const session = await createTerminalSession(runtimeFixture, { "Content-Type": "application/json" });
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
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
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

    const picked = await fetch(`${fixture.endpoint}terminal/folders/pick`, { method: "POST", headers });
    const grant = await picked.json() as { readonly folderGrantId: string };
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
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
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
    const session = await createTerminalSession(fixture, { "Content-Type": "application/json" });
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
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
      terminalLaunch: async (cwd) => {
        launches.push(cwd ?? "");
        return { bin: "mock", args: [], cwd: cwd ?? "/", env: { TERM: "xterm-256color" } };
      },
      terminalStartShell: () => createMockPty(),
    });
    const session = await createTerminalSession(fixture, { "Content-Type": "application/json" });
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

  it("keeps MCP bearer tokens out of terminal tickets, observer snapshots, SSE frames, static HTML, and launch errors", async () => {
    const fakeToken = "mcp-token-seeded-secret";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-token-boundary-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
      terminalLaunch: async () => {
        throw new Error(fakeToken);
      },
    });
    ensureStaticIndex();
    const headers = { "Content-Type": "application/json" };

    const ticket = await (await fetch(`${fixture.endpoint}terminal/ticket`, { method: "POST", headers })).json();
    const picked = await fetch(`${fixture.endpoint}terminal/folders/pick`, { method: "POST", headers });
    const grant = await picked.json() as { readonly folderGrantId: string };
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
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
      terminalStartShell: () => createFakePty(),
    });
    const headers = { "Content-Type": "application/json" };

    const first = await createTerminalSession(fixture, headers);
    runtime.emit({ type: "track:text", jobId: "job-a", originSessionId: first.sessionId, trackId: "t1", text: "a", mcpToken: fakeToken });
    const second = await createTerminalSession(fixture, headers);
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
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
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
    const first = await createTerminalSession(fixture, headers);
    const second = await createTerminalSession(fixture, headers);

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
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
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
    const session = await createTerminalSession(fixture, { "Content-Type": "application/json" });

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

  it("returns folder picker cancellation without creating a grant", async () => {
    const fixture = await startFixture({
      terminalPickFolder: async () => ({ kind: "cancelled" }),
    });

    const response = await fetch(`${fixture.endpoint}terminal/folders/pick`, {
      method: "POST",
    });

    await expect(response.json()).resolves.toEqual({ cancelled: true });
  });

  it("rejects terminal routes when the browser Origin is not the console origin", async () => {
    const fixture = await startFixture({
      terminalPickFolder: async () => ({ kind: "cancelled" }),
    });

    const response = await fetch(`${fixture.endpoint}terminal/folders/pick`, {
      method: "POST",
      headers: { origin: "http://evil.example" },
    });

    expect(response.status).toBe(401);
  });

  it("creates terminal sessions from one-use folder grants and rejects raw cwd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-session-"));
    tempDirs.push(dir);
    const launches: TerminalLaunchSpec[] = [];
    const fixture = await startFixture({
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
      terminalLaunch: createMockLaunch,
      terminalStartShell: (launch) => {
        launches.push(launch);
        return createMockPty();
      },
    });
    const headers = { "Content-Type": "application/json" };

    const picked = await fetch(`${fixture.endpoint}terminal/folders/pick`, { method: "POST", headers });
    const grant = await picked.json() as { readonly folderGrantId: string };
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
    await expect(list.json()).resolves.toMatchObject({ sessions: [{ sessionId: session.sessionId, status: "terminal-only" }] });
  });

  it("registers wiki-less Theaters as the observer superset without browser tokens", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-theater-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
    });

    const created = await fetch(`${fixture.endpoint}observer/theaters`, { method: "POST" });
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
      { id: "claude", label: "Claude", renameCommand: "/rename" },
      { id: "claude-kimi", label: "Claude Kimi", renameCommand: "/rename" },
      { id: "codex", label: "Codex", renameCommand: "/rename" },
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
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
    });

    const created = await fetch(`${fixture.endpoint}observer/theaters`, { method: "POST" });
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
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
    });

    const created = await fetch(`${fixture.endpoint}observer/theaters`, { method: "POST" });
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

  it("handles Theater picker cancellation and errors", async () => {
    const cancelled = await startFixture({
      terminalPickFolder: async () => ({ kind: "cancelled" }),
    });
    const failed = await startFixture({
      terminalPickFolder: async () => ({ kind: "error", error: "invalid_folder" }),
    });

    await expect((await fetch(`${cancelled.endpoint}observer/theaters`, { method: "POST" })).json()).resolves.toEqual({ cancelled: true });
    const errorResponse = await fetch(`${failed.endpoint}observer/theaters`, { method: "POST" });
    await expect(errorResponse.json()).resolves.toEqual({ error: "invalid_folder" });
    expect(errorResponse.status).toBe(400);
  });

  it("launches Theater sessions from the registered path and rejects unknown Theater ids", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-theater-launch-"));
    tempDirs.push(dir);
    const launches: TerminalLaunchSpec[] = [];
    const cliIds: Array<string | undefined> = [];
    const fixture = await startFixture({
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
      terminalLaunch: async (cwd, context) => {
        cliIds.push(context?.cliId);
        return createMockLaunch(cwd, context);
      },
      terminalStartShell: (launch) => {
        launches.push(launch);
        return createMockPty();
      },
    });
    const theater = await (await fetch(`${fixture.endpoint}observer/theaters`, { method: "POST" })).json() as { readonly id: string };
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
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
      terminalLaunch: createMockLaunch,
      terminalStartShell: () => createMockPty(),
    });
    const headers = { "Content-Type": "application/json" };

    const picked = await fetch(`${fixture.endpoint}terminal/folders/pick`, { method: "POST", headers });
    const grant = await picked.json() as { readonly folderGrantId: string };
    const created = await fetch(`${fixture.endpoint}terminal/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ folderGrantId: grant.folderGrantId }),
    });
    const session = await created.json() as { readonly sessionId: string };
    const deleted = await fetch(`${fixture.endpoint}terminal/sessions/${encodeURIComponent(session.sessionId)}`, { method: "DELETE" });
    const afterList = await getJson<{ sessions: readonly unknown[] }>(`${fixture.endpoint}terminal/sessions`);
    // 이미 종료된 세션 재삭제도 200으로 멱등 처리한다.
    const repeat = await fetch(`${fixture.endpoint}terminal/sessions/${encodeURIComponent(session.sessionId)}`, { method: "DELETE" });

    expect(created.status).toBe(200);
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ ok: true });
    expect(afterList.sessions).toHaveLength(0);
    expect(repeat.status).toBe(200);
  });

  it("renames a terminal session over PATCH without exposing raw cwd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-session-rename-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
      terminalLaunch: createMockLaunch,
      terminalStartShell: () => createMockPty(),
    });
    const headers = { "Content-Type": "application/json" };

    const picked = await fetch(`${fixture.endpoint}terminal/folders/pick`, { method: "POST", headers });
    const grant = await picked.json() as { readonly folderGrantId: string };
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
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
      terminalLaunch: createMockLaunch,
      terminalStartShell: (launch) => {
        const pty = createRecordingPty();
        ptys.set(String(launch.env.FLEET_CONSOLE_SESSION_ID), pty);
        return pty;
      },
    });
    const headers = { "Content-Type": "application/json" };
    // Claude 계열은 rename 슬래시 명령 '/rename'을 지원하므로 주입 대상이다.
    const session = await createTerminalSession(fixture, headers, "claude");
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
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
      terminalLaunch: createMockLaunch,
      terminalStartShell: (launch) => {
        const pty = createRecordingPty();
        ptys.set(String(launch.env.FLEET_CONSOLE_SESSION_ID), pty);
        return pty;
      },
    });
    const headers = { "Content-Type": "application/json" };
    // cliId 없이 생성된 세션은 rename 지원 CLI를 특정할 수 없으므로 미지원 명령을 주입하지 않는다.
    const session = await createTerminalSession(fixture, headers);
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
      sessions: { canAttach: () => true, createSession: async () => undefined, attach: async () => undefined, getSessionMessagePolicy: () => undefined, terminate: () => false, stop: async () => undefined, writeToSession: () => false },
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

async function startFixture(options: {
  readonly agentRuntime?: ConsoleServerDeps["agentRuntime"];
  readonly beforeCreateServer?: (paths: { readonly carrierStoreDir: string }) => void;
  readonly terminalLaunch?: ConsoleServerDeps["terminalLaunch"];
  readonly terminalLaunchResolverDeps?: ConsoleServerDeps["terminalLaunchResolverDeps"];
  readonly terminalPickFolder?: ConsoleServerDeps["terminalPickFolder"];
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
    terminalPickFolder: options.terminalPickFolder,
    terminalStartShell: options.terminalStartShell,
    updateCheck: options.updateCheck,
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile });
  const lock = createConsoleLock().readLock(lockFile)!;
  return { dir, carrierStoreDir, lockFile, server, endpoint, lock };
}

async function createTerminalSession(fixture: ServerFixture, headers: Record<string, string>, cliId?: string): Promise<{ readonly sessionId: string }> {
  const picked = await fetch(`${fixture.endpoint}terminal/folders/pick`, { method: "POST", headers });
  const grant = await picked.json() as { readonly folderGrantId: string };
  const created = await fetch(`${fixture.endpoint}terminal/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ folderGrantId: grant.folderGrantId, ...(cliId ? { cliId } : {}) }),
  });
  expect(created.status).toBe(200);
  return created.json() as Promise<{ readonly sessionId: string }>;
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
