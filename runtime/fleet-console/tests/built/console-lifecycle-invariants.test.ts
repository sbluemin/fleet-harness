import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CONSOLE_SERVE_EXIT_LOCK_HELD } from "@fleet-console/protocol/desktop";

import { CONSOLE_FAILURE_LOG_FILE } from "../../core/host/bootstrap/failure-log.js";

// Process lifecycle invariants of a real built Console (objective e7874487, success criterion 3):
//   I1  no signal reaches a process outside the Console's own tree
//   I2  no agent process outlives the Console, whichever way it ended
//   I3  a Console that does not own the runtime lock writes and removes nothing
//   I4  an external escalation (SIGKILL) never pre-empts the Console's own shutdown deadline
//   I5  after a crash or an external SIGKILL the next Console reclaims the lock and the leftovers
// Every case drives the published entry points (dist/cli.mjs serve/stop and the HTTP API) with a credential-free agent
// stand-in, so the cases hold whatever lifecycle module ends up behind those entry points. Test-only preloads inject the
// faults; no production switch exists for them. POSIX signal semantics: Windows TerminateProcess has no shutdown path.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(packageRoot, "../..");
const cliDist = path.join(packageRoot, "dist", "cli.mjs");
const FAKE_AGENT = fileURLToPath(new URL("../fixtures/lifecycle-fake-agent.mjs", import.meta.url));
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const AGENT_ROLES = new Set(["chat", "chat-mcp", "terminal", "terminal-mcp"]);
// How long a process the Console no longer accounts for may take to go away once the decisive moment has passed.
const SETTLE_MS = 5_000;

const runSuite = process.env.FLEET_LIFECYCLE_SUITE === "1" && process.platform !== "win32";

const OWNED = new Map<number, string>();
const ROOTS: string[] = [];
const RUNS: Run[] = [];

afterEach(async () => {
  for (const run of RUNS.splice(0)) {
    for (const entry of procs(run)) if (AGENT_ROLES.has(entry.role)) OWNED.set(entry.pid, agentMarker(entry.role));
  }
  // Only processes this suite started, and only while their command line still says so: a recycled pid is someone else's.
  for (const [pid, marker] of OWNED) {
    if (alive(pid) && commandOf(pid).includes(marker)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
  OWNED.clear();
  await delay(200);
  for (const root of ROOTS.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

(runSuite ? describe : describe.skip)("Console process lifecycle invariants", () => {
  it("requires the built Console", () => {
    expect(fs.existsSync(cliDist), "run pnpm --filter @dotobokuri/fleet-console build first").toBe(true);
  });

  // I2 main path: `fleet console stop` while an agent is mid-turn and ignores SIGTERM. The Console must account for that
  // agent and its MCP child before it is gone, even though stop returns as soon as the lock is released.
  it("stops with an agent mid-turn and leaves no agent process behind", async () => {
    const run = createRun("graceful");
    const consoleProcess = spawnServe(run);
    const startedAt = Date.now();
    const endpoint = await waitForReady(run, consoleProcess.pid!);
    await openWorkload(run, endpoint, { terminal: true });
    await provableByStartTime(startedAt);

    const stop = spawnSync(process.execPath, [cliDist, "stop"], { env: run.env, encoding: "utf8", timeout: 40_000 });
    const exit = await exitOf(consoleProcess, 20_000);

    expect(stop.status).toBe(0);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(readLock(run)).toBeNull();
    expect(await agentSurvivors(run, SETTLE_MS)).toEqual([]);
  }, 60_000);

  // eca5f8c7 (I4, I2, I1). The Console's shutdown stalls with the lock held, so its own 10s deadline has to reap the agent.
  // A process-table read that takes 600ms (inside the Console's own 1s allowance) moves that reap past the moment `stop`
  // escalates; an escalation that comes first kills the Console before it reaps, and the agent is orphaned. The Console
  // shares its process group with a sibling, as a Desktop sidecar does, so a group-wide kill would be caught too.
  it("lets the Console's own shutdown deadline finish before stop escalates", async () => {
    const run = createRun("escalation");
    const stalled = path.join(run.dir, "stalled");
    const preload = writePreload(run, "stall-close.mjs", [
      "import fs from 'node:fs';",
      "import http from 'node:http';",
      `const lock = ${JSON.stringify(run.lockFile)}, stalled = ${JSON.stringify(stalled)};`,
      "const close = http.Server.prototype.close;",
      "http.Server.prototype.close = function (callback) {",
      "  let port = null;",
      "  try { port = JSON.parse(fs.readFileSync(lock, 'utf8')).port; } catch {}",
      "  const address = this.address();",
      "  if (port !== null && address && typeof address === 'object' && address.port === port) { fs.writeFileSync(stalled, ''); return this; }",
      "  return close.call(this, callback);",
      "};",
    ]);
    const group = spawnGroup(run, { preload, env: { PATH: [slowProcessTable(run, 600), ...run.env.PATH.split(":")].join(":") } });
    const consolePid = await group.consolePid;
    const startedAt = Date.now();
    const endpoint = await waitForReady(run, consolePid);
    await openWorkload(run, endpoint, { terminal: false });
    await provableByStartTime(startedAt);

    spawnSync(process.execPath, [cliDist, "stop"], { env: run.env, encoding: "utf8", timeout: 60_000 });
    const exit = await group.consoleExit(20_000);

    expect(fs.existsSync(stalled), "the injected stall must hold the shutdown with the lock held").toBe(true);
    expect.soft(exit.signal, "I4: stop SIGKILLed the Console before its own deadline reaped the agent").not.toBe("SIGKILL");
    expect.soft(await agentSurvivors(run, SETTLE_MS), "I2").toEqual([]);
    expect.soft(group.outsiders(), "I1: the sibling and the parent in the Console's group").toEqual({ alive: true, signals: [] });
  }, 90_000);

  // d48e62ac (I2, I5). An uncaught exception while serving ends the Console at once; the next Console must find the slot
  // usable and no agent of the crashed one may still run.
  it("leaves no agent behind and a reclaimable lock after a crash while serving", async () => {
    const run = createRun("crash");
    const preload = writePreload(run, "crash.mjs", [
      "process.on('SIGUSR2', () => setImmediate(() => { throw new Error('lifecycle suite injected crash'); }));",
    ]);
    const first = spawnServe(run, { preload });
    const endpoint = await waitForReady(run, first.pid!);
    await openWorkload(run, endpoint, { terminal: true });

    first.kill("SIGUSR2");
    const exit = await exitOf(first, 10_000);
    expect(exit.code).not.toBe(0);
    const next = spawnServe(run);
    await waitForReady(run, next.pid!);

    expect.soft(readLock(run)?.pid, "I5").toBe(next.pid);
    expect.soft(await agentSurvivors(run, SETTLE_MS), "I2").toEqual([]);
  }, 60_000);

  // X1 and f64f5d65 E1 (I2, I5). Nothing runs inside a SIGKILLed Console, so containment and the next Console have to cover
  // it. The killed Console reached its slot through a symlinked parent (as /var reaches /private/var on macOS) and the next
  // one through the real path: both spellings name one slot, so its launch leftovers are the next Console's to reclaim.
  it("leaves no agent behind and reclaims the lock and leftovers after an external SIGKILL", async () => {
    const run = createRun("sigkill");
    const linked = path.join(run.dir, "linked-root");
    fs.symlinkSync(run.root, linked, "dir");
    const first = spawnServe(run, { env: { FLEET_DATA_DIR: linked, FLEET_CONSOLE_DATA_DIR: path.join(linked, "console") } });
    const endpoint = await waitForReady(run, first.pid!);
    const attachment = await uploadAttachment(run, endpoint);
    await openWorkload(run, endpoint, { terminal: true });

    first.kill("SIGKILL");
    await exitOf(first, 5_000);
    const next = spawnServe(run);
    await waitForReady(run, next.pid!);

    expect.soft(readLock(run)?.pid, "I5").toBe(next.pid);
    expect.soft(await agentSurvivors(run, SETTLE_MS), "I2").toEqual([]);
    expect.soft(attachment.filter((file) => fs.existsSync(file)), "I5: the killed Console's attachment namespace").toEqual([]);
  }, 60_000);

  // I3 and f64f5d65 E2. A second Console that loses the lock exits without touching anything except its `lock_held` entry in
  // the failure log (docs/console-lock-reclaim.md, the one documented exception). When lock exclusivity is broken
  // anyway (the lock file removed by hand, or by a legacy shell), the Console that then wins may reclaim only what a dead
  // Console left: the attachments of a Console that is still serving are not leftovers.
  it("never lets another Console write or remove what a live Console owns", async () => {
    const run = createRun("exclusive");
    const owner = spawnServe(run);
    const endpoint = await waitForReady(run, owner.pid!);
    const attachment = await uploadAttachment(run, endpoint);
    await openWorkload(run, endpoint, { terminal: false });
    await delay(1_000);
    const before = snapshot(run.root);

    const loser = spawnServe(run);
    const loserExit = await exitOf(loser, 20_000);

    expect(loserExit).toEqual({ code: CONSOLE_SERVE_EXIT_LOCK_HELD, signal: null });
    expect.soft(diffSnapshot(before, snapshot(run.root)), "I3: the lock loser changed the data root").toEqual([]);
    expect.soft(attachment.filter((file) => !fs.existsSync(file)), "I3: the lock loser removed live attachments").toEqual([]);

    fs.rmSync(run.lockFile);
    const winner = spawnServe(run);
    await waitForReady(run, winner.pid!);

    expect(alive(owner.pid!)).toBe(true);
    expect.soft(attachment.filter((file) => !fs.existsSync(file)), "the attachments of the Console still serving").toEqual([]);
  }, 60_000);

  // 3b17763a (stop requests share one shutdown). An accepted in-place update stops the Console from inside; a SIGTERM that
  // arrives during that stop must wait for the same cleanup instead of reporting it finished while the lock is still held.
  // Server boundary: the stop the signal handler calls is ConsoleServer#stop, and the update path needs a release.
  it("finishes a stop requested during an update's own shutdown only after that shutdown ends", async () => {
    const run = createRun("self-stop");
    const { createConsoleServer } = await import("../../core/host/bootstrap/server.js");
    const hooks = globalThis as { __fleetLifecycleSlowCleanup?: () => Promise<void>; __fleetAgentCliDetector?: unknown };
    let cleanupEntered = false;
    let cleanupFinishedAt: number | null = null;
    hooks.__fleetLifecycleSlowCleanup = async () => {
      cleanupEntered = true;
      await delay(1_500);
      cleanupFinishedAt = Date.now();
    };
    hooks.__fleetAgentCliDetector = { detect: async () => [] };
    const server = createConsoleServer({
      port: 0,
      version: "1.0.0",
      dataDir: run.root,
      pluginHomeDir: run.dir,
      release: { channel: "stable", version: "1.0.0", packageRoot: createSlowCleanupPackage(run) },
      updateCheck: {
        getStatus: () => ({ updateAvailable: true, latestVersion: "9.9.9" }),
        refresh: async () => ({ updateAvailable: true, latestVersion: "9.9.9" }),
        latestRelease: () => ({ version: "9.9.9" }) as never,
      },
      updateApply: { start: async () => ({}) as never },
    });
    try {
      const endpoint = await server.start({ dir: run.slot, lockFile: run.lockFile });
      const origin = new URL(endpoint).origin;
      const accepted = await fetch(new URL("api/v1/updates/apply", endpoint), { method: "POST", headers: { origin } });
      expect(accepted.status).toBe(202);
      await waitUntil(() => cleanupEntered, 10_000, "the update's own shutdown did not reach cleanup");

      await server.stop();
      const lockHeldAtReturn = fs.existsSync(run.lockFile);
      const cleanupDoneAtReturn = cleanupFinishedAt !== null;

      expect.soft(cleanupDoneAtReturn, "stop returned while the update's cleanup was still running").toBe(true);
      expect.soft(lockHeldAtReturn, "stop returned while the lock was still held").toBe(false);
    } finally {
      await waitUntil(() => cleanupFinishedAt !== null, 10_000, "cleanup never finished").catch(() => {});
      await server.stop().catch(() => {});
      delete hooks.__fleetLifecycleSlowCleanup;
      delete hooks.__fleetAgentCliDetector;
    }
  }, 30_000);
});

interface Run {
  readonly dir: string;
  readonly root: string;
  readonly slot: string;
  readonly lockFile: string;
  readonly tmp: string;
  readonly agentDir: string;
  readonly theater: string;
  readonly env: Record<string, string> & { readonly PATH: string };
}

/**
 * One isolated run. Fleet data lives in the checkout's isolated root (docs/fleet-development-reference.md, Isolated
 * Development Data) and TMPDIR outside the checkout. The child environment is built from nothing, never inherited, so a
 * Console that launched this suite cannot lend it its slot, resume port or child-session marker.
 */
function createRun(name: string): Run {
  const base = path.join(repoRoot, ".fleet", "isolated", "lifecycle");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `${name}-`));
  ROOTS.push(dir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-lifecycle-${name}-`));
  ROOTS.push(tmp);
  if (isInside(fs.realpathSync(tmp), fs.realpathSync(repoRoot))) throw new Error("TMPDIR must stay outside the checkout");
  const root = path.join(dir, "root");
  const slot = path.join(root, "console");
  const home = path.join(dir, "home");
  const agentDir = path.join(dir, "agent");
  const theater = path.join(dir, "theater");
  const pathbin = path.join(dir, "bin");
  for (const target of [root, home, agentDir, theater, pathbin]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  // The agent stand-in is a `#!/usr/bin/env node` script: only this Node goes on PATH, never a directory of real CLIs.
  fs.symlinkSync(process.execPath, path.join(pathbin, "node"));
  const user = os.userInfo().username;
  const env = {
    HOME: home,
    TMPDIR: tmp,
    PATH: [pathbin, ...SYSTEM_PATH].join(":"),
    USER: user,
    LOGNAME: user,
    LANG: "en_US.UTF-8",
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    FLEET_DATA_DIR: root,
    FLEET_CONSOLE_DATA_DIR: slot,
    FLEET_DESKTOP_DATA_DIR: path.join(dir, "desktop"),
    CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_BIN: FAKE_AGENT,
    FAKE_AGENT_DIR: agentDir,
  };
  const run = { dir, root, slot, lockFile: path.join(slot, "console.lock"), tmp, agentDir, theater, env };
  RUNS.push(run);
  return run;
}

function agentMarker(role: string): string {
  return role.endsWith("-mcp") ? "process.stdin.resume" : FAKE_AGENT;
}

function spawnServe(run: Run, options: { readonly preload?: string; readonly env?: Record<string, string> } = {}): ChildProcess {
  const args = [...(options.preload ? ["--import", pathToFileURL(options.preload).href] : []), cliDist, "serve"];
  // Detached like `fleet console start`: the Console leads its own process group.
  const child = spawn(process.execPath, args, { env: { ...run.env, ...options.env }, stdio: "ignore", detached: true });
  OWNED.set(child.pid!, cliDist);
  return child;
}

/**
 * A parent that is not the test runner starts the Console without detaching it, so the Console shares that parent's process
 * group the way a Desktop sidecar shares Desktop's, next to a sibling that has nothing to do with it. Both record any
 * catchable signal they receive.
 */
function spawnGroup(run: Run, options: { readonly preload: string; readonly env: Record<string, string> }) {
  const signals = path.join(run.dir, "outsider-signals");
  const report = path.join(run.dir, "group.json");
  const launcher = path.join(run.dir, "group-parent.mjs");
  fs.writeFileSync(launcher, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    `const signals = ${JSON.stringify(signals)}, report = ${JSON.stringify(report)};`,
    "for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGUSR1', 'SIGUSR2']) process.on(signal, () => fs.appendFileSync(signals, `parent ${signal}\\n`));",
    `const sibling = spawn(process.execPath, ['-e', ${JSON.stringify(`for (const s of ['SIGTERM','SIGINT','SIGHUP','SIGUSR1','SIGUSR2']) process.on(s, () => require('fs').appendFileSync(${JSON.stringify(signals)}, 'sibling ' + s + '\\n')); setInterval(() => {}, 1 << 30);`)}], { stdio: 'ignore' });`,
    `const child = spawn(process.execPath, ['--import', ${JSON.stringify(pathToFileURL(options.preload).href)}, ${JSON.stringify(cliDist)}, 'serve'], { stdio: 'ignore', env: { ...process.env, ...${JSON.stringify(options.env)} } });`,
    "const state = { parent: process.pid, sibling: sibling.pid, console: child.pid, exit: null };",
    "fs.writeFileSync(report, JSON.stringify(state));",
    "child.once('exit', (code, signal) => { state.exit = { code, signal }; fs.writeFileSync(report, JSON.stringify(state)); });",
    "setInterval(() => {}, 1 << 30);",
  ].join("\n"));
  const parent = spawn(process.execPath, [launcher], { env: run.env, stdio: "ignore", detached: true });
  OWNED.set(parent.pid!, launcher);
  const read = () => {
    try { return JSON.parse(fs.readFileSync(report, "utf8")) as { parent: number; sibling: number; console: number; exit: { code: number | null; signal: NodeJS.Signals | null } | null }; } catch { return null; }
  };
  const consolePid = (async () => {
    await waitUntil(() => read() !== null, 10_000, "the group parent did not start");
    const state = read()!;
    OWNED.set(state.sibling, "setInterval");
    OWNED.set(state.console, cliDist);
    return state.console;
  })();
  return {
    consolePid,
    async consoleExit(timeoutMs: number) {
      await waitUntil(() => read()?.exit != null, timeoutMs, "the Console did not exit");
      return read()!.exit!;
    },
    outsiders() {
      const state = read()!;
      const received = fs.existsSync(signals) ? fs.readFileSync(signals, "utf8").trim().split("\n").filter(Boolean) : [];
      return { alive: alive(state.parent) && alive(state.sibling), signals: received };
    },
  };
}

function writePreload(run: Run, name: string, lines: readonly string[]): string {
  const file = path.join(run.dir, name);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** A `ps` that answers after `delayMs`, for the Console's PATH only: its process-table read is slow, nobody else's is. */
function slowProcessTable(run: Run, delayMs: number): string {
  const dir = path.join(run.dir, "slow-ps");
  fs.mkdirSync(dir, { recursive: true });
  const realPs = SYSTEM_PATH.map((entry) => path.join(entry, "ps")).find((candidate) => fs.existsSync(candidate));
  if (!realPs) throw new Error("ps is not on the system PATH");
  fs.writeFileSync(path.join(dir, "ps"), `#!/bin/sh\nsleep ${delayMs / 1000}\nexec ${realPs} "$@"\n`, { mode: 0o755 });
  return dir;
}

/** `fleet console stop` proves a Console by its start time only once the Console has run for 2s. */
async function provableByStartTime(startedAt: number): Promise<void> {
  await delay(Math.max(0, startedAt + 2_500 - Date.now()));
}

function readLock(run: Run): { pid: number; endpoint: string; token: string } | null {
  try { return JSON.parse(fs.readFileSync(run.lockFile, "utf8")); } catch { return null; }
}

async function waitForReady(run: Run, pid: number, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = readLock(run);
    if (lock?.pid === pid) {
      try {
        const response = await fetch(new URL("api/v1/health", lock.endpoint), { headers: { authorization: `Bearer ${lock.token}` }, signal: AbortSignal.timeout(1_000) });
        if (response.ok) return lock.endpoint;
      } catch { /* Listener not up yet. */ }
    }
    if (!alive(pid)) throw new Error(`Console ${pid} exited before it became ready`);
    await delay(50);
  }
  throw new Error(`Console ${pid} did not become ready within ${timeoutMs}ms`);
}

async function api<T>(endpoint: string, method: string, route: string, body?: unknown, raw?: Buffer): Promise<T> {
  const origin = new URL(endpoint).origin;
  const response = await fetch(new URL(route, endpoint), {
    method,
    headers: { origin, "content-type": raw ? "image/png" : "application/json" },
    ...(raw ? { body: new Uint8Array(raw) } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/** An open chat turn (agent mid-turn, MCP child running) and optionally a terminal session, through the public API. */
async function openWorkload(run: Run, endpoint: string, options: { readonly terminal: boolean }): Promise<void> {
  const grant = await api<{ folderGrantId?: string; id?: string; grant?: { id: string } }>(endpoint, "POST", "/api/v1/theaters/folder-grants", { path: run.theater });
  const theater = await api<{ id?: string; theater?: { id: string } }>(endpoint, "POST", "/api/v1/theaters", { folderGrantId: grant.folderGrantId ?? grant.grant?.id ?? grant.id });
  const theaterId = theater.id ?? theater.theater?.id;
  const opened = procs(run).filter((entry) => entry.role === "turn-open").length;
  await api(endpoint, "POST", "/api/v1/agent/sessions", { theaterId, cliId: "claude", viewMode: "chat", prompt: "lifecycle suite open turn" });
  await waitUntil(() => procs(run).filter((entry) => entry.role === "turn-open").length > opened, 20_000, "the chat turn did not open");
  if (options.terminal) {
    const terminals = procs(run).filter((entry) => entry.role === "terminal").length;
    await api(endpoint, "POST", "/api/v1/agent/sessions", { theaterId, cliId: "claude" });
    await waitUntil(() => procs(run).filter((entry) => entry.role === "terminal").length > terminals, 20_000, "the terminal did not start");
  }
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** Uploads a Quick Launch attachment and returns the files it added under TMPDIR, wherever the Console keeps them. */
async function uploadAttachment(run: Run, endpoint: string): Promise<string[]> {
  const before = new Set(listFiles(run.tmp));
  await api(endpoint, "POST", "/api/v1/agent/attachments", undefined, PNG);
  const added = listFiles(run.tmp).filter((file) => !before.has(file));
  expect(added.length).toBeGreaterThan(0);
  return added;
}

function procs(run: Run): Array<{ role: string; pid: number; ppid?: number }> {
  try {
    return fs.readFileSync(path.join(run.agentDir, "procs.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Agent processes that are still alive once `settleMs` has passed (or as soon as none is). */
async function agentSurvivors(run: Run, settleMs: number): Promise<string[]> {
  const agents = procs(run).filter((entry) => AGENT_ROLES.has(entry.role));
  for (const entry of agents) OWNED.set(entry.pid, agentMarker(entry.role));
  const deadline = Date.now() + settleMs;
  let left = agents.filter((entry) => alive(entry.pid));
  while (left.length > 0 && Date.now() < deadline) {
    await delay(100);
    left = left.filter((entry) => alive(entry.pid));
  }
  return left.map((entry) => entry.role);
}

function createSlowCleanupPackage(run: Run): string {
  const base = path.join(run.dir, "package");
  const plugins = path.join(base, "runtime", "fleet-plugins");
  const writePlugin = (id: string, routes: string) => {
    fs.mkdirSync(path.join(plugins, id), { recursive: true });
    fs.writeFileSync(path.join(plugins, id, "plugin.json"), JSON.stringify({ id, routes: "routes.mjs" }));
    fs.writeFileSync(path.join(plugins, id, "routes.mjs"), routes);
  };
  writePlugin("terminal", "export function register() {}\n");
  writePlugin("demo", "export function register(ctx) { ctx.host.lifecycle.registerCleanup(() => globalThis.__fleetLifecycleSlowCleanup?.()); }\n");
  const consoleRoot = path.join(base, "runtime", "fleet-console");
  fs.mkdirSync(consoleRoot, { recursive: true });
  return consoleRoot;
}

/** Every file under the data root by content, except the append-only failure log a lock loser may write to. */
function snapshot(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const file of listFiles(root)) if (path.basename(file) !== CONSOLE_FAILURE_LOG_FILE) entries.set(path.relative(root, file), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  return entries;
}

function diffSnapshot(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [file, hash] of before) if (after.get(file) !== hash) changed.push(after.has(file) ? `changed ${file}` : `removed ${file}`);
  for (const file of after.keys()) if (!before.has(file)) changed.push(`added ${file}`);
  return changed.sort();
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  walk(root);
  return files;
}

async function exitOf(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function commandOf(pid: number): string {
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function waitUntil(condition: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(25);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
