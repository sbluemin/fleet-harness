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

interface ServerFixture {
  readonly dir: string;
  readonly carrierStoreDir: string;
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
  resetStoreForTests();
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

    const workspaces = await getJson<{ tenants: readonly Record<string, unknown>[] }>(`${fixture.endpoint}observer/tenants`);
    expect(JSON.stringify(workspaces)).not.toContain(registration.ingestToken);
    expect(workspaces.tenants[0]).toMatchObject({ tenantId: "cli-a", tenantLabel: "Alpha", status: "online", theaterId: workspaceHash("/repo/a") });
    expect(workspaces.tenants[0]).not.toHaveProperty("cwd");
    expect(JSON.stringify(workspaces)).not.toContain("/repo/a");
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
    );
    const alphaEvents = jobs.tenants.find((tenant) => tenant.tenantId === "cli-a")?.jobs[0]?.events ?? [];
    const betaEvents = jobs.tenants.find((tenant) => tenant.tenantId === "cli-b")?.jobs[0]?.events ?? [];

    expect(alphaEvents.map((event) => event.event.text).filter(Boolean)).toEqual(["a", "b"]);
    expect(alphaEvents.some((event) => event.type === "observer:truncated")).toBe(false);
    const snapshot = await getJson<{ tenants: Array<{ readonly tenantId: string; readonly jobs: Array<{ readonly events: Array<{ readonly id: number; readonly type: string }> }> }> }>(
      `${fixture.endpoint}observer/jobs?tenant=cli-a`,
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
    expect(workspace?.theaterId).toBe(workspaceHash(fs.realpathSync.native(dir)));
    expect(session).toMatchObject({ sessionId: "session-a", status: "registered", registrationId: registration.registrationId, tenantId: "session-a", theaterId: workspaceHash(fs.realpathSync.native(dir)) });
  });

  it("numbers pending terminal sessions per Theater, isolating the #1 starting value", () => {
    const theaterA = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-seq-a-"));
    const theaterB = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-seq-b-"));
    tempDirs.push(theaterA, theaterB);
    const store = createConsoleObservabilityStore({ randomToken: () => "token" });

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
    const store = createConsoleObservabilityStore({ randomToken: () => "token" });
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
    const response = await fetch(`${fixture.endpoint}observer/events`, { signal: controller.signal });
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

  it("issues terminal tickets without browser tokens and selects registration cwd internally", async () => {
    const launches: string[] = [];
    const fixture = await startFixture({
      terminalLaunch: (cwd) => {
        launches.push(cwd ?? "");
        return { bin: "mock", args: [], cwd: cwd ?? "/", env: { TERM: "xterm-256color" } };
      },
    });
    const registration = await registerCli(fixture, { cwd: "/repo/selected" });

    const issued = await fetch(`${fixture.endpoint}terminal/ticket`, {
      method: "POST",
      body: JSON.stringify({ registrationId: registration.registrationId }),
    });
    const payload = await issued.json() as { readonly ticket?: unknown; readonly ttlMs?: unknown; readonly cwd?: unknown };

    expect(issued.status).toBe(200);
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
    const listed = await getJson<{ theaters: readonly Record<string, unknown>[] }>(`${fixture.endpoint}observer/theaters`);
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
    expect(payload).not.toHaveProperty("path");
    expect(listed.theaters[0]).not.toHaveProperty("path");
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain(fixture.lock.token);
    expect(serialized).not.toContain("ingestToken");
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
    const fixture = await startFixture();
    fs.writeFileSync(path.join(fixture.carrierStoreDir, "carriers.json"), JSON.stringify({
      carriers: {
        nimitz: { displayName: "Nimitz Persisted" },
      },
    }), "utf8");

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
      const observability = createConsoleObservabilityStore({ randomToken: () => "token" });
      const theater = await theaters.register(variantDir);
      const codexWorkspace = await codexWorkspaces.register(variantDir);
      observability.register({ protocolVersion: "1", cliRunId: "cli-a", tenantLabel: "Alpha", cwd: variantDir, pid: 1, startedAt: "2026-06-13T00:00:00.000Z", fleetVersion: "test" });
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
    const fixture = await startFixture({
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
      terminalStartShell: (launch) => {
        launches.push(launch);
        return createMockPty();
      },
    });
    const theater = await (await fetch(`${fixture.endpoint}observer/theaters`, { method: "POST" })).json() as { readonly id: string };
    const unknown = await fetch(`${fixture.endpoint}observer/theaters/missing/sessions`, { method: "POST", body: JSON.stringify({ cwd: "/tmp/other" }) });
    const created = await fetch(`${fixture.endpoint}observer/theaters/${encodeURIComponent(theater.id)}/sessions`, { method: "POST", body: JSON.stringify({ cwd: "/tmp/ignored" }) });
    const session = await created.json() as { readonly sessionId: string; readonly theaterId: string; readonly cwd?: unknown };
    const sessions = await getJson<{ sessions: ReadonlyArray<{ readonly theaterId: string; readonly cwd?: unknown }> }>(`${fixture.endpoint}terminal/sessions`);
    const serialized = JSON.stringify({ session, sessions });

    expect(unknown.status).toBe(404);
    expect(created.status).toBe(200);
    expect(session).toMatchObject({ theaterId: theater.id });
    expect(session.cwd).toBeUndefined();
    expect(sessions.sessions[0]).not.toHaveProperty("cwd");
    expect(serialized).not.toContain(dir);
    expect(launches[0]?.cwd).toBe(dir);
    expect(sessions.sessions[0]?.theaterId).toBe(theater.id);
  });

  it("terminates a terminal session over DELETE and drops it from the session list", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-session-delete-"));
    tempDirs.push(dir);
    const fixture = await startFixture({
      terminalPickFolder: async () => ({ kind: "selected", cwd: dir }),
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

  it("rejects terminal WebSocket upgrades without a valid ticket boundary", () => {
    let destroyed = 0;
    const handler = createTerminalUpgradeHandler({
      expectedHost: "127.0.0.1",
      getExpectedPort: () => 37283,
      tickets: { consume: () => null },
      sessions: { canAttach: () => true, createSession: () => undefined, attach: () => undefined, terminate: () => false, stop: () => undefined },
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
        terminate: () => false,
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
  readonly updateCheck?: ConsoleServerDeps["updateCheck"];
} = {}): Promise<ServerFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-server-"));
  const carrierStoreDir = path.join(dir, "fleet-home");
  initStore(carrierStoreDir);
  tempDirs.push(dir);
  const lockFile = path.join(dir, "console.lock");
  const server = createConsoleServer({
    port: 0,
    version: "test",
    terminalLaunch: options.terminalLaunch,
    terminalPickFolder: options.terminalPickFolder,
    terminalStartShell: options.terminalStartShell,
    updateCheck: options.updateCheck,
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile });
  const lock = createConsoleLock().readLock(lockFile)!;
  return { dir, carrierStoreDir, lockFile, server, endpoint, lock };
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
