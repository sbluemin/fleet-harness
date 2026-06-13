import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConsoleLockPayload } from "../src/api-types.js";
import { createConsoleLock } from "../src/lock.js";
import { createConsoleObservabilityStore } from "../src/observability-store.js";
import { createConsoleServer, type ConsoleServer, type ConsoleServerDeps } from "../src/server.js";
import type { TerminalLaunchSpec, TerminalPtyHandle } from "../src/terminal/types.js";
import { createTerminalUpgradeHandler } from "../src/terminal/ws-handler.js";

interface ServerFixture {
  readonly dir: string;
  readonly lockFile: string;
  readonly server: ConsoleServer;
  readonly endpoint: string;
  readonly lock: ConsoleLockPayload;
}

const tempDirs: string[] = [];
const servers: ConsoleServer[] = [];
let previousStaticIndex: string | null | undefined;

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  restoreStaticIndex();
});

describe("console register ingest", () => {
  it("returns the exact register response shape and keeps ingest token out of browser snapshots", async () => {
    const fixture = await startFixture();
    const registration = await registerCli(fixture);

    expect(Object.keys(registration).sort()).toEqual([
      "heartbeatIntervalMs",
      "ingestToken",
      "leaseTtlMs",
      "maxBatchEvents",
      "registrationId",
    ]);

    const workspaces = await getJson<{ tenants: readonly Record<string, unknown>[] }>(`${fixture.endpoint}observer/tenants`, fixture.lock.observerToken);
    expect(JSON.stringify(workspaces)).not.toContain(registration.ingestToken);
    expect(workspaces.tenants[0]).toMatchObject({ tenantId: "cli-a", tenantLabel: "Alpha", cwd: "/repo/a", status: "online" });
  });

  it("requires ingest auth, ignores duplicate seq, emits gap truncation, and assigns global observedId", async () => {
    const fixture = await startFixture();
    const first = await registerCli(fixture, { cliRunId: "cli-a", tenantLabel: "Alpha" });
    const second = await registerCli(fixture, { cliRunId: "cli-b", tenantLabel: "Beta" });

    const unauthorized = await fetch(`${fixture.endpoint}api/cli/events`, {
      method: "POST",
      body: JSON.stringify([]),
    });
    expect(unauthorized.status).toBe(401);

    await postEvents(fixture, first.ingestToken, [
      { cliRunId: "cli-a", seq: 1, at: "2026-06-13T00:00:00.000Z", event: { type: "track:text", jobId: "job-a", trackId: "t1", text: "a" } },
      { cliRunId: "cli-a", seq: 1, at: "2026-06-13T00:00:00.000Z", event: { type: "track:text", jobId: "job-a", trackId: "t1", text: "duplicate" } },
      { cliRunId: "cli-a", seq: 3, at: "2026-06-13T00:00:01.000Z", event: { type: "track:text", jobId: "job-a", trackId: "t1", text: "b" } },
    ]);
    await postEvents(fixture, second.ingestToken, [
      { cliRunId: "cli-b", seq: 1, at: "2026-06-13T00:00:02.000Z", event: { type: "track:text", jobId: "job-b", trackId: "t1", text: "c" } },
    ]);

    const jobs = await getJson<{ tenants: Array<{ readonly tenantId: string; readonly jobs: Array<{ readonly events: Array<{ readonly id: number; readonly type: string; readonly event: Record<string, unknown> }> }> }> }>(
      `${fixture.endpoint}observer/jobs`,
      fixture.lock.observerToken,
    );
    const alphaEvents = jobs.tenants.find((tenant) => tenant.tenantId === "cli-a")?.jobs[0]?.events ?? [];
    const betaEvents = jobs.tenants.find((tenant) => tenant.tenantId === "cli-b")?.jobs[0]?.events ?? [];

    expect(alphaEvents.map((event) => event.event.text).filter(Boolean)).toEqual(["a", "b"]);
    expect(alphaEvents.some((event) => event.type === "observer:truncated")).toBe(false);
    const snapshot = await getJson<{ tenants: Array<{ readonly tenantId: string; readonly jobs: Array<{ readonly events: Array<{ readonly id: number; readonly type: string }> }> }> }>(
      `${fixture.endpoint}observer/jobs?tenant=cli-a`,
      fixture.lock.observerToken,
    );
    const allAlphaIds = snapshot.tenants[0]?.jobs.flatMap((job) => job.events.map((event) => event.id)) ?? [];
    const stream = await readObserverChunk(fixture);
    expect(allAlphaIds).toEqual([1, 3]);
    expect(betaEvents[0]?.id).toBe(4);
    expect(stream).toContain("observer:truncated");
  });

  it("marks heartbeat-missed sessions offline without deleting history, then deregisters best-effort", () => {
    let now = 1_000;
    const store = createConsoleObservabilityStore({
      now: () => now,
      nowIso: () => new Date(now).toISOString(),
      randomToken: () => `token-${now}`,
      leaseTtlMs: 10,
    });
    const registration = store.register({ protocolVersion: "1", cliRunId: "cli-a", tenantLabel: "Alpha", cwd: "/repo/a", pid: 1, startedAt: "2026-06-13T00:00:00.000Z", fleetVersion: "test" });
    store.pushEvents(registration.ingestToken, [{ cliRunId: "cli-a", seq: 1, at: "2026-06-13T00:00:00.000Z", event: { type: "track:text", jobId: "job-a", text: "kept" } }]);

    now = 2_000;
    store.markExpiredSessions();

    expect(store.listWorkspaces()[0]?.status).toBe("offline");
    expect(store.listJobs("cli-a")[0]?.events).toHaveLength(1);
    expect(store.deregister(registration.ingestToken, "cli-a", registration.registrationId)).toBe(true);
    expect(store.listWorkspaces()[0]?.status).toBe("deregistered");
  });

  it("resolves terminal launch cwd from the selected registration", () => {
    const store = createConsoleObservabilityStore({ randomToken: () => "token" });
    const registration = store.register({ protocolVersion: "1", cliRunId: "cli-a", tenantLabel: "Alpha", cwd: "/repo/selected", pid: 1, startedAt: "2026-06-13T00:00:00.000Z", fleetVersion: "test" });

    expect(store.getLaunchCwd(registration.registrationId)).toBe("/repo/selected");
  });

  it("binds a pending terminal session by cliRunId and canonical cwd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-bind-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore({ randomToken: () => "token" });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: dir, createdAt: 1_000 });

    const registration = store.register({ protocolVersion: "1", cliRunId: "session-a", tenantLabel: "Alpha", cwd: dir, pid: 1, startedAt: "2026-06-13T00:00:00.000Z", fleetVersion: "test" });
    const workspace = store.listWorkspaces()[0];
    const session = store.listTerminalSessions()[0];

    expect(workspace).toMatchObject({ cliRunId: "session-a", registrationId: registration.registrationId, terminalSessionId: "session-a" });
    expect(session).toMatchObject({ sessionId: "session-a", status: "registered", registrationId: registration.registrationId, tenantId: "session-a" });
  });

  it("rejects pending terminal session binding when cliRunId matches but cwd does not", () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-bind-a-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-bind-b-"));
    tempDirs.push(first, second);
    const store = createConsoleObservabilityStore({ randomToken: () => "token" });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: first });

    expect(() => store.register({ protocolVersion: "1", cliRunId: "session-a", tenantLabel: "Alpha", cwd: second, pid: 1, startedAt: "2026-06-13T00:00:00.000Z", fleetVersion: "test" })).toThrow("cwd mismatch");
    expect(store.listWorkspaces()).toHaveLength(0);
    expect(store.listTerminalSessions()[0]).toMatchObject({ sessionId: "session-a", status: "starting" });
  });

  it("replays existing observer events over SSE resync", async () => {
    const fixture = await startFixture();
    const registration = await registerCli(fixture);
    await postEvents(fixture, registration.ingestToken, [
      { cliRunId: "cli-a", seq: 1, at: "2026-06-13T00:00:00.000Z", event: { type: "track:text", jobId: "job-a", trackId: "t1", text: "hello" } },
    ]);

    const controller = new AbortController();
    const response = await fetch(`${fixture.endpoint}observer/events`, {
      headers: { Authorization: `Bearer ${fixture.lock.observerToken}` },
      signal: controller.signal,
    });
    const chunk = new TextDecoder().decode((await response.body!.getReader().read()).value);
    controller.abort();

    expect(chunk).toContain("event: track:text");
    expect(chunk).toContain("\"id\":1");
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

  it("issues terminal tickets only for the browser terminal token and selects registration cwd internally", async () => {
    const launches: string[] = [];
    const fixture = await startFixture({
      terminalLaunch: (cwd) => {
        launches.push(cwd ?? "");
        return { bin: "mock", args: [], cwd: cwd ?? "/", env: { TERM: "xterm-256color" } };
      },
    });
    const registration = await registerCli(fixture, { cwd: "/repo/selected" });

    const missing = await fetch(`${fixture.endpoint}terminal/ticket`, { method: "POST" });
    const wrong = await fetch(`${fixture.endpoint}terminal/ticket`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    });
    const issued = await fetch(`${fixture.endpoint}terminal/ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.lock.terminalToken}` },
      body: JSON.stringify({ registrationId: registration.registrationId }),
    });
    const payload = await issued.json() as { readonly ticket?: unknown; readonly ttlMs?: unknown; readonly cwd?: unknown };

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(typeof payload.ticket).toBe("string");
    expect(payload.ttlMs).toBe(10_000);
    expect(payload.cwd).toBeUndefined();
    expect(launches).toEqual([]);
  });

  it("returns folder picker cancellation without creating a grant", async () => {
    const fixture = await startFixture({
      terminalPickFolder: async () => ({ kind: "cancelled" }),
    });

    const response = await fetch(`${fixture.endpoint}terminal/folders/pick`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.lock.terminalToken}` },
    });

    await expect(response.json()).resolves.toEqual({ cancelled: true });
  });

  it("rejects terminal routes when the browser Origin is not the console origin", async () => {
    const fixture = await startFixture({
      terminalPickFolder: async () => ({ kind: "cancelled" }),
    });

    const response = await fetch(`${fixture.endpoint}terminal/folders/pick`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.lock.terminalToken}`, origin: "http://evil.example" },
    });

    expect(response.status).toBe(401);
  });

  it("creates terminal sessions from one-use folder grants and rejects raw cwd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-session-"));
    tempDirs.push(dir);
    const launches: TerminalLaunchSpec[] = [];
    const fixture = await startFixture({
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
      terminalStartShell: (launch) => {
        launches.push(launch);
        return createMockPty();
      },
    });
    const headers = { Authorization: `Bearer ${fixture.lock.terminalToken}`, "Content-Type": "application/json" };

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

  it("rejects terminal WebSocket upgrades without a valid ticket boundary", () => {
    let destroyed = 0;
    const handler = createTerminalUpgradeHandler({
      expectedHost: "127.0.0.1",
      getExpectedPort: () => 37283,
      tickets: { consume: () => null },
      sessions: { canAttach: () => true, createSession: () => undefined, attach: () => undefined, stop: () => undefined },
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
        createSession: () => undefined,
        attach: () => undefined,
        stop: () => undefined,
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
  readonly terminalLaunch?: ConsoleServerDeps["terminalLaunch"];
  readonly terminalPickFolder?: ConsoleServerDeps["terminalPickFolder"];
  readonly terminalStartShell?: ConsoleServerDeps["terminalStartShell"];
} = {}): Promise<ServerFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-server-"));
  tempDirs.push(dir);
  const lockFile = path.join(dir, "console.lock");
  const server = createConsoleServer({ port: 0, version: "test", terminalLaunch: options.terminalLaunch, terminalPickFolder: options.terminalPickFolder, terminalStartShell: options.terminalStartShell });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile });
  const lock = createConsoleLock().readLock(lockFile)!;
  return { dir, lockFile, server, endpoint, lock };
}

async function registerCli(fixture: ServerFixture, overrides: Partial<{ readonly cliRunId: string; readonly tenantLabel: string; readonly cwd: string }> = {}) {
  const response = await fetch(`${fixture.endpoint}api/cli/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.lock.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "1",
      cliRunId: overrides.cliRunId ?? "cli-a",
      tenantLabel: overrides.tenantLabel ?? "Alpha",
      cwd: overrides.cwd ?? "/repo/a",
      pid: 123,
      startedAt: "2026-06-13T00:00:00.000Z",
      fleetVersion: "test",
      mcp: { servers: [{ name: "tools", toolCount: 2 }] },
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ readonly registrationId: string; readonly ingestToken: string; readonly heartbeatIntervalMs: number; readonly leaseTtlMs: number; readonly maxBatchEvents: number }>;
}

async function postEvents(fixture: ServerFixture, token: string, events: unknown[]) {
  const response = await fetch(`${fixture.endpoint}api/cli/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(events),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function readObserverChunk(fixture: ServerFixture): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(`${fixture.endpoint}observer/events`, {
    headers: { Authorization: `Bearer ${fixture.lock.observerToken}` },
    signal: controller.signal,
  });
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
