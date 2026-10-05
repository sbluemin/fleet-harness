import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CONSOLE_SERVE_EXIT_LOCK_HELD, CONSOLE_STOP_DEADLINE_MS } from "@fleet-console/protocol/lifecycle";

import { resolveSiblingConsoleCliPath } from "../../cli/update/stop-console.js";
import { resolveDefaultServerModulePath } from "../../core/host/bootstrap/console-lifecycle.js";
import { CONSOLE_FAILURE_LOG_FILE } from "../../core/host/bootstrap/failure-log.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fleetDist = path.join(packageRoot, "dist", "fleet.mjs");
const cliDist = path.join(packageRoot, "dist", "cli.mjs");
const desktopProtocolDist = path.join(packageRoot, "dist", "desktop-protocol.mjs");

const runBuiltSmoke = process.env.FLEET_BUILT_SMOKE === "1";

// 실프로세스 serve와 임시 루트는 테스트 본문이 아니라 여기서 정리한다 — 끝나지 않는 await에 걸린 본문은
// 타임아웃 뒤에도 finally에 도달하지 못해 serve가 남는다.
const SERVES = new Set<ChildProcess>();
const ROOTS: string[] = [];

afterEach(async () => {
  await Promise.all([...SERVES].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  }));
  SERVES.clear();
  for (const root of ROOTS.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

(runBuiltSmoke ? describe : describe.skip)("built dual-entry smoke", () => {
  it("requires built dual-entry artifacts", () => {
    expect(fs.existsSync(fleetDist), "run pnpm --filter @dotobokuri/fleet-console build first").toBe(true);
    expect(fs.existsSync(cliDist)).toBe(true);
    expect(fs.existsSync(desktopProtocolDist)).toBe(true);
  });

  it("resolves sibling dist/cli.mjs from the built fleet entry URL", () => {
    const fleetModuleUrl = pathToFileURL(fleetDist).href;
    expect(resolveSiblingConsoleCliPath(fleetModuleUrl)).toBe(cliDist);
    expect(resolveDefaultServerModulePath(fleetModuleUrl)).toBe(cliDist);
    expect(resolveDefaultServerModulePath(fleetModuleUrl)).not.toBe(fleetDist);
  });

  it("prints Fleet help from dist/fleet.mjs --help", () => {
    const result = spawnSync(process.execPath, [fleetDist, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("console             start · stop · restart · status");
    expect(result.stdout).not.toContain("console             start · stop · restart · status · help");
    expect(result.stdout).toContain("Unrecognized arguments are passed through to Claude Code.");
  });

  it("prints Console help from dist/cli.mjs --help without Gateway passthrough notes", () => {
    const result = spawnSync(process.execPath, [cliDist, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("fleet console");
    expect(result.stdout).toContain("fleet-console");
    expect(result.stdout).not.toContain("Gateway");
  });

  it("rejects unknown fleet console modes without Claude passthrough", () => {
    const result = spawnSync(process.execPath, [fleetDist, "console", "unknown-mode"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown fleet console command: unknown-mode");
    expect(result.stdout).not.toContain("Unrecognized arguments are passed through to Claude Code.");
  });

  it("keeps the served Console healthy and records a detached rejection", async () => {
    const root = createRoot("fleet-console-rejection-");
    const slot = path.join(root, "console");
    const lock = path.join(slot, "console.lock");
    const log = path.join(slot, "errors.jsonl");
    const preload = path.join(root, "inject.mjs");
    // Test-only preload: no production fault-injection switch or modified source bundle.
    fs.writeFileSync(preload, `import fs from 'node:fs';\nconst timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(lock)})) return; clearInterval(timer); Promise.reject(new Error('request_path_rejection_probe')); }, 25);\n`);
    const child = spawnServe(preload, root, slot);
    let payload: { endpoint: string; token: string } | null = null;
    let diagnostic: { kind: string; message: string; stack: string | null } | null = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Console exited before the rejection was observed: ${child.exitCode ?? child.signalCode}`);
      try {
        payload = JSON.parse(fs.readFileSync(lock, "utf8"));
        const lines = fs.readFileSync(log, "utf8").trim().split("\n");
        diagnostic = JSON.parse(lines.at(-1)!);
        if (diagnostic?.message === "request_path_rejection_probe") break;
      } catch { /* Wait for startup and the diagnostic. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(diagnostic).toMatchObject({ kind: "unhandledRejection", message: "request_path_rejection_probe" });
    expect(diagnostic?.stack).toContain("request_path_rejection_probe");
    expect(payload).not.toBeNull();
    const response = await waitForHealthyConsole(lock, Math.max(1, deadline - Date.now()));
    expect(response.ok).toBe(true);
    expect(child.exitCode).toBeNull();
  }, 25_000);

  // `fleet console stop` must not cut a shutdown that is still running: an open chat turn alone takes about 2s to reap its
  // SDK child, and killing that cleanup orphans the child and leaves launch temp files. POSIX only, like the case above.
  it.skipIf(process.platform === "win32")("lets a verified Console finish a slow shutdown before stop returns", async () => {
    const root = createRoot("fleet-console-slow-stop-");
    const slot = path.join(root, "console");
    const lock = path.join(slot, "console.lock");
    const held = path.join(root, "held");
    const preload = path.join(root, "slow.mjs");
    // Test-only preload: the last cleanup step (lock release) takes 1.5s, a shutdown still in progress well past the old 200ms.
    fs.writeFileSync(preload, [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      `const lock = ${JSON.stringify(lock)}, held = ${JSON.stringify(held)};`,
      "const pause = new Int32Array(new SharedArrayBuffer(4));",
      "for (const name of ['rmSync', 'unlinkSync']) {",
      "  const original = fs[name];",
      "  fs[name] = function (target, ...rest) {",
      "    if (String(target) === lock) { fs.writeFileSync(held, ''); Atomics.wait(pause, 0, 0, 1500); }",
      "    return original.call(this, target, ...rest);",
      "  };",
      "}",
      "syncBuiltinESMExports();",
    ].join("\n"));
    const spawnedAt = Date.now();
    const child = spawnServe(preload, root, slot);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    await waitForHealthyConsole(lock, 15_000);
    // stop proves the pid by its start time only for a Console started at least 2s before the identity probe.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, spawnedAt + 2_500 - Date.now())));
    // stop waits for the Console's exit to read how it ended, so this test must keep reaping its child while stop runs.
    const stop = await exitOf(spawn(process.execPath, [cliDist, "stop"], { env: isolatedEnv(root, slot), stdio: "ignore" }), 30_000);
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(fs.existsSync(held)).toBe(true);
    expect(stop).toEqual({ code: 0, signal: null });
    expect(fs.existsSync(lock)).toBe(false);
  }, 40_000);
});

// Process lifecycle invariants of a real built Console (objective e7874487, success criterion 3; case ids follow the
// lifecycle contract design):
//   I1  no signal reaches a process outside the Console's own tree, whoever sends it
//   I2  no process the Console started outlives it, whichever way it ended
//   I3  a Console that does not own the runtime lock writes and removes nothing
//   I4  an external escalation (SIGKILL) never pre-empts the Console's own shutdown deadline
//   I5  after a crash or an external SIGKILL the next Console reclaims the lock and the leftovers
// Every case drives the published entry points (dist/cli.mjs serve/start/stop and the HTTP API) with a credential-free agent
// stand-in that ignores SIGTERM mid-turn (tests/fixtures/lifecycle-fake-agent.mjs), so the cases hold whatever lifecycle
// module ends up behind those entry points. Test-only preloads inject the faults; no production switch exists for them. The
// Desktop half is in runtime/fleet-desktop/tests/sidecar-supervisor.test.ts and the stop-sharing case L7 in tests/server.test.ts.
//
// Known-defect ratchet: tests/fixtures/lifecycle-known-defects.json lists the cases whose defect is still open on canary. A
// listed case asserts the defect's signature, so it keeps proving that it catches the defect; the fixing change removes its
// entry and the invariant is asserted from then on. FLEET_LIFECYCLE_RATCHET=off asserts every invariant regardless.
const LIFECYCLE_KNOWN_DEFECTS = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../fixtures/lifecycle-known-defects.json", import.meta.url)), "utf8")) as ReadonlyArray<{ readonly case: string; readonly followup: string; readonly releasedBy: string }>;

// Long enough for anything that reaps after the Console is gone (a containment helper's own grace included).
const SETTLE_MS = 10_000;
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const AGENT_ROLES = new Set(["chat", "chat-mcp", "terminal", "terminal-mcp"]);
/** How long the escalation cases freeze the Console's event loop just before its own stop deadline. */
const FREEZE_BEFORE_DEADLINE_MS = 800;
const FAKE_AGENT = fileURLToPath(new URL("../fixtures/lifecycle-fake-agent.mjs", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
/** Every process a lifecycle case started or observed, by pid, with the start time that proves it is still that process. */
const OWNED = new Map<number, string>();
/** Live pids the agent stand-in recorded whose process started away from the record: never signalled, always reported. */
const UNPROVEN_RECORDS: string[] = [];
const RUNS: LifecycleRun[] = [];

afterEach(async () => {
  const runs = RUNS.splice(0);
  for (const run of runs) for (const entry of agentProcs(run)) if (AGENT_ROLES.has(entry.role)) ownRecorded(entry);
  const unproven = UNPROVEN_RECORDS.splice(0);
  // The suite keeps I1 itself: only a pid whose start time still matches is signalled, and nothing may be left behind.
  const left: string[] = [];
  if (OWNED.size > 0) {
    for (const [pid, startedAt] of OWNED) {
      if (processStartTime(pid) === startedAt) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
      }
    }
    const deadline = Date.now() + 3_000;
    for (const [pid, startedAt] of OWNED) {
      while (processStartTime(pid) === startedAt && Date.now() < deadline) await delay(25);
      if (processStartTime(pid) === startedAt) left.push(`${pid} ${commandOf(pid).trim()}`);
    }
    OWNED.clear();
  }
  for (const run of runs) for (const dir of [run.dir, run.tmp]) fs.rmSync(dir, { recursive: true, force: true });
  if (left.length > 0) throw new Error(`lifecycle processes survived SIGKILL: ${left.join("; ")}`);
  if (unproven.length > 0) throw new Error(`agent records that no live process proves (not signalled): ${unproven.join("; ")}`);
});

// POSIX signal semantics: Windows TerminateProcess runs no shutdown path at all.
(runBuiltSmoke && process.platform !== "win32" ? describe : describe.skip)("Console process lifecycle invariants", () => {
  // I2 main path: `fleet console stop` while an agent is mid-turn and ignores SIGTERM. The Console must account for that
  // agent and everything else it started before it is gone, although stop returns as soon as the lock is released.
  it("stops with an agent mid-turn and leaves no process behind", async () => {
    const run = createRun("graceful");
    const consoleProcess = spawnConsole(run);
    const startedAt = Date.now();
    const endpoint = await waitForReady(run, consoleProcess.pid!);
    await openWorkload(run, endpoint, { terminal: true });
    const started = descendantsOf(consoleProcess.pid!);
    await provableByStartTime(startedAt);

    const stop = await runStop(run.env);
    const exit = await exitOf(consoleProcess, 20_000);

    expect(stop.status).toBe(0);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(readRunLock(run)).toBeNull();
    expect(await survivors(run, started)).toEqual([]);
  }, 60_000);

  // L11 (#1543, #1565; I2). Repeated signals are harmless in both stretches of a shutdown: mid-cleanup with the lock held,
  // and after the lock is released while the SDK still reaps an agent that ignored SIGTERM. A serve that died in the second
  // stretch would take the SDK's SIGKILL timer with it and orphan the agent and its MCP child.
  it("finishes its shutdown and leaves no process behind when SIGTERM and SIGINT arrive again mid-cleanup and after the lock is released", async () => {
    const run = createRun("resignal");
    const stalled = path.join(run.dir, "stalled");
    const release = path.join(run.dir, "release");
    // Test-only preload: the last cleanup step (lock release) waits for the release file, so the repeated signals land
    // mid-cleanup with the lock still held.
    const preload = writePreload(run, "hold-lock-release.mjs", [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      `const lock = ${JSON.stringify(run.lockFile)}, stalled = ${JSON.stringify(stalled)}, release = ${JSON.stringify(release)};`,
      "const pause = new Int32Array(new SharedArrayBuffer(4));",
      "for (const name of ['rmSync', 'unlinkSync']) {",
      "  const original = fs[name];",
      "  fs[name] = function (target, ...rest) {",
      "    if (String(target) === lock) { fs.writeFileSync(stalled, ''); while (!fs.existsSync(release)) Atomics.wait(pause, 0, 0, 10); }",
      "    return original.call(this, target, ...rest);",
      "  };",
      "}",
      "syncBuiltinESMExports();",
    ]);
    const consoleProcess = spawnConsole(run, { preload });
    const endpoint = await waitForReady(run, consoleProcess.pid!);
    await openWorkload(run, endpoint, { terminal: false });
    const started = descendantsOf(consoleProcess.pid!);
    const agent = agentProcs(run).find((entry) => entry.role === "chat")!;
    const exited = exitOf(consoleProcess, 40_000);

    consoleProcess.kill("SIGTERM");
    await waitUntil(() => fs.existsSync(stalled), 10_000, "the shutdown did not reach the lock release");
    consoleProcess.kill("SIGTERM");
    consoleProcess.kill("SIGINT");
    await delay(300);
    expect(consoleProcess.exitCode ?? consoleProcess.signalCode).toBeNull();
    fs.writeFileSync(release, "");
    await waitUntil(() => readRunLock(run) === null, 10_000, "the lock was not released");
    await delay(300);
    expect(isAlive(agent.pid), "the SDK must still be reaping the agent after the lock is released").toBe(true);
    consoleProcess.kill("SIGTERM");
    consoleProcess.kill("SIGINT");
    await delay(300);
    expect(consoleProcess.exitCode ?? consoleProcess.signalCode).toBeNull();

    expect(await exited).toEqual({ code: 0, signal: null });
    expect(await survivors(run, started)).toEqual([]);
  }, 60_000);

  // L4c, eca5f8c7 (I4, then I2; I1). The shutdown stalls with the lock held, so only the Console's own 10s deadline reaps the
  // agent. The Console's event loop freezes for 800ms just before that deadline (inside the escalation margin the contract
  // allows a busy loop), which moves the reap to about 10.6s; stop must still not SIGKILL the Console first. The signature is the order, not the orphan: a reaper would hide the orphan before
  // stop's own fix lands. The Console shares a process group with a parent and a sibling, as a Desktop sidecar does.
  it("lets the Console's own shutdown deadline finish before stop escalates", async () => {
    const run = createRun("escalation");
    const stall = stallShutdownWithLockHeld(run, { freezeBeforeDeadline: true });
    const group = spawnGroup(run, { preload: stall.preload });
    const consolePid = await group.consolePid;
    const startedAt = Date.now();
    const endpoint = await waitForReady(run, consolePid);
    await openWorkload(run, endpoint, { terminal: false });
    const started = descendantsOf(consolePid);
    await provableByStartTime(startedAt);

    await runStop(run.env);
    const exit = await group.consoleExit(30_000);

    expect(fs.existsSync(stall.marker), "the injected stall must hold the shutdown with the lock held").toBe(true);
    lifecycleCheck("L4c", exit.signal !== "SIGKILL", "I4: stop does not SIGKILL the Console before its own deadline ends it", { detail: exit });
    const left = await survivors(run, started);
    lifecycleCheck("L4c", left.length === 0, "I2: nothing the Console started outlives it", { detail: { survivors: left, failureLog: failureKinds(run) }, signature: false });
    lifecycleCheck("I1", group.outsidersUntouched(), "the Console's parent and sibling in its process group are never signalled", { detail: group.outsiders() });
  }, 90_000);

  // L12, the residual risk of the escalation budget (I2 only; I4 is broken on purpose). The Console's event loop is blocked
  // for 2.5s when the stop signal arrives, so its own deadline lands after any external escalation: whatever kills the
  // Console then, nothing it started may outlive it.
  it("leaves no process behind when stop has to escalate past a Console stalled at the signal", async () => {
    const run = createRun("frozen");
    const stall = stallShutdownWithLockHeld(run, { freezeOnSignalMs: 2_500 });
    const consoleProcess = spawnConsole(run, { preload: stall.preload });
    const startedAt = Date.now();
    const endpoint = await waitForReady(run, consoleProcess.pid!);
    await openWorkload(run, endpoint, { terminal: false });
    const started = descendantsOf(consoleProcess.pid!);
    await provableByStartTime(startedAt);

    await runStop(run.env);
    await exitOf(consoleProcess, 30_000);

    expect(fs.existsSync(stall.marker), "the injected stall must hold the shutdown with the lock held").toBe(true);
    const left = await survivors(run, started);
    lifecycleCheck("L12", left.length === 0, "I2: nothing the Console started outlives it", { detail: { survivors: left, failureLog: failureKinds(run) } });
  }, 90_000);

  // L9, N4. The Console ends by its own deadline (stop's own process-table read is the slow one here, so stop never gets to
  // escalate); stop must not report that as a clean stop.
  it("reports a Console that ended by its own deadline as not cleanly stopped", async () => {
    const run = createRun("outcome");
    const stall = stallShutdownWithLockHeld(run);
    const consoleProcess = spawnConsole(run, { preload: stall.preload });
    const startedAt = Date.now();
    const endpoint = await waitForReady(run, consoleProcess.pid!);
    await openWorkload(run, endpoint, { terminal: false });
    const started = descendantsOf(consoleProcess.pid!);
    await provableByStartTime(startedAt);

    const stop = await runStop({ ...run.env, PATH: [slowProcessTable(run, 600), run.env.PATH].join(":") });
    const exit = await exitOf(consoleProcess, 30_000);

    expect(fs.existsSync(stall.marker), "the injected stall must hold the shutdown with the lock held").toBe(true);
    expect(exit.signal, "the Console must end by its own deadline in this case").toBeNull();
    expect(exit.code).not.toBe(0);
    expect(await survivors(run, started)).toEqual([]);
    lifecycleCheck("L9", stop.status !== 0, "stop does not report a deadline-ended Console as cleanly stopped", { detail: { status: stop.status, stdout: stop.stdout.trim() } });
  }, 90_000);

  // L8, N1 (storage integrity). `fleet console start` gives up on a Console that holds the lock but is still starting (its
  // durable restore can outlast start's 60s). That Console may be mid-write; it must get its own deadline to stop instead of
  // a SIGKILL right after SIGTERM.
  it("lets a starting Console that holds the lock stop by itself when start gives up on it", async () => {
    const run = createRun("starting");
    const marker = path.join(run.dir, "starting-stalled");
    const exited = path.join(run.dir, "exited");
    const preload = writePreload(run, "stall-start.mjs", [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      `const lock = ${JSON.stringify(run.lockFile)}, marker = ${JSON.stringify(marker)}, exited = ${JSON.stringify(exited)};`,
      `if (process.argv[1] === ${JSON.stringify(cliDist)} && process.argv[2] === 'serve') {`,
      "  process.on('exit', (code) => fs.writeFileSync(exited, String(code)));",
      "  const mkdir = fs.promises.mkdir;",
      "  const ownsLock = () => { try { return JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid; } catch { return false; } };",
      // Startup stands still at its first asynchronous directory creation after this Console published its lock, whatever
      // that step is: the Console holds the lock and stays starting, as a long durable restore would leave it.
      "  fs.promises.mkdir = function (target, ...rest) {",
      "    if (ownsLock()) { fs.writeFileSync(marker, ''); return new Promise(() => {}); }",
      "    return mkdir.call(this, target, ...rest);",
      "  };",
      "  syncBuiltinESMExports();",
      "}",
    ]);
    const start = await runCli(["start"], { ...run.env, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` }, 120_000);
    const lockPid = readRunLock(run)?.pid;
    // start가 detached로 띄운 Console이다. 기다리기 전에 등록해야 start보다 오래 사는 Console도 afterEach가 거둔다.
    if (lockPid !== undefined) own(lockPid);
    if (lockPid !== undefined) await waitUntil(() => !isAlive(lockPid), 20_000, "the starting Console outlived start's cleanup");

    expect(fs.existsSync(marker), "the Console must hold the lock and still be starting when start gives up").toBe(true);
    expect(start.status).not.toBe(0);
    lifecycleCheck("L8", fs.existsSync(exited), "start does not SIGKILL a lock-holding starting Console before it can stop by itself");
  }, 150_000);

  // L5, d48e62ac (I2; L3 and I1 as guards). An uncaught exception while serving ends the Console at once; the next Console
  // must find the slot usable, nothing the crashed one started may still run, and whatever reaps it stays inside its tree.
  it("leaves no process behind and a reclaimable lock after a crash while serving", async () => {
    const run = createRun("crash");
    const preload = writePreload(run, "crash.mjs", [
      "process.on('SIGUSR2', () => setImmediate(() => { throw new Error('lifecycle suite injected crash'); }));",
    ]);
    const group = spawnGroup(run, { preload });
    const consolePid = await group.consolePid;
    const endpoint = await waitForReady(run, consolePid);
    await openWorkload(run, endpoint, { terminal: true });
    const started = descendantsOf(consolePid);

    process.kill(consolePid, "SIGUSR2");
    const exit = await group.consoleExit(10_000);
    expect(exit.code, "the injected exception must end the Console").not.toBe(0);
    const next = spawnConsole(run);
    await waitForReady(run, next.pid!);

    lifecycleCheck("L3", readRunLock(run)?.pid === next.pid, "I5: the next Console owns the lock");
    const left = await survivors(run, started);
    lifecycleCheck("L5", left.length === 0, "I2: nothing the crashed Console started outlives it", { detail: { survivors: left, failureLog: failureKinds(run) } });
    lifecycleCheck("I1", group.outsidersUntouched(), "the Console's parent and sibling in its process group are never signalled", { detail: group.outsiders() });
  }, 60_000);

  // L6, X1 (I2; L3, L10 E1 and I1). Nothing runs inside a SIGKILLed Console, so containment and the next Console cover it.
  // The killed Console reached its slot through a symlinked parent (as /var reaches /private/var on macOS) and the next one
  // through the real path: both spellings name one slot, so the killed Console's leftovers are the next one's to reclaim.
  it("leaves no process behind and reclaims the lock and leftovers after an external SIGKILL", async () => {
    const run = createRun("sigkill");
    const linked = path.join(run.dir, "linked-root");
    fs.symlinkSync(run.root, linked, "dir");
    const group = spawnGroup(run, { env: { FLEET_DATA_DIR: linked, FLEET_CONSOLE_DATA_DIR: path.join(linked, "console") } });
    const consolePid = await group.consolePid;
    const endpoint = await waitForReady(run, consolePid);
    const attachment = await uploadAttachment(run, endpoint);
    await openWorkload(run, endpoint, { terminal: true });
    const started = descendantsOf(consolePid);

    process.kill(consolePid, "SIGKILL");
    await group.consoleExit(5_000);
    const next = spawnConsole(run);
    await waitForReady(run, next.pid!);

    lifecycleCheck("L3", readRunLock(run)?.pid === next.pid, "I5: the next Console owns the lock");
    const left = await survivors(run, started);
    lifecycleCheck("L6", left.length === 0, "I2: nothing the killed Console started outlives it", { detail: { survivors: left, failureLog: failureKinds(run) } });
    const leftovers = attachment.filter((file) => fs.existsSync(file));
    lifecycleCheck("L10", leftovers.length === 0, "I5: the next Console reclaims the killed Console's attachments whatever the slot's spelling", { detail: leftovers });
    lifecycleCheck("I1", group.outsidersUntouched(), "the Console's parent and sibling in its process group are never signalled", { detail: group.outsiders() });
  }, 60_000);

  // L2 over real processes and L10 E2. A second Console that loses the lock exits without touching anything except its
  // `lock_held` entry in the failure log (docs/console-lock-reclaim.md, the one documented exception). When lock exclusivity
  // is broken anyway (the lock file removed by hand, or by a legacy shell), the Console that then wins may reclaim only what a
  // dead Console left: the attachments of a Console that is still serving are not leftovers.
  it("never lets another Console write or remove what a live Console owns", async () => {
    const run = createRun("exclusive");
    const owner = spawnConsole(run);
    const endpoint = await waitForReady(run, owner.pid!);
    const attachment = await uploadAttachment(run, endpoint);
    await openWorkload(run, endpoint, { terminal: false });
    await delay(1_000);
    const before = snapshotFiles(run.root);

    const loser = spawnConsole(run);
    const loserExit = await exitOf(loser, 20_000);

    expect(loserExit).toEqual({ code: CONSOLE_SERVE_EXIT_LOCK_HELD, signal: null });
    const changed = diffSnapshots(before, snapshotFiles(run.root));
    lifecycleCheck("L2", changed.length === 0, "I3: the lock loser changes nothing under the data root", { detail: changed });
    lifecycleCheck("L2", attachment.every((file) => fs.existsSync(file)), "I3: the lock loser removes no attachment of the owner");

    fs.rmSync(run.lockFile);
    const winner = spawnConsole(run);
    await waitForReady(run, winner.pid!);

    expect(isAlive(owner.pid!)).toBe(true);
    lifecycleCheck("L10", attachment.every((file) => fs.existsSync(file)), "the attachments of a Console still serving are never reclaimed");
  }, 60_000);
});

/**
 * Asserts one invariant of a lifecycle case. While the case is a listed known defect (and the ratchet is on), a signature
 * check asserts the defect instead and any other check of that case is left unasserted.
 */
function lifecycleCheck(caseId: string, holds: boolean, invariant: string, options: { readonly detail?: unknown; readonly signature?: boolean } = {}): void {
  const detail = options.detail === undefined ? "" : `: ${JSON.stringify(options.detail)}`;
  const known = LIFECYCLE_KNOWN_DEFECTS.find((entry) => entry.case === caseId);
  if (known && process.env.FLEET_LIFECYCLE_RATCHET !== "off") {
    if (options.signature === false) return;
    expect.soft(holds, `known defect ${known.followup} (${caseId}) no longer reproduces: "${invariant}" holds; ${known.releasedBy} removes its entry from lifecycle-known-defects.json${detail}`).toBe(false);
  } else {
    expect.soft(holds, `${caseId}${known ? ` (${known.followup})` : ""}: ${invariant}${detail}`).toBe(true);
  }
}

function createRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ROOTS.push(root);
  return root;
}

function isolatedEnv(root: string, slot: string): NodeJS.ProcessEnv {
  // 실행 중인 Console에서 상속한 FLEET_*(resume port, legacy dir 등)가 격리된 serve로 새지 않게 모두 걷어 낸다.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FLEET_") && key !== "INIT_CWD"));
  env.FLEET_DATA_DIR = root;
  env.FLEET_CONSOLE_DATA_DIR = slot;
  return env;
}

function spawnServe(preload: string, root: string, slot: string): ChildProcess {
  // --import takes a module specifier: a bare Windows path (C:\...) reads as a "c:" URL scheme and Node exits.
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, cliDist, "serve"], { env: isolatedEnv(root, slot), stdio: "ignore" });
  SERVES.add(child);
  return child;
}

// lock은 writer 소유권이지 readiness가 아니다. 실제 health가 준비될 때까지 같은 예산 안에서 기다린다.
async function waitForHealthyConsole(lockFile: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { endpoint: string; token: string };
      const response = await fetch(new URL("/api/v1/health", lock.endpoint), {
        headers: { authorization: `Bearer ${lock.token}` },
        signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))),
      });
      if (response.ok) return response;
    } catch { /* lock 공개와 listener 준비를 기다린다. */ }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`Console did not become healthy within ${timeoutMs}ms`);
}

async function waitForFileGone(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`${path.basename(file)} was still present after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`${path.basename(file)} did not appear within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface LifecycleRun {
  readonly dir: string;
  readonly root: string;
  readonly lockFile: string;
  readonly tmp: string;
  readonly agentDir: string;
  readonly theater: string;
  readonly env: Record<string, string> & { readonly PATH: string };
}

/**
 * One isolated lifecycle run. Fleet data lives in the checkout's isolated root (docs/fleet-development-reference.md, Isolated
 * Development Data) and TMPDIR outside the checkout. The child environment is built from nothing, never inherited, so a
 * Console that launched this suite cannot lend it its slot, resume port or child-session marker.
 */
function createRun(name: string): LifecycleRun {
  const base = path.join(repoRoot, ".fleet", "isolated", "lifecycle");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `${name}-`));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-lifecycle-${name}-`));
  const root = path.join(dir, "root");
  const agentDir = path.join(dir, "agent");
  // A Theater inside the checkout would be read as part of this repository's git tree.
  const theater = path.join(tmp, "theater");
  const pathbin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const run: LifecycleRun = {
    dir,
    root,
    lockFile: path.join(root, "console", "console.lock"),
    tmp,
    agentDir,
    theater,
    env: {
      HOME: home,
      TMPDIR: tmp,
      PATH: [pathbin, ...SYSTEM_PATH].join(":"),
      USER: os.userInfo().username,
      LOGNAME: os.userInfo().username,
      LANG: "en_US.UTF-8",
      SHELL: "/bin/sh",
      TERM: "xterm-256color",
      FLEET_DATA_DIR: root,
      FLEET_CONSOLE_DATA_DIR: path.join(root, "console"),
      FLEET_DESKTOP_DATA_DIR: path.join(dir, "desktop"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_BIN: FAKE_AGENT,
      FAKE_AGENT_DIR: agentDir,
    },
  };
  RUNS.push(run);
  const relative = path.relative(fs.realpathSync(repoRoot), fs.realpathSync(tmp));
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("TMPDIR must stay outside the checkout");
  for (const target of [root, home, agentDir, theater, pathbin]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  // The agent stand-in is a `#!/usr/bin/env node` script: only this Node goes on PATH, never a directory of real CLIs.
  fs.symlinkSync(process.execPath, path.join(pathbin, "node"));
  return run;
}

function spawnConsole(run: LifecycleRun, options: { readonly preload?: string } = {}): ChildProcess {
  const args = [...(options.preload ? ["--import", pathToFileURL(options.preload).href] : []), cliDist, "serve"];
  // Detached like `fleet console start`: the Console leads its own process group.
  const child = spawn(process.execPath, args, { env: run.env, stdio: "ignore", detached: true });
  own(child.pid!);
  return child;
}

/**
 * A parent that is not the test runner starts the Console without detaching it, so the Console shares that parent's process
 * group the way a Desktop sidecar shares Desktop's, next to a sibling that has nothing to do with it. Both record every
 * catchable signal they receive, so a stray signal from any sender (stop, the Console's deadline, a reaper) shows.
 */
function spawnGroup(run: LifecycleRun, options: { readonly preload?: string; readonly env?: Record<string, string> }) {
  const signals = path.join(run.dir, "outsider-signals");
  const report = path.join(run.dir, "group.json");
  const launcher = path.join(run.dir, "group-parent.mjs");
  const catchable = ["SIGTERM", "SIGINT", "SIGHUP", "SIGUSR1", "SIGUSR2", "SIGQUIT"];
  const sibling = `for (const s of ${JSON.stringify(catchable)}) process.on(s, () => require('fs').appendFileSync(${JSON.stringify(signals)}, 'sibling ' + s + '\\n')); setInterval(() => {}, 1 << 30);`;
  const consoleArgs = [...(options.preload ? ["--import", pathToFileURL(options.preload).href] : []), cliDist, "serve"];
  fs.writeFileSync(launcher, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    `const signals = ${JSON.stringify(signals)}, report = ${JSON.stringify(report)};`,
    `for (const signal of ${JSON.stringify(catchable)}) process.on(signal, () => fs.appendFileSync(signals, 'parent ' + signal + '\\n'));`,
    `const sibling = spawn(process.execPath, ['-e', ${JSON.stringify(sibling)}], { stdio: 'ignore' });`,
    `const child = spawn(process.execPath, ${JSON.stringify(consoleArgs)}, { stdio: 'ignore', env: { ...process.env, ...${JSON.stringify(options.env ?? {})} } });`,
    "const state = { parent: process.pid, sibling: sibling.pid, console: child.pid, exit: null };",
    "fs.writeFileSync(report, JSON.stringify(state));",
    "child.once('exit', (code, signal) => { state.exit = { code, signal }; fs.writeFileSync(report, JSON.stringify(state)); });",
    "setInterval(() => {}, 1 << 30);",
  ].join("\n"));
  const parent = spawn(process.execPath, [launcher], { env: run.env, stdio: "ignore", detached: true });
  own(parent.pid!);
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(report, "utf8")) as { parent: number; sibling: number; console: number; exit: { code: number | null; signal: NodeJS.Signals | null } | null };
    } catch {
      return null;
    }
  };
  const outsiders = () => {
    const state = read()!;
    const received = fs.existsSync(signals) ? fs.readFileSync(signals, "utf8").trim().split("\n").filter(Boolean) : [];
    return { parentAlive: isAlive(state.parent), siblingAlive: isAlive(state.sibling), received };
  };
  return {
    consolePid: (async () => {
      await waitUntil(() => read() !== null, 10_000, "the group parent did not start");
      const state = read()!;
      own(state.sibling);
      own(state.console);
      return state.console;
    })(),
    async consoleExit(timeoutMs: number) {
      await waitUntil(() => read()?.exit != null, timeoutMs, "the Console did not exit");
      return read()!.exit!;
    },
    outsiders,
    outsidersUntouched() {
      const state = outsiders();
      return state.parentAlive && state.siblingAlive && state.received.length === 0;
    },
  };
}

function writePreload(run: LifecycleRun, name: string, lines: readonly string[]): string {
  const file = path.join(run.dir, name);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/**
 * Test-only preload: closing the main listener never completes, so the shutdown stalls while the lock is still held.
 * `freezeOnSignalMs` also blocks the event loop that long when the first SIGTERM arrives, before the Console handles it.
 * `freezeBeforeDeadline` blocks it for FREEZE_BEFORE_DEADLINE_MS starting 200ms before the Console's own stop deadline, so the
 * deadline's cleanup runs late while its process-table read keeps the full budget.
 */
function stallShutdownWithLockHeld(run: LifecycleRun, options: { readonly freezeOnSignalMs?: number; readonly freezeBeforeDeadline?: boolean } = {}): { readonly preload: string; readonly marker: string } {
  const marker = path.join(run.dir, "stalled");
  const preload = writePreload(run, "stall-close.mjs", [
    "import fs from 'node:fs';",
    "import http from 'node:http';",
    `const lock = ${JSON.stringify(run.lockFile)}, marker = ${JSON.stringify(marker)};`,
    ...(options.freezeOnSignalMs ? [`process.prependOnceListener('SIGTERM', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${options.freezeOnSignalMs}));`] : []),
    ...(options.freezeBeforeDeadline ? [`process.prependOnceListener('SIGTERM', () => setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${FREEZE_BEFORE_DEADLINE_MS}), ${CONSOLE_STOP_DEADLINE_MS - 200}).unref());`] : []),
    "const close = http.Server.prototype.close;",
    "http.Server.prototype.close = function (callback) {",
    "  let port = null;",
    "  try { port = JSON.parse(fs.readFileSync(lock, 'utf8')).port; } catch {}",
    "  const address = this.address();",
    "  if (port !== null && address && typeof address === 'object' && address.port === port) { fs.writeFileSync(marker, ''); return this; }",
    "  return close.call(this, callback);",
    "};",
  ]);
  return { preload, marker };
}

/** The failure kinds the run's Console recorded (errors.jsonl), to tell why an I2 case left a process behind. */
function failureKinds(run: LifecycleRun): string[] {
  try {
    return fs.readFileSync(path.join(run.root, "console", "errors.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => {
      try { return String((JSON.parse(line) as { kind?: unknown }).kind); } catch { return "unreadable"; }
    });
  } catch {
    return [];
  }
}

/** A `ps` that answers after `delayMs`, put on one process's PATH only: its process-table read is slow, nobody else's. */
function slowProcessTable(run: LifecycleRun, delayMs: number): string {
  const dir = path.join(run.dir, `slow-ps-${delayMs}`);
  fs.mkdirSync(dir, { recursive: true });
  const realPs = SYSTEM_PATH.map((entry) => path.join(entry, "ps")).find((candidate) => fs.existsSync(candidate));
  if (!realPs) throw new Error("ps is not on the system PATH");
  fs.writeFileSync(path.join(dir, "ps"), `#!/bin/sh\nsleep ${delayMs / 1000}\nexec ${realPs} "$@"\n`, { mode: 0o755 });
  return dir;
}

/**
 * Runs a `fleet console` command without blocking this process: a Console this test spawned must be reaped here as soon as
 * it exits, or the command would keep seeing its zombie as a live pid.
 */
async function runCli(args: readonly string[], env: Record<string, string>, timeoutMs = 60_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliDist, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  own(child.pid!);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const exit = await exitOf(child, timeoutMs);
  return { status: exit.code, stdout, stderr };
}

async function runStop(env: Record<string, string>): ReturnType<typeof runCli> {
  return await runCli(["stop"], env);
}

/** `fleet console stop` proves a Console by its start time only once the Console has run for 2s. */
async function provableByStartTime(startedAt: number): Promise<void> {
  await delay(Math.max(0, startedAt + 2_500 - Date.now()));
}

function readRunLock(run: LifecycleRun): { pid: number; endpoint: string; token: string } | null {
  try {
    return JSON.parse(fs.readFileSync(run.lockFile, "utf8"));
  } catch {
    return null;
  }
}

async function waitForReady(run: LifecycleRun, pid: number, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = readRunLock(run);
    if (lock?.pid === pid) {
      try {
        const response = await fetch(new URL("api/v1/health", lock.endpoint), { headers: { authorization: `Bearer ${lock.token}` }, signal: AbortSignal.timeout(1_000) });
        if (response.ok) return lock.endpoint;
      } catch { /* Listener not up yet. */ }
    }
    if (!isAlive(pid)) throw new Error(`Console ${pid} exited before it became ready`);
    await delay(50);
  }
  throw new Error(`Console ${pid} did not become ready within ${timeoutMs}ms`);
}

async function consoleApi<T>(endpoint: string, route: string, body: unknown, contentType = "application/json"): Promise<T> {
  const response = await fetch(new URL(route, endpoint), {
    method: "POST",
    headers: { origin: new URL(endpoint).origin, "content-type": contentType },
    body: body instanceof Blob ? body : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${route}: ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

/** An open chat turn (agent mid-turn, MCP child running) and optionally a terminal session, through the public API. */
async function openWorkload(run: LifecycleRun, endpoint: string, options: { readonly terminal: boolean }): Promise<void> {
  const grant = await consoleApi<{ folderGrantId?: string; id?: string; grant?: { id: string } }>(endpoint, "/api/v1/theaters/folder-grants", { path: run.theater });
  const theater = await consoleApi<{ id?: string; theater?: { id: string } }>(endpoint, "/api/v1/theaters", { folderGrantId: grant.folderGrantId ?? grant.grant?.id ?? grant.id });
  const theaterId = theater.id ?? theater.theater?.id;
  const count = (role: string) => agentProcs(run).filter((entry) => entry.role === role).length;
  const turns = count("turn-open");
  await consoleApi(endpoint, "/api/v1/agent/sessions", { theaterId, cliId: "claude", viewMode: "chat", prompt: "lifecycle suite open turn" });
  await waitUntil(() => count("turn-open") > turns, 20_000, "the chat turn did not open");
  if (options.terminal) {
    const terminals = count("terminal");
    await consoleApi(endpoint, "/api/v1/agent/sessions", { theaterId, cliId: "claude" });
    await waitUntil(() => count("terminal") > terminals, 20_000, "the terminal did not start");
  }
}

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** Uploads a Quick Launch attachment and returns the files it added under TMPDIR, wherever the Console keeps them. */
async function uploadAttachment(run: LifecycleRun, endpoint: string): Promise<string[]> {
  const before = new Set(listFiles(run.tmp));
  await consoleApi(endpoint, "/api/v1/agent/attachments", new Blob([new Uint8Array(ONE_PIXEL_PNG)]), "image/png");
  const added = listFiles(run.tmp).filter((file) => !before.has(file));
  expect(added.length, "the upload must leave a file under TMPDIR").toBeGreaterThan(0);
  return added;
}

function agentProcs(run: LifecycleRun): Array<{ role: string; pid: number; at?: number }> {
  try {
    return fs.readFileSync(path.join(run.agentDir, "procs.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Records a process this suite started or observed, with the start time that later proves it is still the same one. */
function own(pid: number): void {
  const startedAt = processStartTime(pid);
  if (startedAt !== null && !OWNED.has(pid)) OWNED.set(pid, startedAt);
}

/**
 * Owns a pid the agent stand-in recorded at its spawn only while the process holding it started when the record was written:
 * a pid that died before it was first observed may name someone else's process by now. Such a pid is never signalled, but
 * the mismatch fails the case once cleanup is done, so a missed or wrong record cannot hide a survivor.
 */
function ownRecorded(entry: { readonly pid: number; readonly at?: number }): void {
  const startedAt = processStartTime(entry.pid);
  if (startedAt === null || OWNED.has(entry.pid)) return;
  // lstart has one-second resolution and the record follows the start by a process boot at most.
  if (entry.at !== undefined && Math.abs(entry.at - Date.parse(startedAt)) <= 2_000) OWNED.set(entry.pid, startedAt);
  else UNPROVEN_RECORDS.push(`pid ${entry.pid} recorded at ${entry.at === undefined ? "an unknown time" : new Date(entry.at).toISOString()}, live process started ${startedAt}`);
}

function processStartTime(pid: number): string | null {
  // The C locale keeps lstart in the one format Date.parse reads.
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

/** Every live descendant of `pid` now, whatever started it (agents, their MCP children, PTYs, helpers). */
function descendantsOf(pid: number): Array<{ readonly pid: number; readonly startedAt: string; readonly command: string }> {
  const table = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const [child, ppid] of table) {
      if (child !== undefined && ppid === parent && !found.includes(child)) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found.flatMap((child) => {
    const startedAt = processStartTime(child);
    if (startedAt === null) return [];
    own(child);
    return [{ pid: child, startedAt, command: path.basename(commandOf(child).trim().split(/\s+/)[0] ?? "") }];
  });
}

/**
 * What is still running, once SETTLE_MS has passed (or as soon as nothing is), of the Console's descendants observed before it
 * ended and of every agent the stand-in recorded. Agents are named by role, anything else by its executable.
 */
async function survivors(run: LifecycleRun, started: ReturnType<typeof descendantsOf>): Promise<string[]> {
  const roles = new Map(agentProcs(run).filter((entry) => AGENT_ROLES.has(entry.role)).map((entry) => [entry.pid, entry.role] as const));
  for (const entry of agentProcs(run)) if (AGENT_ROLES.has(entry.role)) ownRecorded(entry);
  const watched = new Map<number, { readonly startedAt: string | null; readonly name: string }>();
  for (const entry of started) watched.set(entry.pid, { startedAt: entry.startedAt, name: roles.get(entry.pid) ?? entry.command });
  for (const [pid, role] of roles) if (!watched.has(pid)) watched.set(pid, { startedAt: OWNED.get(pid) ?? null, name: role });
  const running = () => [...watched].filter(([pid, entry]) => entry.startedAt !== null && processStartTime(pid) === entry.startedAt);
  const deadline = Date.now() + SETTLE_MS;
  let left = running();
  while (left.length > 0 && Date.now() < deadline) {
    await delay(100);
    left = running();
  }
  return left.map(([, entry]) => entry.name).sort();
}

/** Every file under the data root by content, except the append-only failure log a lock loser may write to. */
function snapshotFiles(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const file of listFiles(root)) {
    if (path.basename(file) !== CONSOLE_FAILURE_LOG_FILE) entries.set(path.relative(root, file), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  }
  return entries;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [file, hash] of before) if (after.get(file) !== hash) changed.push(after.has(file) ? `changed ${file}` : `removed ${file}`);
  for (const file of after.keys()) if (!before.has(file)) changed.push(`added ${file}`);
  return changed.sort();
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
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

function isAlive(pid: number): boolean {
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
