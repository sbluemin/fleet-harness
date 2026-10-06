import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { REAPER_DRAIN_MAX_MS, captureProvenProcessStart, createConsoleHealthClient, deliverConsoleStop, observeConsoleInstance, reproveConsoleInstance, runStopLadder } from "@fleet-console/lifecycle";
import { CONSOLE_SERVE_EXIT_LOCK_HELD, CONSOLE_STOP_DEADLINE_MS, CONSOLE_STOP_REQUEST_REVISION, ESCALATION_MARGIN_MS, HEALTH_PROBE_TIMEOUT_MS, OWNED_GROUP_TERM_GRACE_MS, PROCESS_TABLE_TIMEOUT_MS, consoleExitRecordPath, parseConsoleExitRecord } from "@fleet-console/protocol/lifecycle";

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
  // A killed Console's reaper records how it ended under the root: take its helpers (proved by start time) before the kill
  // and let them finish before the root is removed.
  const helpers: Array<readonly [number, string]> = [];
  await Promise.all([...SERVES].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    for (const entry of descendantsOf(child.pid!)) helpers.push([entry.pid, entry.startedAt]);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  }));
  SERVES.clear();
  const deadline = Date.now() + REAPER_DRAIN_MAX_MS + 1_000;
  for (const [pid, startedAt] of helpers) {
    while (processStartTime(pid) === startedAt && Date.now() < deadline) await delay(25);
    if (processStartTime(pid) === startedAt) try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
  for (const root of ROOTS.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
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
const AGENT_ROLES = new Set(["chat", "chat-mcp", "chat-orphan", "chat-detached", "chat-residual", "terminal", "terminal-mcp"]);
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
  // A Console's reaper reacts to its Console's end: take whatever the owned processes started (proved the same way) before
  // they are killed, so nothing still writes into a run directory while it is removed.
  for (const [pid, startedAt] of [...OWNED]) if (processStartTime(pid) === startedAt) for (const entry of descendantsOf(pid)) own(entry.pid);
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
  for (const run of runs) for (const dir of [run.dir, run.tmp]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  if (left.length > 0) throw new Error(`lifecycle processes survived SIGKILL: ${left.join("; ")}`);
  if (unproven.length > 0) throw new Error(`agent records that no live process proves (not signalled): ${unproven.join("; ")}`);
});

// POSIX signal cases stay skipped on Windows: TerminateProcess runs no shutdown. The Windows cases below are the
// containment contract (a job per owned group) and run only on win32. Both halves share this block's cleanup.
(runBuiltSmoke ? describe : describe.skip)("Console process lifecycle invariants", () => {
  // I2 main path: `fleet console stop` while an agent is mid-turn and ignores SIGTERM. The Console must account for that
  // agent and everything else it started before it is gone, although stop returns as soon as the lock is released.
  it.skipIf(process.platform === "win32")("stops with an agent mid-turn and leaves no process behind", async () => {
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
  it.skipIf(process.platform === "win32")("finishes its shutdown and leaves no process behind when SIGTERM and SIGINT arrive again mid-cleanup and after the lock is released", async () => {
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
  it.skipIf(process.platform === "win32")("lets the Console's own shutdown deadline finish before stop escalates", async () => {
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
    const timeline = deadlineTimeline(run, stall.freeze);
    // Printed on every run so CI logs show how much of the escalation margin the deadline actually used.
    console.info(`L4c timeline ${JSON.stringify(timeline)}`);
    lifecycleCheck("L4c", exit.signal !== "SIGKILL", "I4: stop does not SIGKILL the Console before its own deadline ends it", { detail: { exit, timeline } });
    const left = await survivors(run, started);
    lifecycleCheck("L4c", left.length === 0, "I2: nothing the Console started outlives it", { detail: { survivors: left, failureLog: failureKinds(run), timeline }, signature: false });
    lifecycleCheck("I1", group.outsidersUntouched(), "the Console's parent and sibling in its process group are never signalled", { detail: group.outsiders() });
  }, 90_000);

  // L12, the residual risk of the escalation budget (I2 only; I4 is broken on purpose). The Console's event loop is blocked
  // for 2.5s when the stop signal arrives, so its own deadline lands after any external escalation: whatever kills the
  // Console then, nothing it started may outlive it.
  it.skipIf(process.platform === "win32")("leaves no process behind when stop has to escalate past a Console stalled at the signal", async () => {
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

  // L14, e7874487:N8 (I4, I2). The shutdown stalls with the lock held and the Console's process-table read cannot answer
  // within its budget. The agent CLI ignores SIGTERM, so its group's leader is still this Console's child: the deadline must
  // end that group without the table, and stop must still let the deadline finish first.
  it.skipIf(process.platform === "win32")("ends a live agent group at the deadline without a process table", async () => {
    const run = createRun("no-ps");
    const stall = stallShutdownWithLockHeld(run);
    const consoleProcess = spawnConsole(run, { preload: stall.preload, env: { PATH: [hangingProcessTable(run), run.env.PATH].join(":") } });
    const startedAt = Date.now();
    const endpoint = await waitForReady(run, consoleProcess.pid!);
    await openWorkload(run, endpoint, { terminal: false });
    const started = descendantsOf(consoleProcess.pid!);
    await provableByStartTime(startedAt);

    await runStop(run.env);
    const exit = await exitOf(consoleProcess, 30_000);

    expect(fs.existsSync(stall.marker), "the injected stall must hold the shutdown with the lock held").toBe(true);
    lifecycleCheck("L14", exit.signal !== "SIGKILL", "I4: stop does not SIGKILL the Console before its own deadline ends it", { detail: exit });
    const left = await survivors(run, started);
    lifecycleCheck("L14", left.length === 0, "I2: nothing the Console started outlives it", { detail: { survivors: left, failureLog: failureKinds(run) } });
  }, 90_000);

  // L9, N4. The Console ends by its own deadline (stop's own process-table read is slow here, so stop never gets to
  // escalate); stop must not report that as a clean stop. The deadline also ends a hung child that no one registered in
  // the Console's process group and the member of a registered group whose leader already exited: nothing the Console
  // started may outlive it. Both need the Console's (slow) process table, which the deadline reads once, so it ends within
  // one table budget of its own and the external escalation keeps its margin.
  it.skipIf(process.platform === "win32")("reports a Console that ended by its own deadline as not cleanly stopped", async () => {
    const run = createRun("outcome");
    const stall = stallShutdownWithLockHeld(run, { strayChild: true, recordSignal: true });
    const psCalls = path.join(run.dir, "console-ps-calls");
    const consoleProcess = spawnConsole(run, { preload: stall.preload, env: { PATH: [slowProcessTable(run, 400, psCalls), run.env.PATH].join(":"), FAKE_AGENT_LEADER_EXITS: "1" } });
    const startedAt = Date.now();
    const endpoint = await waitForReady(run, consoleProcess.pid!);
    await openWorkload(run, endpoint, { terminal: false });
    const leader = agentProcs(run).find((entry) => entry.role === "chat")!;
    await waitUntil(() => !isAlive(leader.pid), 10_000, "the agent's group leader did not exit");
    const started = descendantsOf(consoleProcess.pid!);
    await provableByStartTime(startedAt);

    const readsBeforeStop = callsFrom(psCalls, consoleProcess.pid!);
    const stop = await runStop({ ...run.env, PATH: [slowProcessTable(run, 600), run.env.PATH].join(":") });
    const exit = await exitOf(consoleProcess, 30_000);
    // Only the Console's own calls: its reaper reads the same PATH once the Console is gone.
    const reads = callsFrom(psCalls, consoleProcess.pid!) - readsBeforeStop;
    const signalledAt = Number(fs.readFileSync(stall.signalled, "utf8"));
    const deadlineReads = callsFrom(psCalls, consoleProcess.pid!, signalledAt + CONSOLE_STOP_DEADLINE_MS);

    expect(fs.existsSync(stall.marker), "the injected stall must hold the shutdown with the lock held").toBe(true);
    expect(exit.signal, "the Console must end by its own deadline in this case").toBeNull();
    expect(exit.code).not.toBe(0);
    const left = await survivors(run, started);
    lifecycleCheck("L9", left.length === 0, "I2: nothing the Console started outlives it", { detail: { survivors: left, failureLog: failureKinds(run) } });
    const recordedMs = deadlineRecordedAfterSignal(run, stall.signalled);
    // 정지 grace 조회는 퇴역 등록 그룹당 1회이며, deadline 조회와 구분한다. deadline의 1회 예산은 완화하지 않는다.
    lifecycleCheck("L9", deadlineReads === 1, "I4: the stop deadline reads the process table once", { detail: { reads, deadlineReads } });
    lifecycleCheck("L9", recordedMs !== null && recordedMs <= CONSOLE_STOP_DEADLINE_MS + PROCESS_TABLE_TIMEOUT_MS + 100, "I4: the deadline spends one process-table budget at most", { detail: { recordedMs } });
    lifecycleCheck("L9", stop.status !== 0, "stop does not report a deadline-ended Console as cleanly stopped", { detail: { status: stop.status, stdout: stop.stdout.trim() } });
  }, 90_000);

  // L8, N1 (storage integrity). `fleet console start` gives up on a Console that holds the lock but is still starting (its
  // durable restore can outlast start's 60s). That Console may be mid-write; it must get its own deadline to stop instead of
  // a SIGKILL right after SIGTERM.
  it.skipIf(process.platform === "win32")("lets a starting Console that holds the lock stop by itself when start gives up on it", async () => {
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
  it.skipIf(process.platform === "win32")("leaves no process behind and a reclaimable lock after a crash while serving", async () => {
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
  it.skipIf(process.platform === "win32")("leaves no process behind and reclaims the lock and leftovers after an external SIGKILL", async () => {
    const run = createRun("sigkill");
    const linked = path.join(run.dir, "linked-root");
    fs.symlinkSync(run.root, linked, "dir");
    const group = spawnGroup(run, { env: { FLEET_DATA_DIR: linked, FLEET_CONSOLE_DATA_DIR: path.join(linked, "console") } });
    const consolePid = await group.consolePid;
    const endpoint = await waitForReady(run, consolePid);
    const attachment = await uploadAttachment(run, endpoint);
    await openWorkload(run, endpoint, { terminal: true });
    const pluginChildren = await openPluginChildren(run, endpoint);
    const started = [...descendantsOf(consolePid).filter((entry) => !pluginChildren.some((child) => child.pid === entry.pid)), ...pluginChildren];

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

  // L6n, e7874487:N9 (I2, I4; L6's plugin children on the normal stop path). The same hung Ledger children must not hold a
  // normal stop to the deadline: the single cleanup ends the plugins' registered groups after their grace — those whose
  // CLI ignores SIGTERM by E1, those whose CLI ended (on SIGTERM, or by itself before the stop) but left a helper holding
  // its pipes by one proving process-table read — so stop succeeds well inside B_int, the instance records `clean`, and
  // nothing it started outlives it.
  // 에이전트 helper도 리더가 SDK 종료로 사라진 뒤 파이프를 잡는다. 플러그인만의 stop으로 이 방어를 대체할 수 없다.
  it.skipIf(process.platform === "win32")("ends an agent residual and hung plugin children on a normal stop and reports clean", async () => {
    // claude-agent-sdk 0.3.269 close(): EOF grace 2000ms + 최종 SIGKILL까지 5000ms. 벤더 갱신 시 재측정한다.
    const sdkCloseMaxMs = 2_000 + 5_000;
    expect(Math.max(sdkCloseMaxMs, OWNED_GROUP_TERM_GRACE_MS) + PROCESS_TABLE_TIMEOUT_MS + ESCALATION_MARGIN_MS,
      "정지 grace는 SDK 종료와 겹쳐야 하고, 증명 조회와 스케줄링 여유까지 B_int 안에 들어야 한다").toBeLessThan(CONSOLE_STOP_DEADLINE_MS);
    const run = createRun("plugin-stop");
    run.env.FAKE_AGENT_SHUTDOWN_RESIDUAL = "1";
    const consoleProcess = spawnConsole(run);
    const startedAt = Date.now();
    const endpoint = await waitForReady(run, consoleProcess.pid!);
    await openWorkload(run, endpoint, { terminal: false });
    expect(agentProcs(run).some((entry) => entry.role === "chat-residual"), "에이전트 잔여 helper가 실행되어야 한다").toBe(true);
    const pluginChildren = await openPluginChildren(run, endpoint);
    const started = [...descendantsOf(consoleProcess.pid!).filter((entry) => !pluginChildren.some((child) => child.pid === entry.pid)), ...pluginChildren];
    await provableByStartTime(startedAt);

    const stoppedAt = Date.now();
    const stop = await runStop(run.env);
    const exit = await exitOf(consoleProcess, 30_000);
    const elapsedMs = Date.now() - stoppedAt;

    console.log(`L6n stop timing ${JSON.stringify({ outcome: exitOutcome(run, consoleProcess.pid!), elapsedMs, marginMs: CONSOLE_STOP_DEADLINE_MS - elapsedMs })}`);
    lifecycleCheck("L6n", stop.status === 0, "a normal stop with a hung plugin child is reported as stopped", { detail: { status: stop.status, stdout: stop.stdout.trim(), elapsedMs } });
    lifecycleCheck("L6n", exit.code === 0 && exit.signal === null && exitOutcome(run, consoleProcess.pid!) === "clean", "the Console ends by itself and records `clean`", { detail: { exit, outcome: exitOutcome(run, consoleProcess.pid!), failureLog: failureKinds(run) } });
    lifecycleCheck("L6n", elapsedMs < CONSOLE_STOP_DEADLINE_MS, "I4: the plugin child does not hold the stop to the deadline", { detail: { elapsedMs } });
    const left = await survivors(run, started);
    lifecycleCheck("L6n", left.length === 0, "I2: nothing the Console started outlives it", { detail: { survivors: left, failureLog: failureKinds(run) } });
  }, 60_000);

  // L2 over real processes and L10 E2. A second Console that loses the lock exits without touching anything except its
  // `lock_held` entry in the failure log (docs/console-lock-reclaim.md, the one documented exception). When lock exclusivity
  // is broken anyway (the lock file removed by hand, or by a legacy shell), the Console that then wins may reclaim only what a
  // dead Console left: the attachments of a Console that is still serving are not leftovers.
  it.skipIf(process.platform === "win32")("never lets another Console write or remove what a live Console owns", async () => {
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

  // N9-W2 DR-3: the Windows client path (token-authenticated stop request → delivered → clean) against a real
  // Console. The win32 platform is injected so this runs on any host; on Windows it is the real path. No workload:
  // the contract is the delivery (202 → exit record clean with stopReason request) with no signal sent and no
  // escalation. Requires built dist artifacts (FLEET_BUILT_SMOKE=1).
  it("delivers a token-authenticated stop request on the Windows client path and records clean without signals", async () => {
    const run = createRun("win-request-stop");
    const consoleProcess = spawnConsole(run);
    const endpoint = await waitForReady(run, consoleProcess.pid!);
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const lock = readRunLock(run)!;
    const startedAt = (JSON.parse(fs.readFileSync(run.lockFile, "utf8")) as { startedAt: number }).startedAt;

    const healthResponse = await fetch(new URL("api/v1/health", lock.endpoint), { headers: { authorization: `Bearer ${lock.token}` } });
    expect(healthResponse.status).toBe(200);
    const health = await healthResponse.json() as { stopRequest?: unknown };
    // A stale dist without the stop request route fails here instead of passing vacuously.
    expect(health.stopRequest).toBe(CONSOLE_STOP_REQUEST_REVISION);

    const target = { pid: lock.pid, endpoint: lock.endpoint, token: lock.token, startedAt };
    const healthClient = createConsoleHealthClient();
    const isHeld = (): boolean => {
      try {
        const current = JSON.parse(fs.readFileSync(run.lockFile, "utf8")) as { pid?: unknown; token?: unknown };
        return current.pid === lock.pid && current.token === lock.token;
      } catch {
        // A lock that cannot be read counts as held: never act on what cannot be proven.
        return true;
      }
    };
    const observeLock = (again: typeof target) => observeConsoleInstance({
      lock: again,
      trusted: true,
      isHeld,
      probe: (probeTarget, options) => healthClient.probe(probeTarget, options),
      env: run.env,
    });
    const provenStart = await captureProvenProcessStart(lock.pid, Date.now(), run.env);
    const route = await deliverConsoleStop({
      lock: target,
      stopRequest: health.stopRequest,
      timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
      platform: "win32",
      observe: () => observeLock(target).then((observation) => observation.state),
    });
    expect(route).toBe("delivered");

    const signals: NodeJS.Signals[] = [];
    const stoppedAt = Date.now();
    const ended = await runStopLadder({
      request: route,
      isAlive: () => isAlive(lock.pid),
      isReleased: () => !isHeld(),
      reprove: () => reproveConsoleInstance({ lockFile: run.lockFile, lock: target, provenStart, observe: observeLock, env: run.env }),
      signal: (signal) => {
        signals.push(signal);
        try {
          process.kill(lock.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      },
    });
    const elapsedMs = Date.now() - stoppedAt;

    const exit = await exitOf(consoleProcess, 30_000);
    expect(signals, "the delivered request sends no signal and never escalates").toEqual([]);
    expect(ended).toBe("exited");
    expect(exit).toEqual({ code: 0, signal: null });
    expect(elapsedMs).toBeLessThan(CONSOLE_STOP_DEADLINE_MS);
    const record = parseConsoleExitRecord(fs.readFileSync(consoleExitRecordPath(run.lockFile, { pid: lock.pid, lockStartedAt: startedAt }), "utf8"));
    expect(record?.outcome).toBe("clean");
    expect(record?.stopReason).toBe("request");
  }, 90_000);

  // W1/W5: 에이전트와 멈춘 플러그인을 함께 정지한다. 플러그인의 detached·native 손자와 에이전트 잔여가
  // B_int 안에 사라지고 clean을 기록해야 한다. 첫 spawn 전 direct breakaway는 error 5로 거부돼야 하고,
  // spawn 뒤 내부 libuv Job을 벗어나는 호출이 성공하면 장기 생존 자식이 stop과 함께 종료돼야 한다.
  // Start-Process는 headless runner 한계로 필수 역할에서 제외한다(계약의 powershell-intermediate 잔류).
  // N9-W2: 외부 CLI stop이 토큰 인증 정지 요청으로 cleanup을 실행하므로 실제 dist/cli.mjs stop으로 멈춘다.
  it.skipIf(process.platform !== "win32")("ends a hung plugin child's grandchildren on an external stop and denies breakaway", async () => {
    const run = createRun("win-plugin-stop");
    const breakawayFile = path.join(run.dir, "breakaway.json");
    const pluginBreakawayFile = path.join(run.dir, "plugin-breakaway.json");
    run.env.LEDGER_WINDOWS_GRANDCHILDREN = "1";
    run.env.LEDGER_BREAKAWAY_RESULT = pluginBreakawayFile;
    run.env.FAKE_AGENT_SHUTDOWN_RESIDUAL = "1";
    run.env.FAKE_AGENT_BREAKAWAY_RESULT = breakawayFile;
    run.env.FAKE_AGENT_KOFFI = createRequire(fileURLToPath(import.meta.url)).resolve("koffi");
    const consoleProcess = spawnConsole(run);
    const endpoint = await waitForReady(run, consoleProcess.pid!);
    await openWorkload(run, endpoint, { terminal: false });
    expect(agentProcs(run).some((entry) => entry.role === "chat-residual"), "에이전트 잔여 helper가 실행되어야 한다").toBe(true);
    const pluginChildren = await openPluginChildren(run, endpoint);
    const started = [...pluginChildren, ...descendantsOf(consoleProcess.pid!)];
    type PluginBreakawayAttempt = { phase: string; nonDetachedSpawns: number; ok: boolean; err: number; pid: number; callerPid: number };
    const pluginBreakaway = JSON.parse(fs.readFileSync(pluginBreakawayFile, "utf8")) as { beforeSpawn: PluginBreakawayAttempt; afterSpawn: PluginBreakawayAttempt };
    const before = pluginBreakaway.beforeSpawn;
    const after = pluginBreakaway.afterSpawn;
    expect(before.phase).toBe("before-non-detached-spawn");
    expect(before.nonDetachedSpawns, "직접 게이트 전에 non-detached 자식을 띄우면 안 된다").toBe(0);
    expect(before.ok, `직접 호출은 거부돼야 한다: ${JSON.stringify(before)}`).toBe(false);
    expect(before.err, "직접 호출은 ACCESS_DENIED여야 한다").toBe(5);
    expect(after.phase).toBe("after-non-detached-spawn");
    expect(after.nonDetachedSpawns, "후속 게이트 전에 실제 non-detached 자식이 실행돼야 한다").toBeGreaterThan(0);
    expect(after.callerPid, "두 경로는 동일한 플러그인 리더에서 실행돼야 한다").toBe(before.callerPid);
    expect(typeof after.ok).toBe("boolean");
    // libuv 내부 Job에서의 breakaway는 허용되지만 G는 벗어나지 못한다. run 37404900488의 explicit-G
    // 일회성 증거와 Node v22 uv__init_global_job_handle이 근거다. Commodore 결정 C는 G 소속 영구 조회를
    // 이 증거로 갈음하고, 사용자 보장인 stop 뒤 고아 0을 행동으로 단언한다. 향후 API가 거부하면 err=5만 허용한다.
    let pluginBreakawayStartedAt: string | null = null;
    if (after.ok) {
      expect(after.ok).toBe(true);
      expect(after.err).toBe(0);
      expect(after.pid, "성공한 호출은 실제 자식 pid를 반환해야 한다").toBeGreaterThan(0);
      pluginBreakawayStartedAt = processStartTime(after.pid);
      expect(pluginBreakawayStartedAt, "성공한 breakaway 자식은 stop 전 실제로 살아 있어야 한다").not.toBeNull();
      own(after.pid);
      started.push({ pid: after.pid, startedAt: pluginBreakawayStartedAt!, command: "plugin-breakaway-child" });
    } else {
      expect(after.err, "동작이 바뀌어 거부되는 경우도 ACCESS_DENIED만 격리 유지로 인정한다").toBe(5);
    }
    const breakaway = JSON.parse(fs.readFileSync(breakawayFile, "utf8")) as { ok?: boolean; err?: number; pid?: number };
    // Nested with libuv's breakaway-ok job, Windows may accept the flag and still keep the child in our job.
    // Either the call is denied, or the process it created dies with the console. A survivor is the failure.
    if (breakaway.ok) {
      const startedAt = processStartTime(breakaway.pid ?? 0);
      expect(startedAt, `breakaway process was not visible (${JSON.stringify(breakaway)})`).not.toBeNull();
      own(breakaway.pid!);
      started.push({ pid: breakaway.pid!, startedAt: startedAt!, command: "breakaway" });
    } else {
      expect(breakaway.err, `breakaway failed for an unexpected reason (${JSON.stringify(breakaway)})`).toBe(5);
    }
    for (const role of ["detached", "native"]) {
      expect(pluginChildren.some((child) => child.command === `tokscale ${role}`), `${role} grandchild was not started`).toBe(true);
    }
    if (after.ok) {
      expect(processStartTime(after.pid), "stop 직전에도 성공한 breakaway 자식이 같은 생성 시각으로 살아 있어야 한다").toBe(pluginBreakawayStartedAt);
    }

    const stoppedAt = Date.now();
    const stop = await runStop(run.env);
    const exit = await exitOf(consoleProcess, 30_000);
    const elapsedMs = Date.now() - stoppedAt;

    console.log(`W1 stop timing ${JSON.stringify({ outcome: exitOutcome(run, consoleProcess.pid!), elapsedMs, marginMs: CONSOLE_STOP_DEADLINE_MS - elapsedMs })}`);
    lifecycleCheck("W1", stop.status === 0 && stop.stdout.includes("stopped"), "an external stop is reported as stopped", { detail: { status: stop.status, stdout: stop.stdout.trim(), stderr: stop.stderr.trim(), elapsedMs } });
    lifecycleCheck("W1", exit.code === 0 && exit.signal === null && exitOutcome(run, consoleProcess.pid!) === "clean", "an external stop records clean", { detail: { exit, outcome: exitOutcome(run, consoleProcess.pid!), failureLog: failureKinds(run), elapsedMs } });
    lifecycleCheck("W1", elapsedMs < CONSOLE_STOP_DEADLINE_MS, "I4: the hung plugin child does not hold the stop to the deadline", { detail: { elapsedMs } });
    const left = await survivors(run, started);
    if (after.ok) {
      expect(processStartTime(after.pid), `stop 뒤 성공한 breakaway 자식이 남으면 안 된다: pid=${after.pid}, startedAt=${pluginBreakawayStartedAt}`).not.toBe(pluginBreakawayStartedAt);
    }
    lifecycleCheck("W1", left.length === 0, "I2: the plugin child and its grandchildren do not outlive the Console", { detail: { survivors: left, failureLog: failureKinds(run) } });
  }, 150_000);

  // W2. An uncaught exception while a fake agent, its MCP child, and a detached grandchild are running. The job closes
  // with the process, so none of them is still the process we recorded.
  it.skipIf(process.platform !== "win32")("leaves no grandchild after a crash", async () => {
    const run = createRun("win-crash");
    const crashFile = path.join(run.dir, "crash");
    const consoleProcess = spawnConsole(run, {
      preload: writePreload(run, "crash.mjs", crashPreload(crashFile)),
      env: { FAKE_AGENT_DETACHED_GRANDCHILD: "1" },
    });
    const endpoint = await waitForReady(run, consoleProcess.pid!);
    await openWorkload(run, endpoint, { terminal: false });
    const started = descendantsOf(consoleProcess.pid!);
    expect(agentProcs(run).some((entry) => entry.role === "chat-mcp")).toBe(true);
    expect(agentProcs(run).some((entry) => entry.role === "chat-detached")).toBe(true);

    fs.writeFileSync(crashFile, "");
    await exitOf(consoleProcess, 20_000);

    lifecycleCheck("W2", exitOutcome(run, consoleProcess.pid!) === "crash", "a crash records crash", { detail: { outcome: exitOutcome(run, consoleProcess.pid!), failureLog: failureKinds(run) } });
    const left = await survivors(run, started);
    lifecycleCheck("W2", left.length === 0, "I2: nothing the crashed Console started outlives it", { detail: { survivors: left } });
  }, 90_000);

  // W3. External TerminateProcess, both as process.kill and as taskkill /F /PID without /T. The tree dies because the
  // kernel closes the job, not because the killer walked it. The record stays unrecorded or external, never clean.
  it.skipIf(process.platform !== "win32")("leaves no grandchild after TerminateProcess", async () => {
    await expectWindowsExternalKill("terminate");
  }, 90_000);

  it.skipIf(process.platform !== "win32")("leaves no grandchild after taskkill /F without /T", async () => {
    await expectWindowsExternalKill("taskkill");
  }, 90_000);

  // W4. A sentinel this test started, and a detached child the Console started the way it starts the update worker
  // (not registered), are still the same processes after the Console is killed. A second Console is not booted: the
  // sentinel is already an unrelated pid.
  it.skipIf(process.platform !== "win32")("does not signal a sentinel or a detached hand-off when the Console is killed", async () => {
    const run = createRun("win-sentinel");
    const handoffFile = path.join(run.dir, "handoff.json");
    const consoleProcess = spawnConsole(run, { preload: writePreload(run, "handoff.mjs", handoffPreload(handoffFile)) });
    await waitForReady(run, consoleProcess.pid!);
    const handoff = JSON.parse(fs.readFileSync(handoffFile, "utf8")) as { pid: number };
    const handoffStarted = processStartTime(handoff.pid);
    own(handoff.pid);
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30);"], { stdio: "ignore", windowsHide: true });
    own(sentinel.pid!);
    const sentinelStarted = processStartTime(sentinel.pid!);
    expect(handoffStarted, "the hand-off child must be observable").not.toBeNull();
    expect(sentinelStarted, "the sentinel must be observable").not.toBeNull();

    spawnSync("taskkill.exe", ["/F", "/PID", String(consoleProcess.pid)], { windowsHide: true });
    await exitOf(consoleProcess, 20_000);

    lifecycleCheck("W4", processStartTime(handoff.pid) === handoffStarted, "I1: a detached hand-off is not killed with the Console", { detail: { pid: handoff.pid } });
    lifecycleCheck("W4", processStartTime(sentinel.pid!) === sentinelStarted, "I1: an unrelated process is not signalled", { detail: { pid: sentinel.pid } });
  }, 60_000);

  // W6. The representative degraded path: koffi will not load. The Console still becomes ready and records
  // containment_degraded. Create and assign failures are the same record kind, locked on the port itself.
  it.skipIf(process.platform !== "win32")("boots and records containment_degraded when koffi will not load", async () => {
    const run = createRun("win-degraded");
    // The same injection the host already trusts. The directory is outside the checkout, so module lookup cannot
    // walk back into this repo's node_modules and find koffi. No test-only product hook.
    const fakeRoot = path.join(run.tmp, "empty-console-package");
    fs.mkdirSync(fakeRoot);
    fs.writeFileSync(path.join(fakeRoot, "package.json"), JSON.stringify({ name: "@dotobokuri/fleet-console", version: "0.0.0" }));
    run.env.FLEET_CONSOLE_PACKAGE_ROOT = fakeRoot;
    const consoleProcess = spawnConsole(run);
    await waitForReady(run, consoleProcess.pid!);

    expect(isAlive(consoleProcess.pid!), "a koffi load failure must not kill the Console").toBe(true);
    lifecycleCheck("W6", failureKinds(run).includes("containment_degraded"), "a koffi load failure is recorded as containment_degraded", { detail: failureKinds(run) });
  }, 60_000);
});

/**
 * Asserts one invariant of a lifecycle case. While the case is a listed known defect (and the ratchet is on), a signature
 * check asserts the defect instead and any other check of that case is left unasserted.
 */
function crashPreload(crashFile: string): readonly string[] {
  return [
    "import fs from 'node:fs';",
    `const crashFile = ${JSON.stringify(crashFile)};`,
    "const timer = setInterval(() => { if (fs.existsSync(crashFile)) { clearInterval(timer); throw new Error('lifecycle suite injected crash'); } }, 50);",
    "timer.unref();",
  ];
}

/** A detached child the registry never sees, the shape of the update worker. */
function handoffPreload(handoffFile: string): readonly string[] {
  return [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    `const handoffFile = ${JSON.stringify(handoffFile)};`,
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30);'], { detached: true, stdio: 'ignore', windowsHide: true });",
    "child.unref();",
    "fs.writeFileSync(handoffFile, JSON.stringify({ pid: child.pid }));",
  ];
}

async function expectWindowsExternalKill(kind: "terminate" | "taskkill"): Promise<void> {
  const run = createRun(kind === "taskkill" ? "win-taskkill" : "win-terminate");
  const consoleProcess = spawnConsole(run, { env: { FAKE_AGENT_DETACHED_GRANDCHILD: "1" } });
  const endpoint = await waitForReady(run, consoleProcess.pid!);
  await openWorkload(run, endpoint, { terminal: false });
  const started = descendantsOf(consoleProcess.pid!);
  expect(agentProcs(run).some((entry) => entry.role === "chat-detached")).toBe(true);

  if (kind === "taskkill") spawnSync("taskkill.exe", ["/F", "/PID", String(consoleProcess.pid)], { windowsHide: true });
  else process.kill(consoleProcess.pid!);
  await exitOf(consoleProcess, 20_000);

  const outcome = exitOutcome(run, consoleProcess.pid!);
  lifecycleCheck("W3", outcome !== "clean", "an external kill is not recorded as clean", { detail: { kind, outcome } });
  const left = await survivors(run, started);
  lifecycleCheck("W3", left.length === 0, "I2: nothing the killed Console started outlives it", { detail: { kind, survivors: left } });
}

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
    env: process.platform === "win32" ? windowsRunEnv(home, tmp, pathbin, root, dir, agentDir) : {
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
  if (process.platform !== "win32") {
    // The agent stand-in is a `#!/usr/bin/env node` script: only this Node goes on PATH, never a directory of real CLIs.
    fs.symlinkSync(process.execPath, path.join(pathbin, "node"));
  }
  return run;
}

/**
 * One .exe for every Windows case in this worker. Compiling again made csc die with 0xC0000142 on later tests.
 * Paths come from the environment, so the same binary serves every run. It waits briefly so the Console can assign
 * the leader, then runs the fake agent under node and proxies the pipes. .NET Framework csc ships on windows-2022.
 */
let windowsFakeAgentExePath: string | undefined;

function windowsFakeAgentExe(): string {
  if (windowsFakeAgentExePath && fs.existsSync(windowsFakeAgentExePath)) return windowsFakeAgentExePath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-lifecycle-fake-agent-"));
  const exePath = path.join(dir, "claude-fake.exe");
  const source = path.join(dir, "claude-fake.cs");
  const winDir = process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows";
  const compilers = [
    path.join(winDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(winDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const csc = compilers.find((candidate) => fs.existsSync(candidate));
  if (!csc) throw new Error(`csc.exe was not found (${compilers.join(", ")})`);
  fs.writeFileSync(source, [
    "using System;",
    "using System.Diagnostics;",
    "using System.Threading;",
    "class Program {",
    "  static int Main(string[] args) {",
    "    string node = Environment.GetEnvironmentVariable(\"FAKE_AGENT_NODE\");",
    "    string script = Environment.GetEnvironmentVariable(\"FAKE_AGENT_SCRIPT\");",
    "    string dir = Environment.GetEnvironmentVariable(\"FAKE_AGENT_DIR\");",
    "    string logPath = Environment.GetEnvironmentVariable(\"FAKE_AGENT_LOG\");",
    "    if (string.IsNullOrEmpty(logPath)) logPath = \"claude-fake.log\";",
    "    try { System.IO.File.AppendAllText(logPath, \"start\\r\\n\"); } catch (System.Exception ignored) {}",
    "    if (string.IsNullOrEmpty(node) || string.IsNullOrEmpty(script) || string.IsNullOrEmpty(dir)) {",
    "      try { System.IO.File.AppendAllText(logPath, \"missing-env\\r\\n\"); } catch (System.Exception ignored) {}",
    "      return 2;",
    "    }",
    "    Thread.Sleep(300);",
    "    var psi = new ProcessStartInfo();",
    "    psi.FileName = node;",
    "    psi.UseShellExecute = false;",
    "    psi.RedirectStandardInput = true;",
    "    psi.RedirectStandardOutput = true;",
    "    psi.RedirectStandardError = true;",
    "    psi.Arguments = Quote(script);",
    "    foreach (string arg in args) psi.Arguments += \" \" + Quote(arg);",
    "    psi.EnvironmentVariables[\"FAKE_AGENT_DIR\"] = dir;",
    "    string breakaway = Environment.GetEnvironmentVariable(\"FAKE_AGENT_BREAKAWAY_RESULT\");",
    "    if (!string.IsNullOrEmpty(breakaway)) psi.EnvironmentVariables[\"FAKE_AGENT_BREAKAWAY_RESULT\"] = breakaway;",
    "    string koffi = Environment.GetEnvironmentVariable(\"FAKE_AGENT_KOFFI\");",
    "    if (!string.IsNullOrEmpty(koffi)) psi.EnvironmentVariables[\"FAKE_AGENT_KOFFI\"] = koffi;",
    "    string detached = Environment.GetEnvironmentVariable(\"FAKE_AGENT_DETACHED_GRANDCHILD\");",
    "    if (!string.IsNullOrEmpty(detached)) psi.EnvironmentVariables[\"FAKE_AGENT_DETACHED_GRANDCHILD\"] = detached;",
    "    var child = Process.Start(psi);",
    "    if (child == null) { try { System.IO.File.AppendAllText(logPath, \"start-failed\\r\\n\"); } catch (System.Exception ignored) {} return 3; }",
    "    var input = new Thread(() => Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream, true));",
    "    var output = new Thread(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false));",
    "    var error = new Thread(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError(), false));",
    "    input.IsBackground = true; output.IsBackground = true; error.IsBackground = true;",
    "    input.Start(); output.Start(); error.Start();",
    "    child.WaitForExit();",
    "    try { System.IO.File.AppendAllText(logPath, \"exit \" + child.ExitCode + \"\\r\\n\"); } catch (System.Exception ignored) {}",
    "    return child.ExitCode;",
    "  }",
    "  static void Pump(System.IO.Stream from, System.IO.Stream to, bool closeTo) {",
    "    try {",
    "      byte[] buffer = new byte[8192];",
    "      int read;",
    "      while ((read = from.Read(buffer, 0, buffer.Length)) > 0) { to.Write(buffer, 0, read); to.Flush(); }",
    "    } catch (System.Exception ignored) {}",
    "    if (closeTo) { try { to.Close(); } catch (System.Exception ignored) {} }",
    "  }",
    "  static string Quote(string value) {",
    "    string q = ((char)34).ToString();",
    "    return q + value.Replace(q, ((char)92).ToString() + q) + q;",
    "  }",
    "}",
  ].join("\r\n"));
  const compiled = spawnSync(csc, ["/nologo", "/t:exe", `/out:${exePath}`, source], { encoding: "utf8", windowsHide: true });
  if (compiled.status !== 0 || !fs.existsSync(exePath)) {
    throw new Error(`csc.exe failed to build the fake agent (${compiled.status}): ${compiled.stdout}\n${compiled.stderr}`);
  }
  windowsFakeAgentExePath = exePath;
  return exePath;
}

/**
 * Grandchild setup baked into the stand-in. The plugin spawn does not take a custom env, so the flag is not read at
 * runtime. A failure is appended to the same pids file the timeout prints.
 */
function windowsGrandchildLines(enabled: boolean, breakawayFile: string | undefined): readonly string[] {
  if (!enabled) return [];
  if (!breakawayFile) throw new Error("플러그인 breakaway 결과 경로가 필요합니다");
  const koffiEntry = createRequire(fileURLToPath(import.meta.url)).resolve("koffi");
  return [
    "if (!process.argv.includes('models')) {",
    "  let once = false;",
    "  try { require('fs').mkdirSync(require('path').join(__dirname, 'grandchildren.lock')); once = true; } catch (error) {}",
    "  if (once) try {",
    "    const fs = require('fs');",
    "    // 할당 경합을 제거했다는 증거가 아니다. race 측정은 M2가 맡고 W1은 containment 게이트만 확인한다.",
    "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);",
    "    const path = require('path');",
    "    const { spawn: nativeSpawn } = require('child_process');",
    "    let nonDetachedSpawns = 0;",
    "    const spawn = (command, args, options) => { const child = nativeSpawn(command, args, options); if (child.pid && options?.detached !== true) nonDetachedSpawns += 1; return child; };",
    "    const note = (text) => record('windows-error', String(text).replace(/\\s+/g, ' ').slice(0, 400));",
    `    const koffi = require(${JSON.stringify(koffiEntry)});`,
    "    const kernel32 = koffi.load('kernel32.dll');",
    "    const CreateProcessW = kernel32.func('__stdcall', 'CreateProcessW', 'int', ['void *', koffi.pointer('uint16'), 'void *', 'void *', 'int', 'uint32', 'void *', 'void *', koffi.pointer('uint8'), koffi.pointer('uint8')]);",
    "    const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32', []);",
    "    const GetCurrentProcess = kernel32.func('__stdcall', 'GetCurrentProcess', 'void *', []);",
    "    const IsProcessInJob = kernel32.func('__stdcall', 'IsProcessInJob', 'int', ['void *', 'void *', koffi.out(koffi.pointer('int32'))]);",
    "    const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *']);",
    "    const runBreakaway = (phase, stayAlive) => {",
    "      const inJob = Buffer.alloc(4);",
    "      const queryOk = Boolean(IsProcessInJob(GetCurrentProcess(), null, inJob));",
    "      // NULL(any-job)은 G 소속 증명이 아니다. 정확한 G 소속의 영구 조회는 Commodore 결정 C로 면제한다.",
    "      const inAnyJob = queryOk ? inJob.readInt32LE(0) !== 0 : null;",
    "      const q = String.fromCharCode(34);",
    "      const command = stayAlive ? q + process.execPath + q + ' -e ' + q + 'setInterval(()=>{},1<<30)' + q : 'cmd.exe /c exit 0';",
    "      const cmd = Buffer.from(command + String.fromCharCode(0), 'utf16le');",
    "      const si = Buffer.alloc(104); si.writeUInt32LE(104, 0);",
    "      const pi = Buffer.alloc(24);",
    "      const ok = CreateProcessW(null, cmd, null, null, 0, 0x01000000, null, null, si, pi);",
    "      const err = ok ? 0 : Number(typeof koffi.errno === 'function' ? koffi.errno() : 0) || Number(GetLastError());",
    "      const pid = ok ? pi.readUInt32LE(16) : 0;",
    "      if (ok) { CloseHandle(koffi.decode(pi, 0, 'void *')); CloseHandle(koffi.decode(pi, 8, 'void *')); }",
    "      return { phase, nonDetachedSpawns, ok: Boolean(ok), err, pid, callerPid: process.pid, inAnyJob, queryOk };",
    "    };",
    "    // 이 블록은 생성된 bin.js의 모든 spawn 호출보다 먼저 배치되고, 호출은 동기로 끝난다.",
    "    const beforeSpawn = runBreakaway('before-non-detached-spawn', false);",
    "    const stay = path.join(__dirname, 'stay.js');",
    "    fs.writeFileSync(stay, 'setInterval(() => {}, 1 << 30);\\n');",
    "    try {",
    "      const detached = spawn(process.execPath, [stay], { detached: true, stdio: 'ignore', windowsHide: true });",
    "      detached.unref();",
    "      if (detached.pid) record('detached', detached.pid);",
    "      else note('detached spawn returned no pid');",
    "    } catch (error) { note('detached ' + (error && error.message || error)); }",
    "    // Start-Process does not return on the headless windows-2022 session (it blocks until the timeout), so it is not a required grandchild here.",
    "    const pidFile = path.join(__dirname, 'native.pid');",
    "    const bridge = path.join(__dirname, 'native-bridge.js');",
    "    fs.writeFileSync(bridge, \"const {spawn}=require('child_process'); const fs=require('fs'); const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 400'],{stdio:'ignore',windowsHide:true}); fs.writeFileSync(process.argv[2], String(child.pid)); setInterval(()=>{},1<<30);\\n\");",
    "    spawn(process.execPath, [bridge, pidFile], { stdio: 'ignore', windowsHide: true });",
    "    const deadline = Date.now() + 5000;",
    "    while (!fs.existsSync(pidFile) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
    "    if (fs.existsSync(pidFile)) record('native', Number(fs.readFileSync(pidFile, 'utf8')));",
    "    else note('native grandchild pid was not written');",
    "    const afterSpawn = runBreakaway('after-non-detached-spawn', true);",
    `    fs.writeFileSync(${JSON.stringify(breakawayFile)}, JSON.stringify({ beforeSpawn, afterSpawn }));`,
    "  } catch (error) {",
    "    try { record('windows-error', String(error && error.message || error).replace(/\\s+/g, ' ').slice(0, 400)); } catch {}",
    "  }",
    "}",
  ];
}

function windowsRunEnv(home: string, tmp: string, pathbin: string, root: string, dir: string, agentDir: string): LifecycleRun["env"] {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const pathValue = [pathbin, path.dirname(process.execPath), path.join(systemRoot, "System32"), path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";");
  const comSpec = process.env.ComSpec ?? path.join(systemRoot, "System32", "cmd.exe");
  const user = os.userInfo().username;
  return {
    HOME: home,
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp,
    PATH: pathValue,
    Path: pathValue,
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    SystemRoot: systemRoot,
    SYSTEMROOT: systemRoot,
    ComSpec: comSpec,
    COMSPEC: comSpec,
    USER: user,
    USERNAME: user,
    LANG: "en_US.UTF-8",
    FLEET_DATA_DIR: root,
    FLEET_CONSOLE_DATA_DIR: path.join(root, "console"),
    FLEET_DESKTOP_DATA_DIR: path.join(dir, "desktop"),
    CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Chat refuses a .cmd CLAUDE_BIN (`chat_cli_wrapper_unsupported`). The SDK spawns this exe with no shell.
    CLAUDE_BIN: windowsFakeAgentExe(),
    FAKE_AGENT_NODE: process.execPath,
    FAKE_AGENT_SCRIPT: FAKE_AGENT,
    FAKE_AGENT_DIR: agentDir,
    FAKE_AGENT_LOG: path.join(pathbin, "claude-fake.log"),
  };
}

function spawnConsole(run: LifecycleRun, options: { readonly preload?: string; readonly env?: Record<string, string> } = {}): ChildProcess {
  const args = [...(options.preload ? ["--import", pathToFileURL(options.preload).href] : []), cliDist, "serve"];
  // Detached like `fleet console start`: the Console leads its own process group.
  const child = spawn(process.execPath, args, { env: { ...run.env, ...options.env }, stdio: "ignore", detached: true });
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
 * `strayChild` also starts a child that no one registers and that never ends by itself, in the Console's process group.
 * `freezeOnSignalMs` also blocks the event loop that long when the first SIGTERM arrives, before the Console handles it.
 * `freezeBeforeDeadline` blocks it for FREEZE_BEFORE_DEADLINE_MS starting 200ms before the Console's own stop deadline, so the
 * deadline's cleanup runs late while its process-table read keeps the full budget.
 * `recordSignal` writes when the first SIGTERM arrived (epoch ms) to `signalled`.
 */
function stallShutdownWithLockHeld(run: LifecycleRun, options: { readonly freezeOnSignalMs?: number; readonly freezeBeforeDeadline?: boolean; readonly strayChild?: boolean; readonly recordSignal?: boolean } = {}): { readonly preload: string; readonly marker: string; readonly freeze: string; readonly signalled: string } {
  const marker = path.join(run.dir, "stalled");
  const signalled = path.join(run.dir, "signalled");
  // {t0, start, end} in epoch ms: the first SIGTERM and the pre-deadline freeze, for the case's timeline.
  const freeze = path.join(run.dir, "freeze.jsonl");
  const preload = writePreload(run, "stall-close.mjs", [
    "import fs from 'node:fs';",
    "import http from 'node:http';",
    `const lock = ${JSON.stringify(run.lockFile)}, marker = ${JSON.stringify(marker)}, freeze = ${JSON.stringify(freeze)};`,
    ...(options.recordSignal ? [`process.prependOnceListener('SIGTERM', () => fs.writeFileSync(${JSON.stringify(signalled)}, String(Date.now())));`] : []),
    ...(options.freezeOnSignalMs ? [`process.prependOnceListener('SIGTERM', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${options.freezeOnSignalMs}));`] : []),
    // A child no one registered, in the Console's own process group, that never ends by itself (a hung tool call).
    ...(options.strayChild ? ["import('node:child_process').then(({ spawn }) => spawn('/bin/sleep', ['300'], { stdio: 'ignore' }));"] : []),
    ...(options.freezeBeforeDeadline ? [
      "process.prependOnceListener('SIGTERM', () => {",
      "  const t0 = Date.now();",
      "  setTimeout(() => {",
      "    const start = Date.now();",
      `    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${FREEZE_BEFORE_DEADLINE_MS});`,
      "    fs.appendFileSync(freeze, JSON.stringify({ t0, start, end: Date.now() }) + '\\n');",
      `  }, ${CONSOLE_STOP_DEADLINE_MS - 200}).unref();`,
      "});",
    ] : []),
    "const close = http.Server.prototype.close;",
    "http.Server.prototype.close = function (callback) {",
    "  let port = null;",
    "  try { port = JSON.parse(fs.readFileSync(lock, 'utf8')).port; } catch {}",
    "  const address = this.address();",
    "  if (port !== null && address && typeof address === 'object' && address.port === port) { fs.writeFileSync(marker, ''); return this; }",
    "  return close.call(this, callback);",
    "};",
  ]);
  return { preload, marker, freeze, signalled };
}

/** How long after the Console's first SIGTERM its stop deadline recorded the timeout (after its SIGKILLs), in ms. */
function deadlineRecordedAfterSignal(run: LifecycleRun, signalled: string): number | null {
  try {
    const t0 = Number(fs.readFileSync(signalled, "utf8"));
    for (const line of fs.readFileSync(path.join(run.root, "console", "errors.jsonl"), "utf8").split("\n").filter(Boolean)) {
      const entry = JSON.parse(line) as { kind?: unknown; ts?: unknown };
      if (entry.kind === "shutdown_timeout" && typeof entry.ts === "string") return Date.parse(entry.ts) - t0;
    }
  } catch { /* No signal or no failure log: the deadline never fired. */ }
  return null;
}

/**
 * When, after the Console's first SIGTERM, the pre-deadline freeze started and ended and the deadline recorded its timeout
 * (after its process-table read and SIGKILLs), in ms. The record lands once the deadline callback, delayed by the freeze,
 * has read the process table, so recorded − freezeEnd is about that read.
 */
function deadlineTimeline(run: LifecycleRun, freeze: string): { readonly freezeStartMs: number; readonly freezeEndMs: number; readonly deadlineRecordedMs: number | null } | null {
  try {
    const { t0, start, end } = JSON.parse(fs.readFileSync(freeze, "utf8").split("\n")[0]!) as { t0: number; start: number; end: number };
    let recorded: number | null = null;
    try {
      for (const line of fs.readFileSync(path.join(run.root, "console", "errors.jsonl"), "utf8").split("\n").filter(Boolean)) {
        const entry = JSON.parse(line) as { kind?: unknown; ts?: unknown };
        if ((entry.kind === "shutdown_timeout" || entry.kind === "startup_shutdown_timeout") && typeof entry.ts === "string") recorded = Date.parse(entry.ts) - t0;
      }
    } catch { /* No failure log: the deadline never fired. */ }
    return { freezeStartMs: start - t0, freezeEndMs: end - t0, deadlineRecordedMs: recorded };
  } catch {
    return null;
  }
}

/** The outcome the run's Console `pid` recorded for itself, or null when it left no record. */
function exitOutcome(run: LifecycleRun, pid: number): string | null {
  const dir = path.dirname(run.lockFile);
  const file = fs.readdirSync(dir).find((name) => name.startsWith(`console.exit.${pid}-`) && name.endsWith(".json"));
  if (!file) return null;
  try { return String((JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { outcome?: unknown }).outcome); } catch { return null; }
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

/** A `ps` that never answers within any process-table budget, put on one process's PATH only. */
function hangingProcessTable(run: LifecycleRun): string {
  const dir = path.join(run.dir, "hanging-ps");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ps"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  return dir;
}

/**
 * A `ps` that answers after `delayMs`, put on one process's PATH only: its process-table read is slow, nobody else's. With
 * `calls`, every invocation first appends its caller's pid to that file (a shell builtin: no extra exec on the timed path).
 */
function slowProcessTable(run: LifecycleRun, delayMs: number, calls?: string): string {
  const dir = path.join(run.dir, `slow-ps-${delayMs}${calls ? "-counted" : ""}`);
  fs.mkdirSync(dir, { recursive: true });
  const realPs = SYSTEM_PATH.map((entry) => path.join(entry, "ps")).find((candidate) => fs.existsSync(candidate));
  if (!realPs) throw new Error("ps is not on the system PATH");
  const count = calls ? `echo "$PPID $(${JSON.stringify(process.execPath)} -p 'Date.now()')" >> ${JSON.stringify(calls)}\n` : "";
  fs.writeFileSync(path.join(dir, "ps"), `#!/bin/sh\n${count}sleep ${delayMs / 1000}\nexec ${realPs} "$@"\n`, { mode: 0o755 });
  return dir;
}

/** How many recorded calls came from `caller`. */
function callsFrom(file: string, caller: number, notBefore = 0): number {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((line) => {
      const [pid, at] = line.split(" ");
      return Number(pid) === caller && Number(at) >= notBefore;
    }).length;
  } catch { return 0; }
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
  const turnDeadline = Date.now() + 20_000;
  while (count("turn-open") <= turns && Date.now() < turnDeadline) await delay(25);
  if (count("turn-open") <= turns) {
    const procsFile = path.join(run.agentDir, "procs.jsonl");
    const procs = fs.existsSync(procsFile) ? fs.readFileSync(procsFile, "utf8") : "(no procs)";
    const errorsFile = path.join(run.root, "console", "errors.jsonl");
    const errors = fs.existsSync(errorsFile) ? fs.readFileSync(errorsFile, "utf8").slice(-2_000) : "(no errors)";
    const launcherLog = path.join(run.dir, "bin", "claude-fake.log");
    const launcher = fs.existsSync(launcherLog) ? fs.readFileSync(launcherLog, "utf8") : "(no launcher log)";
    throw new Error(`the chat turn did not open\nprocs:\n${procs}\nlauncher:\n${launcher}\nerrors:\n${errors}`);
  }
  if (options.terminal) {
    const terminals = count("terminal");
    await consoleApi(endpoint, "/api/v1/agent/sessions", { theaterId, cliId: "claude" });
    await waitUntil(() => count("terminal") > terminals, 20_000, "the terminal did not start");
  }
}

/**
 * A built-in plugin's own long-running children (N7): two Ledger summaries (week and month) start tokscale four times, and
 * a stand-in installed where Ledger looks for it hangs in the three shapes a CLI leaves behind. The report runs ignore
 * SIGTERM themselves. The week model run ends on SIGTERM but leaves a helper that ignores it and holds the run's inherited
 * stdout and stderr (N9). The month model run leaves the same helper and exits by itself before any stop, as a CLI that
 * timed out does. Only the Console's containment ends them. Returns every process recorded, with its start time, so a
 * case watches the helpers too once they are no longer the Console's descendants. The suite owns each one at once: one
 * that escapes is reparented away from the Console and would otherwise outlive the case.
 */
async function openPluginChildren(run: LifecycleRun, endpoint: string): Promise<Array<{ readonly pid: number; readonly startedAt: string; readonly command: string }>> {
  const pkg = path.join(run.root, "console", "plugins", "ledger", "cli", "node_modules", "tokscale");
  const pids = path.join(pkg, "pids");
  fs.mkdirSync(pkg, { recursive: true });
  // Ledger refuses anything but its pinned version.
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "tokscale", version: "4.7.0" }));
  fs.writeFileSync(path.join(pkg, "bin.js"), [
    `const record = (role, pid) => require("fs").appendFileSync(${JSON.stringify(pids)}, role + " " + pid + "\\n");`,
    "const gone = process.argv.includes('--month');",
    // Windows 직접 게이트가 elected report 리더의 첫 spawn보다 반드시 앞서 실행되도록 배치한다.
    ...windowsGrandchildLines(run.env.LEDGER_WINDOWS_GRANDCHILDREN === "1", run.env.LEDGER_BREAKAWAY_RESULT),
    "if (process.argv.includes('models')) {",
    "  const helper = require('child_process').spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);\"], { stdio: 'inherit' });",
    "  record(gone ? 'helper-gone' : 'helper', helper.pid);",
    "  record(gone ? 'cli-gone' : 'cli-honours', process.pid);",
    "  if (gone) setTimeout(() => process.exit(0), 100);",
    "} else {",
    "  process.on('SIGTERM', () => {});",
    "  record('cli-ignores', process.pid);",
    "}",
    "setInterval(() => {}, 1 << 30);",
  ].join("\n"));
  // Each summary answers only once tokscale does; the requests end with the Console.
  for (const window of ["week", "month"]) {
    fetch(new URL(`plugins/ledger/summary?window=${window}`, endpoint), { headers: { origin: new URL(endpoint).origin } }).catch(() => {});
  }
  const recorded = () => fs.existsSync(pids)
    ? fs.readFileSync(pids, "utf8").split("\n").filter(Boolean).map((line) => { const [role, pid] = line.split(" "); return { role: role!, pid: Number(pid) }; })
    : [];
  // Two report runs, two model runs, and their two helpers.
  await waitUntil(() => recorded().length >= 6, 20_000, "the Ledger plugin did not start its CLI");
  if (run.env.LEDGER_WINDOWS_GRANDCHILDREN === "1") {
    const ready = () => {
      const roles = new Set(recorded().map((entry) => entry.role));
      return roles.has("detached") && roles.has("native") && run.env.LEDGER_BREAKAWAY_RESULT !== undefined && fs.existsSync(run.env.LEDGER_BREAKAWAY_RESULT);
    };
    const deadline = Date.now() + 40_000;
    while (!ready() && Date.now() < deadline) await delay(25);
    if (!ready()) {
      const body = fs.existsSync(pids) ? fs.readFileSync(pids, "utf8") : "(no pids file)";
      throw new Error(`the plugin child did not start its Windows grandchildren\n${body}`);
    }
  }
  const entries = recorded();
  for (const entry of entries) own(entry.pid);
  const gone = entries.find((entry) => entry.role === "cli-gone")!;
  await waitUntil(() => !isAlive(gone.pid), 10_000, "the timed-out CLI stand-in did not exit by itself");
  return entries.flatMap((entry) => {
    const startedAt = processStartTime(entry.pid);
    return startedAt === null ? [] : [{ pid: entry.pid, startedAt, command: `tokscale ${entry.role}` }];
  });
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
  if (process.platform === "win32") return windowsProcesses().get(pid)?.startedAt ?? null;
  // The C locale keeps lstart in the one format Date.parse reads.
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

/**
 * One CIM snapshot, reused for the synchronous lookups in a single survivors pass. The next pass is a fresh read, so a
 * process that exits between polls is not still "the same start time".
 */
let windowsProcessSnapshot: { readonly at: number; readonly rows: Map<number, { readonly ppid: number; readonly startedAt: string; readonly name: string }> } | null = null;

function windowsProcesses(): Map<number, { readonly ppid: number; readonly startedAt: string; readonly name: string }> {
  const now = Date.now();
  if (windowsProcessSnapshot && now - windowsProcessSnapshot.at < 50) return windowsProcessSnapshot.rows;
  const script = [
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "  if ($null -eq $_.CreationDate) { return }",
    "  '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'), ($_.Name -replace '[|]', '_')",
    "}",
  ].join(" ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  const rows = new Map<number, { readonly ppid: number; readonly startedAt: string; readonly name: string }>();
  if (result.status === 0) {
    for (const line of result.stdout.split(/\r?\n/)) {
      const [pid, ppid, startedAt, name] = line.split("|");
      if (!pid || !ppid || !startedAt) continue;
      rows.set(Number(pid), { ppid: Number(ppid), startedAt, name: name ?? "" });
    }
  }
  windowsProcessSnapshot = { at: now, rows };
  return rows;
}

/** Every live descendant of `pid` now, whatever started it (agents, their MCP children, PTYs, helpers). */
function descendantsOf(pid: number): Array<{ readonly pid: number; readonly startedAt: string; readonly command: string }> {
  if (process.platform === "win32") {
    const table = windowsProcesses();
    const found: number[] = [];
    const queue = [pid];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const [child, row] of table) {
        if (row.ppid === parent && !found.includes(child)) {
          found.push(child);
          queue.push(child);
        }
      }
    }
    const rootStarted = table.get(pid)?.startedAt;
    return found.flatMap((child) => {
      const row = table.get(child);
      // A process that started before this one cannot be a child we created. This drops system processes whose
      // parent id collides with something in the walk.
      if (!row || (rootStarted !== undefined && row.startedAt < rootStarted)) return [];
      own(child);
      return [{ pid: child, startedAt: row.startedAt, command: row.name }];
    });
  }
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
  if (process.platform === "win32") return windowsProcesses().get(pid)?.name ?? "";
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
