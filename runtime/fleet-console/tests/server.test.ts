import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { deliverConsoleStop, readConsoleLockFile } from "@fleet-console/lifecycle";
import { CONSOLE_STOP_REQUEST_REVISION } from "@fleet-console/protocol/lifecycle";
import type { ConsoleLockPayload } from "../core/host/transport/console-contract-types.js";
import { DESKTOP_THEME_EVENTS_PATH, DESKTOP_THEME_PATH } from "../core/host/shell/desktop-contract.js";
import { DESKTOP_RESOURCE_ROOT_MARKER, formatDesktopResourceRootMarker } from "@fleet-console/protocol/desktop";
import { deriveObjectiveLabel } from "../features/execution/host/agent/auto-name.js";
import { createConsoleObservabilityStore } from "../features/execution/host/agent/observability-store.js";
import { retireConsoleData } from "../core/host/bootstrap/retired-data.js";
import { createDurableJsonStore } from "@fleet-console/infra";
import { createCommodoreEntities } from "../features/commodore/host/entities.js";
import { createObjectiveStorage } from "../features/objectives/host/storage.js";
import type { ObjectiveRecord } from "../features/objectives/host/records/objective-records-domain.js";
import { STATE_VERSION, sanitizeDurableConsoleState, type DurableConsoleState } from "../features/workspace/host/durable-state.js";
import { createQuotaSettingsStore } from "../features/quota/host/storage.js";
import { createAgentCliPathStore } from "../features/execution/host/agent/agent-cli-paths.js";
import { createConsoleServeLifecycle } from "../core/host/bootstrap/serve-lifecycle.js";
import { createConsoleServer, SERVER_API_CATALOG, type ConsoleServer, type ConsoleServerDeps } from "../core/host/bootstrap/server.js";
import type { AgentCliDetector } from "../features/execution/host/agent/agent-cli-detect.js";
import { canonicalizeTheaterPathSync, workspaceHash } from "../features/workspace/host/theaters/theater-domain.js";
import { TheaterRegistry } from "../features/workspace/host/theaters/theater-domain.js";
import { isClaudePathTrusted, trustClaudeTheater } from "../features/workspace/host/theaters/claude-trust.js";
import { WorkspaceRegistry } from "../features/codex/host/codex/workspaces.js";
import type { TerminalLaunchContext, TerminalLaunchSpec, TerminalPtyHandle } from "../features/execution/host/terminal/terminal-types.js";
import { createPluginTerminalUpgradeHandler } from "../features/execution/host/terminal/ws.js";

const fleetAdmiralMock = vi.hoisted(() => ({
  agentRuntimeQueue: [] as unknown[],
  startupGate: null as null | (() => Promise<void>),
  cleanupHooks: new Map<string, () => void | Promise<void>>(),
  resolveProfile: null as null | ((...args: readonly unknown[]) => unknown),
}));

vi.mock("@fleet-console/agent-runtime/fleet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fleet-console/agent-runtime/fleet")>();
  return {
    ...actual,
    createFleetGatewayAgentRuntimeLifecycle: (deps: Parameters<typeof actual.createFleetGatewayAgentRuntimeLifecycle>[0]) =>
      fleetAdmiralMock.agentRuntimeQueue.shift() ?? actual.createFleetGatewayAgentRuntimeLifecycle(deps),
    resolveAgentCliProfile: (...args: Parameters<typeof actual.resolveAgentCliProfile>) =>
      fleetAdmiralMock.resolveProfile?.(...args) ?? actual.resolveAgentCliProfile(...args),
  };
});

vi.mock("../features/codex/host/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features/codex/host/index.js")>();
  return { ...actual, createCodexFeature: async (deps: Parameters<typeof actual.createCodexFeature>[0]) => {
    await fleetAdmiralMock.startupGate?.();
    const feature = await actual.createCodexFeature(deps);
    return { ...feature, dispose: () => {
      let pending: void | Promise<void>;
      try { pending = fleetAdmiralMock.cleanupHooks.get("codex")?.(); }
      catch (error) { void feature.dispose(); throw error; }
      return Promise.resolve(pending).then(() => feature.dispose());
    } };
  } };
});

vi.mock("../features/file-explorer/host/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features/file-explorer/host/index.js")>();
  return { ...actual, createFileExplorerFeature: (deps: Parameters<typeof actual.createFileExplorerFeature>[0]) => {

    const feature = actual.createFileExplorerFeature(deps);
    return { ...feature, dispose: () => {
      let pending: void | Promise<void>;
      try { pending = fleetAdmiralMock.cleanupHooks.get("file-explorer")?.(); }
      catch (error) { void feature.dispose(); throw error; }
      return Promise.resolve(pending).then(() => feature.dispose());
    } };
  } };
});

vi.mock("../features/repository/host/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features/repository/host/index.js")>();
  return { ...actual, createRepositoryFeature: (deps: Parameters<typeof actual.createRepositoryFeature>[0]) => {

    const feature = actual.createRepositoryFeature(deps);
    return { ...feature, dispose: () => {
      let pending: void | Promise<void>;
      try { pending = fleetAdmiralMock.cleanupHooks.get("repository")?.(); }
      catch (error) { void feature.dispose(); throw error; }
      return Promise.resolve(pending).then(() => feature.dispose());
    } };
  } };
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

// Process lifecycle known-defect ratchet, shared with tests/built/fleet-built-smoke.test.ts (which explains it): a listed case
// asserts its defect's signature until the fix removes the entry. FLEET_LIFECYCLE_RATCHET=off asserts every invariant.
const LIFECYCLE_KNOWN_DEFECTS = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/lifecycle-known-defects.json", import.meta.url)), "utf8")) as ReadonlyArray<{ readonly case: string; readonly followup: string; readonly releasedBy: string }>;

function lifecycleCheck(caseId: string, holds: boolean, invariant: string): void {
  const known = LIFECYCLE_KNOWN_DEFECTS.find((entry) => entry.case === caseId);
  if (known && process.env.FLEET_LIFECYCLE_RATCHET !== "off") {
    expect.soft(holds, `known defect ${known.followup} (${caseId}) no longer reproduces: "${invariant}" holds; ${known.releasedBy} removes its entry from lifecycle-known-defects.json`).toBe(false);
  } else {
    expect.soft(holds, `${caseId}${known ? ` (${known.followup})` : ""}: ${invariant}`).toBe(true);
  }
}

const tempDirs: string[] = [];
const servers: ConsoleServer[] = [];
let previousStaticIndex: string | null | undefined;
const CONSOLE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  fleetAdmiralMock.startupGate = null;
  fleetAdmiralMock.cleanupHooks.clear();
  for (const server of servers.splice(0)) await server.stop();
  fleetAdmiralMock.agentRuntimeQueue.length = 0;
  fleetAdmiralMock.resolveProfile = null;
  delete (globalThis as { __fleetTerminalLaunch?: unknown }).__fleetTerminalLaunch;
  delete (globalThis as { __fleetTerminalStartShell?: unknown }).__fleetTerminalStartShell;
  delete (globalThis as { __fleetAgentCliDetector?: unknown }).__fleetAgentCliDetector;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  restoreStaticIndex();
});

describe("console terminal observability", () => {

  it("reports the Objective browser as unavailable without an attached Desktop", async () => {
    const fixture = await startFixture({ release: { channel: "local", version: "test", packageRoot: CONSOLE_PACKAGE_ROOT } });

    // Objective 브라우저는 Desktop 앱의 것이다 — 창을 든 Desktop 이 붙어 있지 않으면 열리지 않고, 그 까닭을 말한다.
    const status = await fetch(new URL("api/v1/browser", fixture.endpoint));
    expect(await status.json()).toMatchObject({ available: false, reason: "desktop_required" });
  });

  it("injects dormant durable objectives without exposing server-only provider data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-dormant-store-"));
    tempDirs.push(dir);
    const store = createConsoleObservabilityStore();

    const session = store.injectDormantObjective({
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

  it("owns the lock before shared-state startup and admits requests only after activation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-startup-owner-"));
    tempDirs.push(dir);
    const fleetDataDir = path.join(dir, "fleet-home");
    const consoleDir = path.join(fleetDataDir, "console");
    const lockFile = path.join(dir, "console.lock");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    fleetAdmiralMock.startupGate = async () => { entered.resolve(); await release.promise; };
    const deps = { port: 0, dataDir: fleetDataDir, release: { channel: "local" as const, version: "test", packageRoot: CONSOLE_PACKAGE_ROOT } };
    // 바로 앞 위치의 사용자 설정을 먼저 옮기고 옛 트리 전체를 걷는다. 사용자 스킬은 경계 밖이다.
    const retiredData = path.join(consoleDir, "plugins");
    const retiredFile = path.join(retiredData, "skills", "cli", "node_modules", "skills", "package.json");
    const siblingFile = path.join(consoleDir, "plugins", "scuttlebutt", "workspace", "keep.txt");
    const userSkill = path.join(dir, ".claude", "skills", "mine", "SKILL.md");
    for (const file of [retiredFile, siblingFile, userSkill]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "keep");
    }
    const quotaSource = path.join(retiredData, "quota", "settings.json");
    const cliSource = path.join(retiredData, "terminal", "agent-cli-paths.json");
    for (const file of [quotaSource, cliSource]) fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(quotaSource, JSON.stringify({ claudeConnected: true, cursorConnected: true, providerOrder: ["cursor"] }));
    const cliPaths = { version: 1, paths: { claude: path.join(dir, "custom-claude") } };
    fs.writeFileSync(cliSource, JSON.stringify(cliPaths));
    fs.writeFileSync(path.join(consoleDir, "settings.json"), JSON.stringify({ version: 1, plugins: {
      quota: { toolbarProviders: ["claude"] }, scuttlebutt: { tori: true, grants: { tori: { consoleUse: true } } }, terminal: { chatReadingWidth: "wide" },
    } }));
    const winner = createConsoleServer(deps);
    servers.push(winner);
    const starting = winner.start({ dir, lockFile });
    void starting.catch(() => {});
    try {
      await entered.promise;
      expect(fs.existsSync(retiredData)).toBe(false);
      expect(fs.existsSync(siblingFile)).toBe(false);
      await expect(createQuotaSettingsStore(consoleDir).read()).resolves.toEqual({ claudeConnected: true });
      await expect(createAgentCliPathStore(consoleDir).read()).resolves.toEqual(cliPaths);
      const migratedSettings = JSON.parse(fs.readFileSync(path.join(consoleDir, "settings.json"), "utf8"));
      expect(migratedSettings).toMatchObject({ quota: { toolbarProviders: ["claude"] }, scuttlebutt: { tori: true, grants: { tori: { consoleUse: true } } }, execution: { chatReadingWidth: "wide" } });
      expect(migratedSettings).not.toHaveProperty("plugins");
      expect(fs.readFileSync(userSkill, "utf8")).toBe("keep");
      const owner = readConsoleLockFile(lockFile)!;
      const lockBefore = fs.readFileSync(lockFile, "utf8");
      const healthUrl = new URL("api/v1/health", owner.endpoint);
      const healthHeaders = { Authorization: `Bearer ${owner.token}` };
      const health = await fetch(healthUrl, { headers: healthHeaders });
      expect(health.status).toBe(503);
      await expect(health.json()).resolves.toEqual({ error: "console_starting", pid: owner.pid, stopRequest: 1 });
      expect((await fetch(healthUrl)).status).toBe(401);
      expect((await fetch(new URL("api/v1/theaters", owner.endpoint), { method: "POST", body: "{}" })).status).toBe(503);

      // 승자가 소비한 seed를 다시 두어, 패자 constructor와 start의 공유 쓰기를 함께 잡는다.
      const settingsFile = path.join(consoleDir, "settings.json");
      const stateFile = path.join(consoleDir, "state.json");
      const settings = JSON.stringify({ version: 1, general: {}, plugins: { terminal: {} } });
      const state = JSON.stringify({ version: 5, theaters: [], objectiveRecords: [] });
      fs.writeFileSync(settingsFile, settings);
      fs.writeFileSync(stateFile, state);
      fs.mkdirSync(path.join(fleetDataDir, "workspaces", "probe"), { recursive: true });
      fs.mkdirSync(path.join(fleetDataDir, "harness"), { recursive: true });
      const legacyFile = path.join(fleetDataDir, "harness", "probe.txt");
      fs.writeFileSync(legacyFile, "keep");
      fs.mkdirSync(path.dirname(retiredFile), { recursive: true });
      fs.writeFileSync(retiredFile, "keep");
      const loser = createConsoleServer(deps);
      servers.push(loser);
      await expect(loser.start({ dir, lockFile })).rejects.toMatchObject({ consoleLockHeld: true });
      await loser.stop();
      expect(fs.readFileSync(settingsFile, "utf8")).toBe(settings);
      expect(fs.readFileSync(stateFile, "utf8")).toBe(state);
      expect(fs.existsSync(`${stateFile}.pre-archive-backup`)).toBe(false);
      expect(fs.readFileSync(legacyFile, "utf8")).toBe("keep");
      expect(fs.readFileSync(retiredFile, "utf8")).toBe("keep");
      expect(fs.existsSync(path.join(fleetDataDir, "workspaces", "probe"))).toBe(true);
      expect(fs.readFileSync(lockFile, "utf8")).toBe(lockBefore);
      release.resolve();
      expect(await starting).toBe(owner.endpoint);
      expect((await fetch(healthUrl, { headers: healthHeaders })).status).toBe(200);
    } finally {
      release.resolve();
      await starting.catch(() => {});
      fleetAdmiralMock.startupGate = null;
    }
  });

  it("migrates independent sources while retaining a failed source for retry", async () => {
    // 회수 전에 읽지 못한 값은 기본값 저장으로도 고아가 되면 안 된다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-retire-retry-"));
    tempDirs.push(dir);
    const old = path.join(dir, "plugins");
    const quota = path.join(old, "quota", "settings.json");
    const cli = path.join(old, "terminal", "agent-cli-paths.json");
    fs.mkdirSync(path.dirname(quota), { recursive: true });
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(quota, "{broken");
    fs.writeFileSync(cli, JSON.stringify({ version: 1, paths: { claude: "/previous/claude" } }));
    const warn = vi.fn();
    let ready = retireConsoleData(dir, warn);
    const store = createQuotaSettingsStore(dir, () => ready);
    expect(ready).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(fs.readFileSync(quota, "utf8")).toBe("{broken");
    await expect(createAgentCliPathStore(dir).read()).resolves.toEqual({ version: 1, paths: { claude: "/previous/claude" } });
    expect(fs.existsSync(cli)).toBe(true);
    await expect(store.write({ claudeConnected: false })).rejects.toThrow("quota_migration_pending");
    expect(fs.existsSync(path.join(dir, "quota.json"))).toBe(false);
    fs.writeFileSync(quota, JSON.stringify({ claudeConnected: true }));
    // 목적지가 파일이 아니어서 저장할 수 없어도 같은 원본 보존 경계다.
    fs.mkdirSync(path.join(dir, "quota.json"));
    expect(retireConsoleData(dir, warn)).toBe(false);
    fs.rmdirSync(path.join(dir, "quota.json"));
    expect(fs.existsSync(cli)).toBe(true);
    fs.writeFileSync(path.join(dir, "quota.json"), JSON.stringify({ claudeConnected: false }));
    ready = retireConsoleData(dir, warn);
    expect(ready).toBe(true);
    await expect(store.read()).resolves.toEqual({ claudeConnected: false });
    await expect(createAgentCliPathStore(dir).read()).resolves.toEqual({ version: 1, paths: { claude: "/previous/claude" } });
    expect(fs.existsSync(old)).toBe(false);
    expect(retireConsoleData(dir, warn)).toBe(true);
  });

  it("never follows retired-data symlinks during carry-over or reclamation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-retire-links-"));
    tempDirs.push(dir);
    const outside = path.join(dir, "outside");
    const data = path.join(dir, "console");
    const old = path.join(data, "plugins");
    fs.mkdirSync(outside);
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(outside, "settings.json"), JSON.stringify({ claudeConnected: true }));
    fs.symlinkSync(outside, old, "dir");
    expect(retireConsoleData(data)).toBe(true);
    expect(fs.lstatSync(old).isSymbolicLink()).toBe(true);
    fs.unlinkSync(old);
    fs.mkdirSync(old);
    fs.symlinkSync(outside, path.join(old, "quota"), "dir");
    expect(retireConsoleData(data, () => {})).toBe(false);
    expect(fs.existsSync(path.join(data, "quota.json"))).toBe(false);
    fs.unlinkSync(path.join(old, "quota"));
    fs.symlinkSync(outside, path.join(old, "retired"), "dir");
    expect(retireConsoleData(data)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "settings.json"), "utf8")).toContain("claudeConnected");
  });

  it("starts on a fresh dynamic port when the update resume port is already taken", async () => {
    // 업데이트 워커는 옛 포트를 넘겨 새 콘솔을 띄운다. 그 포트를 누가 쥐고 있어도 콘솔은 떠야 하고,
    // 사용자는 포트를 요청한 적이 없으므로 설정 화면에는 동적 모드로 보고된다.
    const holder = http.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const heldPort = (holder.address() as { port: number }).port;
    process.env.FLEET_CONSOLE_RESUME_PORT = String(heldPort);
    try {
      const fixture = await startFixture();
      const status = await getJson<Record<string, unknown>>(`${fixture.endpoint}api/v1/status`);

      expect(new URL(fixture.endpoint).port).not.toBe(String(heldPort));
      expect(status).toMatchObject({ portMode: "dynamic", requestedPort: null, portHonored: true, effectivePort: fixture.lock.port });
    } finally {
      delete process.env.FLEET_CONSOLE_RESUME_PORT;
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  // L7, 3b17763a and N3: every stop request shares the one shutdown. An accepted in-place update stops the Console from inside,
  // and the SIGTERM the update worker sends then ends in this same call: neither may report the Console stopped, nor may the
  // lock go, while that shutdown's cleanup still runs. Two orders: the second request arrives once the cleanup is running
  // (3b17763a), or in the same tick as the first (N3), when the second request overtakes the first into the cleanup.
  // N2 (POSIX): the update's own stop is the stop request that arms serve's deadline, before any worker signal arrives.
  it("finishes every overlapping stop request only after the one shutdown has ended", async () => {
    const slowCleanup = (lockFile: string) => {
      const state = { entered: false, finished: false, lockHeldAtEnd: false };
      fleetAdmiralMock.cleanupHooks.set("codex", async () => {
        state.entered = true;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        state.lockHeldAtEnd = fs.existsSync(lockFile);
        state.finished = true;
      });
      return state;
    };
    try {
      const stopRequests: string[] = [];
      const update = await startFixture({
        lifecycle: createConsoleServeLifecycle({ onStopRequested: (reason) => stopRequests.push(reason) }),
        release: { packageRoot: CONSOLE_PACKAGE_ROOT, channel: "stable", version: "1.0.0" },
        updateCheck: {
          getStatus: () => ({ updateAvailable: true, latestVersion: "9.9.9" }),
          refresh: async () => ({ updateAvailable: true, latestVersion: "9.9.9" }),
          latestRelease: () => ({ version: "9.9.9" }) as never,
        },
        updateApply: { start: async () => ({ accepted: true, commit: async () => {}, abort: async () => {}, cancelled: new Promise<void>(() => {}) }) },
      });
      const afterCleanupStarted = slowCleanup(update.lockFile);
      const origin = new URL(update.endpoint).origin;
      expect((await fetch(new URL("api/v1/updates/apply", update.endpoint), { method: "POST", headers: { Origin: origin } })).status).toBe(202);
      await vi.waitFor(() => expect(afterCleanupStarted.entered).toBe(true), { timeout: 10_000 });
      lifecycleCheck("L7", stopRequests.join() === "update", "the update's own stop arms the shutdown deadline as the stop request");
      await update.server.stop();
      lifecycleCheck("L7", stopRequests.join() === "update", "a later stop request joins the update's shutdown instead of starting another");
      lifecycleCheck("L7", afterCleanupStarted.finished, "a stop requested during the update's own shutdown returns only after its cleanup");
      lifecycleCheck("L7", !fs.existsSync(update.lockFile), "a stop requested during the update's own shutdown returns only after the lock is released");
      await vi.waitFor(() => expect(afterCleanupStarted.finished).toBe(true), { timeout: 10_000 });

      const fixture = await startFixture();
      const sameTick = slowCleanup(fixture.lockFile);
      const returned: Array<{ readonly cleanupFinished: boolean }> = [];
      const first = fixture.server.stop().then(() => { returned.push({ cleanupFinished: sameTick.finished }); });
      const second = fixture.server.stop().then(() => { returned.push({ cleanupFinished: sameTick.finished }); });
      await Promise.all([first, second]);
      expect(sameTick.entered).toBe(true);
      lifecycleCheck("L7-N3", sameTick.lockHeldAtEnd, "the lock is held until the shutdown's cleanup has finished");
      lifecycleCheck("L7-N3", returned.every((entry) => entry.cleanupFinished), "no overlapping stop returns before the shutdown's cleanup has finished");
    } finally {
      fleetAdmiralMock.cleanupHooks.clear();
    }
  });

  // A feature cleanup may throw synchronously; other features and the lock must still be cleaned up.
  it("runs every feature cleanup and releases the lock when one cleanup throws synchronously", async () => {
    const runs: string[] = [];
    const fixture = await startFixture();
    fleetAdmiralMock.cleanupHooks.set("codex", () => { runs.push("before"); });
    fleetAdmiralMock.cleanupHooks.set("file-explorer", () => { runs.push("throws"); throw new Error("sync cleanup failure"); });
    fleetAdmiralMock.cleanupHooks.set("repository", async () => { runs.push("after"); });
    const warn = vi.spyOn(console, "warn");
    try {
      const stopError = await fixture.server.stop().then(() => null, (error: unknown) => error);
      expect.soft(stopError).toBeNull();
      expect.soft([...runs].sort()).toEqual(["after", "before", "throws"]);
      expect.soft(fs.existsSync(fixture.lockFile)).toBe(false);
      expect.soft(warn.mock.calls.filter(([message]) => typeof message === "string" && message.startsWith("[fleet-console] Feature cleanup failed:"))).toHaveLength(1);
    } finally { warn.mockRestore(); fleetAdmiralMock.cleanupHooks.clear(); }
  });

  // N9-W2: the token-authenticated stop request. Rejections never touch the shutdown, an accepted request runs the one
  // shutdown once, and a repeat joins it instead of starting another.
  it("accepts one token-authenticated stop request and joins later stops into the same shutdown", async () => {
    const stopRequests: string[] = [];
    const fixture = await startFixture({
      lifecycle: createConsoleServeLifecycle({ onStopRequested: (reason) => stopRequests.push(reason) }),
    });
    const stopUrl = new URL("api/v1/lifecycle/stop", fixture.endpoint);
    const auth = { Authorization: `Bearer ${fixture.lock.token}` };
    const origin = new URL(fixture.endpoint).origin;

    const health = await (await fetch(new URL("api/v1/health", fixture.endpoint), { headers: auth })).json() as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, pid: fixture.lock.pid, lifecycleWire: 1, stopRequest: 1 });

    // The gates reject without touching the shutdown: no token, a wrong token, a browser Origin, a non-POST.
    expect((await fetch(stopUrl, { method: "POST" })).status).toBe(401);
    expect((await fetch(stopUrl, { method: "POST", headers: { Authorization: "Bearer wrong-token" } })).status).toBe(401);
    expect((await fetch(stopUrl, { method: "POST", headers: { ...auth, Origin: origin } })).status).toBe(403);
    expect((await fetch(stopUrl, { headers: auth })).status).toBe(405);
    expect(stopRequests).toEqual([]);
    expect((await fetch(new URL("api/v1/health", fixture.endpoint), { headers: auth })).status).toBe(200);

    // The token-authenticated request is accepted once and runs the one shutdown.
    const accepted = await fetch(stopUrl, { method: "POST", headers: auth });
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({ accepted: true, pid: fixture.lock.pid });
    await vi.waitFor(() => expect(stopRequests).toEqual(["request"]), { timeout: 10_000 });
    // Duplicates while the shutdown runs never start another: the closing listener refuses them or answers 401
    // without a lock to authorize against, and the shutdown stays one.
    const duplicates = await Promise.all(
      [0, 1].map(() => fetch(stopUrl, { method: "POST", headers: auth }).then(
        (response) => response.status,
        () => "connection-closed",
      )),
    );
    for (const status of duplicates) expect([401, "connection-closed"]).toContain(status);
    await fixture.server.stop();
    lifecycleCheck("L7", stopRequests.join() === "request", "a later stop request joins the stop request's shutdown instead of starting another");
    lifecycleCheck("L7", !fs.existsSync(fixture.lockFile), "a stop requested during the stop request's shutdown returns only after the lock is released");
  }, 20_000);

  // N9-W2 DR-5: the same gates hold while starting, and an accepted request shuts down after startup settles.
  it("holds the stop request gates while starting and shuts down after startup settles", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-stop-starting-"));
    tempDirs.push(dir);
    const fleetDataDir = path.join(dir, "fleet-home");
    const lockFile = path.join(dir, "console.lock");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    fleetAdmiralMock.startupGate = async () => { entered.resolve(); await release.promise; };
    const stopRequests: string[] = [];
    const server = createConsoleServer({
      port: 0,
      dataDir: fleetDataDir,
      release: { channel: "local", version: "test", packageRoot: CONSOLE_PACKAGE_ROOT },
      lifecycle: createConsoleServeLifecycle({ onStopRequested: (reason) => stopRequests.push(reason) }),
    });
    servers.push(server);
    const starting = server.start({ dir, lockFile });
    void starting.catch(() => {});
    try {
      await entered.promise;
      const owner = readConsoleLockFile(lockFile)!;
      const stopUrl = new URL("api/v1/lifecycle/stop", owner.endpoint);
      const auth = { Authorization: `Bearer ${owner.token}` };
      const origin = new URL(owner.endpoint).origin;

      expect((await fetch(stopUrl, { method: "POST" })).status).toBe(401);
      expect((await fetch(stopUrl, { method: "POST", headers: { Authorization: "Bearer wrong-token" } })).status).toBe(401);
      expect((await fetch(stopUrl, { method: "POST", headers: { ...auth, Origin: origin } })).status).toBe(403);
      expect((await fetch(stopUrl, { headers: auth })).status).toBe(405);
      expect(stopRequests).toEqual([]);

      const accepted = await fetch(stopUrl, { method: "POST", headers: auth });
      expect(accepted.status).toBe(202);
      await expect(accepted.json()).resolves.toEqual({ accepted: true, pid: owner.pid });
      await vi.waitFor(() => expect(stopRequests).toEqual(["request"]), { timeout: 10_000 });
      // The shutdown waits for startup to settle: the lock stays until the cleanup ends.
      expect(fs.existsSync(lockFile)).toBe(true);
      release.resolve();
      await starting;
      await vi.waitFor(() => expect(fs.existsSync(lockFile)).toBe(false), { timeout: 10_000 });
      await server.stop();
      lifecycleCheck("L7", stopRequests.join() === "request", "a stop requested while starting joins the same shutdown instead of starting another");
    } finally {
      release.resolve();
      await starting.catch(() => {});
      fleetAdmiralMock.startupGate = null;
    }
  }, 30_000);

  // P1 (Codex review): another actor may start the shutdown first — the server nulls the lock before it closes the
  // listener, so the same request then answers 401. The client re-observes instead of signalling the Console that is
  // already cleaning up: only a Console still serving under the same lock falls back to a signal.
  it("waits instead of signalling when a stop request meets a Console already shutting down", async () => {
    const unauthorized = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    const route = await deliverConsoleStop({
      lock: { pid: 4242, endpoint: "http://127.0.0.1:1/", token: "rejected-token" },
      stopRequest: CONSOLE_STOP_REQUEST_REVISION,
      platform: "win32",
      fetch: unauthorized as typeof fetch,
      observe: async () => "stopping" as const,
    });
    expect(route).toBe("delivered");
  });

});

describe("console static and terminal ticket boundary", () => {

  it("redirects the admitted root entry to the console document", async () => {
    const fixture = await startFixture();
    ensureStaticIndex();
    const root = new URL("/?entry=bookmark", fixture.endpoint);

    expect(await requestWithHost(root, root.origin, "localhost:1", "GET")).toBe(403);
    const redirect = await fetch(root, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/console/?entry=bookmark");

    const document = await fetch(root);
    expect(document.status).toBe(200);
    expect(new URL(document.url).pathname).toBe("/console/");
    expect(await document.text()).toContain("console-test-index");
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
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { version: number; objectiveRecords: Array<{ id?: string; pluginId?: string; type?: string; payload?: { providerSession?: unknown } }> };
    expect(state.version).toBe(4);
    expect(state.objectiveRecords).toHaveLength(1);
    expect(state.objectiveRecords[0]).toMatchObject({ id: session.sessionId, pluginId: "terminal", type: "agent" });
    expect(state.objectiveRecords[0]?.payload?.providerSession).toBeUndefined();
    if (process.platform !== "win32") expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    await expect(list.json()).resolves.toMatchObject({ sessions: [{ sessionId: session.sessionId, status: "terminal-only" }] });
  });

  it("does not overwrite a durable state with an unsupported version", async () => {
    const original = JSON.stringify({
      version: 0,
      theaters: [{ id: "future-theater" }],
      objectiveRecords: [{ id: "future-objectiveRecord" }],
    });
    let stateFile = "";
    await expect(startFixture({
      beforeCreateServer: ({ fleetDataDir }) => {
        const consoleDir = path.join(fleetDataDir, "console");
        fs.mkdirSync(consoleDir, { recursive: true });
        stateFile = path.join(consoleDir, "state.json");
        fs.writeFileSync(stateFile, original);
      },
    })).rejects.toThrow("archive_recovery_required");

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
        seedDurableObjectives(fleetDataDir, {
          id: theaterId,
          path: dir,
          realpath,
          label: path.basename(dir),
          registeredAt: "2026-06-16T00:00:00.000Z",
          lastOpenedAt: "2026-06-16T00:00:01.000Z",
        }, [{
          id: "session-a",
          theaterId,
          title: "Durable provider title",
          cwd: dir,
          providerTitle: { source: "provider" },
          session: {
            harness: "claude-code",
            id: "provider-session-secret",
            capturedAt: "2026-06-16T00:00:02.000Z",
          },
          ts: { createdAt: 1_000, updatedAt: 1_000 },
        }]);
      },
      terminalStartShell: (launch) => {
        startedShells.push(launch.cwd);
        return createMockPty();
      },
    });

    const theaters = await getJson<{ readonly theaters: readonly Record<string, unknown>[] }>(`${fixture.endpoint}api/v1/theaters`);
    const sessions = await getJson<{ readonly sessions: readonly Record<string, unknown>[] }>(`${fixture.endpoint}api/v1/agent/sessions`);
    const ownerRoot = path.join(fixture.fleetDataDir, "console", "commodore");
    const ownerId = fs.readdirSync(ownerRoot).find((id) => /^[a-f0-9-]{36}$/.test(id))!;
    const saved = JSON.parse(fs.readFileSync(path.join(ownerRoot, ownerId, "objectives/session-a/objective.json"), "utf8"));
    const serialized = JSON.stringify({ theaters, sessions });

    expect(startedShells).toEqual([]);
    expect(theaters.theaters[0]).toMatchObject({ id: theaterId, label: path.basename(dir) });
    expect(sessions.sessions[0]).toMatchObject({ sessionId: "session-a", status: "dormant", resumeAvailable: true });
    expect(sessions.sessions[0]).toMatchObject({ label: "Durable provider title" });
    expect(saved.session).toMatchObject({ harness: "claude-code", id: "provider-session-secret" });
    expect(saved).toMatchObject({ title: "Durable provider title", providerTitle: { source: "provider" } });
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain("provider-session-secret");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("providerSession");
    expect(serialized).not.toContain("providerTitle");
  });

  it("persists a member subagent block across the durable state boundary", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-subagent-"));
    tempDirs.push(dir);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-location-"));
    tempDirs.push(other);
    const registered = path.join(fs.realpathSync.native(other), "B");
    const unregistered = path.join(fs.realpathSync.native(other), "C");
    fs.mkdirSync(registered);
    fs.mkdirSync(unregistered);
    fs.symlinkSync(unregistered, path.join(dir, "escape"), "junction");
    const realpath = fs.realpathSync.native(dir);
    const theaterId = workspaceHash(realpath);
    const fixture = await startFixture({
      beforeCreateServer: ({ fleetDataDir }) => {
        const storage = seedDurableObjectives(fleetDataDir, {
          id: theaterId,
          path: dir,
          realpath,
          label: path.basename(dir),
          registeredAt: "2026-09-25T00:00:00.000Z",
          lastOpenedAt: "2026-09-25T00:00:01.000Z",
        }, [{
          id: "commander-1",
          theaterId,
          title: "Objective",
          cwd: dir,
          session: { harness: "claude-code", sessionName: "objective-cmdr" },
          sessions: [{
            id: "member-1",
            cwd: dir,
            subagentSpawn: "default",
            session: { harness: "claude-code", sessionName: "objective-member-1", disableSubagents: true },
            ts: { createdAt: 1_001, updatedAt: 1_001 },
          }],
          ts: { createdAt: 1_000, updatedAt: 1_000 },
        }], [{ id: workspaceHash(registered), path: registered, realpath: registered, label: "B", registeredAt: "2026-09-25T00:00:00.000Z", lastOpenedAt: "2026-09-25T00:00:01.000Z" }]);
        const ownerId = storage.board.owners()[0]!.commodoreId;
        storage.board.save(ownerId, {
          ...storage.board.list(ownerId)[0]!,
          rank: 0,
          note: "",
          members: [{ id: "member-1", role: "Bravo", by: "human", subagents: true }],
          missions: [],
        });
        const commodoreId = storage.board.owners()[0]!.commodoreId;
        for (const [id, cwd] of [["fixed-b", registered], ["outside-c", unregistered], ["escaped", path.join(realpath, "escape")]] as const) {
          storage.board.save(commodoreId, { id, cwd, commodoreId, theaterId, pending: true, title: id, rank: 0, note: "", members: [], missions: [], ts: { createdAt: 1_000, updatedAt: 1_000 } });
        }

      },
    });
    const origin = new URL(fixture.endpoint).origin;
    const response = await fetch(`${origin}/api/v1/objectives/member/patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify({ objectiveId: "commander-1", memberId: "member-1", patch: { subagents: false } }),
    });
    expect(response.status).toBe(200);
    const ownerRoot = path.join(fixture.fleetDataDir, "console", "commodore");
    const ownerId = fs.readdirSync(ownerRoot).find((id) => fs.existsSync(path.join(ownerRoot, id, "objectives/commander-1/objective.json")))!;
    const saved = JSON.parse(fs.readFileSync(path.join(ownerRoot, ownerId, "objectives/commander-1/objective.json"), "utf8"));
    expect(saved.sessions).toEqual([expect.objectContaining({ id: "member-1", subagentSpawn: "blocked" })]);
    expect(saved.members).toEqual([expect.objectContaining({ id: "member-1" })]);
    // 소유 Theater A와 무관하게 등록된 B는 열되 미등록 C·심볼릭 링크 탈출은 닫힌다.
    const location = await fetch(`${origin}/api/v1/conversation-workbench/location?objectiveId=fixed-b`);
    expect(location.status).toBe(200);
    expect(await location.json()).toMatchObject({ location: { theaterId: workspaceHash(registered), label: "B" } });
    for (const objectiveId of ["outside-c", "escaped"]) {
      const unavailable = await fetch(`${origin}/api/v1/conversation-workbench/location?objectiveId=${objectiveId}`);
      expect(unavailable.status).toBe(404);
      expect(await unavailable.json()).toEqual({ error: "unavailable" });
      const files = await fetch(`${origin}/api/v1/file-explorer/files/list`, {
        method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify({ objectiveId, relativePath: "" }),
      });
      expect(files.status).toBe(404);
      expect(await files.json()).toEqual({ error: "unavailable" });
    }
    const sessionsBefore = await getJson(`${origin}/api/v1/agent/sessions`);
    const ownerless = await fetch(`${origin}/api/v1/agent/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify({ theaterId, cliId: "claude" }),
    });
    expect(ownerless.status).toBe(400);
    expect(await ownerless.json()).toEqual({ error: "commodore_required" });
    expect(await getJson(`${origin}/api/v1/agent/sessions`)).toEqual(sessionsBefore);
    // 같은 호스트의 생성 경계는 실행 전부터 소유 UUID와 고정 cwd를 분리한다.
    const createdResponse = await fetch(`${origin}/api/v1/objectives/objective/create`, {
      method: "POST", headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify({ commodoreId: ownerId, theaterId, title: "Unlaunched location" }),
    });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as { objective: { id: string; commodoreId: string; theaterId: string } };
    expect(created.objective).toMatchObject({ commodoreId: ownerId, theaterId });
    expect(created.objective).not.toHaveProperty("cwd");
    const pending = JSON.parse(fs.readFileSync(path.join(ownerRoot, ownerId, "objectives", created.objective.id, "objective.json"), "utf8"));
    expect(pending).toMatchObject({ pending: true, cwd: realpath });
    const deniedOwner = await fetch(`${origin}/api/v1/objectives/objective/create`, {
      method: "POST", headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify({ commodoreId: "00000000-0000-4000-8000-000000000000", theaterId, title: "Not this owner" }),
    });
    expect(deniedOwner.status).toBe(409);
    expect(await deniedOwner.json()).toEqual({ error: "objective_owner_unavailable" });

    expect(JSON.parse(fs.readFileSync(path.join(fixture.fleetDataDir, "console", "state.json"), "utf8"))).not.toHaveProperty("objectiveRecords");
  });

  it("applies Claude trust only on consent while preserving global settings and rejecting invalid JSON", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-trust-"));
    tempDirs.push(dir);
    const config = path.join(dir, "claude-config");
    fs.mkdirSync(config);
    const file = path.join(config, ".claude.json");
    const first = path.join(dir, "first");
    const second = path.join(dir, "second");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(file, JSON.stringify({ custom: "keep", projects: { elsewhere: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
    vi.stubEnv("CLAUDE_CONFIG_DIR", config);
    try {
      const fixture = await startFixture();
      await createTheater(fixture, first);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ custom: "keep", projects: { elsewhere: { hasTrustDialogAccepted: true } } });
      const grant = await issueTheaterFolderGrant(fixture, second);
      const response = await fetch(`${fixture.endpoint}api/v1/theaters`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderGrantId: grant.folderGrantId, claudeTrustConsent: true }),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
        custom: "keep", projects: { elsewhere: { hasTrustDialogAccepted: true }, [fs.realpathSync(second)]: { hasTrustDialogAccepted: true } },
      });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const beforeLockFailure = fs.readFileSync(file, "utf8");
      fs.mkdirSync(`${file}.lock`);
      const lockedGrant = await issueTheaterFolderGrant(fixture, first);
      const locked = await fetch(`${fixture.endpoint}api/v1/theaters`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderGrantId: lockedGrant.folderGrantId, claudeTrustConsent: true }),
      });
      expect(locked.status).toBe(409);
      expect(fs.readFileSync(file, "utf8")).toBe(beforeLockFailure);
      fs.rmdirSync(`${file}.lock`);
      fs.writeFileSync(file, "{broken");
      const failedGrant = await issueTheaterFolderGrant(fixture, first);
      const failed = await fetch(`${fixture.endpoint}api/v1/theaters`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderGrantId: failedGrant.folderGrantId, claudeTrustConsent: true }),
      });
      expect(failed.status).toBe(409);
      await expect(failed.json()).resolves.toEqual({ error: "claude_trust_invalid_config" });
      expect(fs.readFileSync(file, "utf8")).toBe("{broken");
      const target = path.join(config, "actual.json");
      fs.writeFileSync(target, beforeLockFailure, { mode: 0o600 });
      fs.rmSync(file);
      fs.symlinkSync(target, file);
      fs.mkdirSync(`${file}.lock`);
      const linkedLockedGrant = await issueTheaterFolderGrant(fixture, first);
      const linkedLocked = await fetch(`${fixture.endpoint}api/v1/theaters`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderGrantId: linkedLockedGrant.folderGrantId, claudeTrustConsent: true }),
      });
      expect(linkedLocked.status).toBe(409);
      expect(fs.readFileSync(target, "utf8")).toBe(beforeLockFailure);
      fs.rmdirSync(`${file}.lock`);
      const linkedGrant = await issueTheaterFolderGrant(fixture, first);
      const linked = await fetch(`${fixture.endpoint}api/v1/theaters`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderGrantId: linkedGrant.folderGrantId, claudeTrustConsent: true }),
      });
      expect(linked.status).toBe(200);
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(target, "utf8")).projects[fs.realpathSync(first)].hasTrustDialogAccepted).toBe(true);
      const repo = path.join(dir, "nested-repo");
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
      const settings = JSON.parse(fs.readFileSync(target, "utf8"));
      settings.projects[fs.realpathSync(dir)] = { hasTrustDialogAccepted: true };
      fs.writeFileSync(target, JSON.stringify(settings));
      expect(await isClaudePathTrusted(repo)).toBe(false);
      await trustClaudeTheater(repo);
      expect(JSON.parse(fs.readFileSync(target, "utf8")).projects[fs.realpathSync(repo)].hasTrustDialogAccepted).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });

  it("never lets an Objective take a Fleet or plugin Session Browser owner id", async () => {
    // 사람과 플러그인 세션의 소유자 좌표를 Objective이 차지하면 다른 세션의 탭에 닿는다.
    const fixture = await startFixture();
    const origin = new URL(fixture.endpoint).origin;
    for (const id of ["global", "plugin-browser:reserved-session"]) {
      const response = await fetch(`${origin}/api/v1/objectives/records`, {
        method: "POST",
        headers: { "Content-Type": "application/json", origin },
        body: JSON.stringify({ id, commodoreId: "c1", theaterId: "theater", type: "terminal", pluginId: null, title: "spoof" }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "objectiveRecord_exists" });
    }
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
      sessions: { canAttach: () => true, createSession: async () => undefined, attach: async () => undefined, attachViewer: () => false, renegotiateSockets: () => {}, getSessionMessagePolicy: () => undefined, getSessionRenameCommand: () => undefined, getSessionLastActivityAt: () => null, hasSession: () => false, getShellLineState: () => null, getForegroundProcess: () => null, resolveSessionIdentity: async () => null, terminate: () => false, terminateAndWait: async () => true, awaitWriterExit: async () => true, stop: async () => undefined, writeToSession: () => false },
      isAuthorized: () => true,
    });

    const handled = handler.handleUpgrade({
      req: {
        url: `${"/api/v1/terminal"}/ws`,
        headers: { origin: "http://127.0.0.1:37283" },
        rawHeaders: ["Host", "127.0.0.1:37283"],
      } as never,
      socket: { destroy: () => { destroyed += 1; } } as never,
      head: Buffer.alloc(0),
      pathname: `${"/api/v1/terminal"}/ws`,
    });

    expect(handled).toBe(true);
    expect(destroyed).toBe(1);
    handler.close();
  });

  it("stops and releases the runtime lock while a page still holds a terminal WebSocket", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-shell-"));
    tempDirs.push(cwd);
    let killed = 0;
    const fixture = await startFixture({
      terminalLaunch: createMockLaunch,
      terminalStartShell: () => ({ ...createMockPty(), kill: () => { killed += 1; } }),
    });
    const theater = await createTheater(fixture, cwd);
    const ticketResponse = await fetch(`${fixture.endpoint}api/v1/shell/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: { theaterId: theater.id } }),
    });
    expect(ticketResponse.status).toBe(200);
    const { ticket } = await ticketResponse.json() as { readonly ticket: string };
    const socket = new WebSocket(`${fixture.endpoint.replace(/^http/u, "ws")}api/v1/terminal/ws?ticket=${encodeURIComponent(ticket)}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    // 업그레이드된 소켓이 리스너 close를 붙잡으면 stop은 영영 끝나지 않는다(SIGTERM 뒤 lock·자식이 남는 원인).
    await fixture.server.stop();

    expect(fs.existsSync(fixture.lockFile)).toBe(false);
    expect(killed).toBe(1);
    await socketClosed;
  }, 10_000);
});

// 현재 writer로 명부와 owner별 objective/groups/archive를 함께 심는다. 폐기된 위치 이주에 기대지 않는다.
function seedDurableObjectives(fleetDataDir: string, theater: DurableConsoleState["theaters"][number], objectiveRecords: readonly Omit<ObjectiveRecord, "commodoreId">[], additionalTheaters: readonly DurableConsoleState["theaters"][number][] = []) {
  const directory = path.join(fleetDataDir, "console");
  const entities = createCommodoreEntities(path.join(directory, "commodore"), workspaceHash);
  const ownerId = entities.create(theater.realpath);
  const stateStore = createDurableJsonStore<DurableConsoleState>({ filePath: path.join(directory, "state.json"), lockDir: null, sensitivity: "sensitive", sanitize: sanitizeDurableConsoleState });
  const storage = createObjectiveStorage({ directory, stateStore, owners: () => [{ directory: path.join(entities.dirOf(ownerId)!, "objectives"), commodoreId: ownerId, legacyTheaterId: theater.id, legacyCwd: theater.realpath, theaterIdOf: (cwd: string) => workspaceHash(cwd) }] });
  storage.load();
  storage.save({ version: STATE_VERSION, theaters: [theater, ...additionalTheaters], objectiveRecords: objectiveRecords.map((node) => ({ ...node, commodoreId: ownerId })) });
  return storage;
}

async function startReminderFixture(options: Parameters<typeof startFixture>[0] = {}): Promise<ServerFixture> {
  return startFixture(options);
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
  readonly lifecycle?: ConsoleServerDeps["lifecycle"];
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
    lifecycle: options.lifecycle,
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile });
  const lock = readConsoleLockFile<ConsoleLockPayload>(lockFile)!;
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
  const created = await fetch(`${fixture.endpoint}api/v1/agent/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ theaterId, cliId: "claude" }),
  });
  expect(created.status).toBe(200);
  return created.json() as Promise<{ readonly sessionId: string }>;
}

async function createObjective(fixture: ServerFixture, theaterId: string, input: { readonly type: string; readonly pluginId: string }): Promise<{ readonly id: string }> {
  const response = await fetch(`${fixture.endpoint}api/v1/objectives`, {
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
  const payload = await response.json() as { readonly objectiveRecord?: { readonly id?: unknown } };
  const objectiveId = payload.objectiveRecord?.id;
  expect(typeof objectiveId).toBe("string");
  return { id: objectiveId as string };
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
