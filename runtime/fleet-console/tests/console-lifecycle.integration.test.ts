import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { proveExitedLeaderGroup, readConsoleExitRecord, readConsoleLockFile, REAPER_DRAIN_MAX_MS, selectSameGroupDescendants } from "@fleet-console/lifecycle";
import { describeReplacedLockAuthor } from "@fleet-console/protocol/lifecycle";

import { createConsoleDaemonLifecycle, type ConsoleDaemonProcess } from "../core/host/bootstrap/console-lifecycle.js";
import { createConsoleLock } from "../core/host/bootstrap/lock.js";
import { createConsolePaths } from "../core/host/bootstrap/paths.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/controlled-console-child.mjs", import.meta.url));
const CLAIMANT_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/lock-reclaim-claimant.ts", import.meta.url));
const REAPER_SOURCE = fileURLToPath(new URL("../foundation/lifecycle/reaper-main.ts", import.meta.url));
const TSX_LOADER_URL = pathToFileURL(path.join(path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs")).href;
const TEMP_DIRS: string[] = [];
const CHILD_PIDS = new Set<number>();

afterEach(async () => {
  for (const pid of CHILD_PIDS) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 이미 종료된 fixture다.
    }
  }
  CHILD_PIDS.clear();
  for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Console daemon lifecycle integration", () => {
  it("keeps a real child through delayed readiness and later stops it, killing a stalled shutdown", async () => {
    const fixture = createFixturePaths("ready");
    const lifecycle = createConsoleDaemonLifecycle({
      env: { ...fixture.env, FLEET_TEST_CONSOLE_BIND_BEFORE_READY: "1" },
      serverModulePath: FIXTURE_PATH,
      startupTimeoutMs: 8_000,
      pollIntervalMs: 20,
      report: () => {},
    });

    const startedAt = Date.now();
    const ensure = lifecycle.ensureDaemon();
    void ensure.catch(() => {});
    const pid = await readPidWhenReady(fixture.pidFile);
    CHILD_PIDS.add(pid);
    await vi.waitFor(async () => expect((await lifecycle.probe()).starting).toBe(true));
    const lockBefore = fs.readFileSync(fixture.lockFile, "utf8");
    // 이미 lock을 잡고 초기화 중인 Console은 다른 start의 짧은 대기 한도로 죽거나 교체되지 않는다.
    const impatient = createConsoleDaemonLifecycle({ env: fixture.env, serverModulePath: FIXTURE_PATH, startupTimeoutMs: 100, pollIntervalMs: 10 });
    await expect(impatient.ensureDaemon()).rejects.toThrow("was not signalled");
    expect(fs.readFileSync(fixture.lockFile, "utf8")).toBe(lockBefore);
    expect(() => process.kill(pid, 0)).not.toThrow();
    const concurrentEnsure = lifecycle.ensureDaemon();
    void concurrentEnsure.catch(() => {});
    await delay(3_100);
    fs.writeFileSync(fixture.releaseFile, "ready\n", "utf8");

    const endpoint = await ensure;
    expect(await concurrentEnsure).toBe(endpoint);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_000);
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(pid);

    // SIGTERM을 받은 Console이 listener만 닫고 lock을 쥔 채 멈춘다. EXTERNAL_ESCALATION_MS가 지나도록 lock을 놓지 않으면, SIGTERM
    // 전에 증명한 그 프로세스임을 다시 증명한 뒤 강제 종료한다. Windows의 SIGTERM은 TerminateProcess라 정리가 아예 돌지 않는다 —
    // 멈출 정리가 없으니 강제 종료도 아니며, 남은 lock은 끝난 pid의 것이라 stop이 치운다. 정체를 SIGKILL로 끝내는 계약은 POSIX에서만 성립한다.
    fs.writeFileSync(fixture.stallFile, "stall\n", "utf8");
    expect(await lifecycle.stop()).toEqual(process.platform === "win32" ? { outcome: "unrecorded", killed: 0 } : { outcome: "forced-external", killed: 0 });
    await expectProcessGone(pid);
    CHILD_PIDS.delete(pid);
    expect(readConsoleLockFile(fixture.lockFile)).toBeNull();
    expectFileCanBeRenamed(fixture.pidFile);
  });

  it("terminates the real pre-lock child when readiness reaches its deadline", async () => {
    const fixture = createFixturePaths("timeout");
    const lifecycle = createConsoleDaemonLifecycle({
      env: fixture.env,
      serverModulePath: FIXTURE_PATH,
      startupTimeoutMs: 4_000,
      pollIntervalMs: 20,
    });

    const ensure = lifecycle.ensureDaemon();
    void ensure.catch(() => {});
    const pid = await readPidWhenReady(fixture.pidFile);
    CHILD_PIDS.add(pid);

    await expect(ensure).rejects.toThrow("did not become healthy within 4 seconds");
    await expectProcessGone(pid);
    CHILD_PIDS.delete(pid);
    expect(readConsoleLockFile(fixture.lockFile)).toBeNull();
    expectFileCanBeRenamed(fixture.pidFile);
  });
  it("never signals a live process that a stale lock's pid now names", async () => {
    // Console이 lock을 남기고 죽은 뒤 OS가 그 pid를 다른 프로세스에 재할당한 상황이다.
    const fixture = createFixturePaths("reused-pid");
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
    const bystanderPid = bystander.pid!;
    CHILD_PIDS.add(bystanderPid);
    let bystanderSignal: NodeJS.Signals | null = null;
    bystander.once("exit", (_code, signal) => { bystanderSignal = signal ?? "SIGHUP"; });
    // lock 주소에서 무언가 듣고 있지만 lock token을 증명하지 못한다 — 멈춘 Console일 수도 있으므로 lock도 지우지 않는다.
    const impostor = http.createServer((_request, response) => response.writeHead(401).end());
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", resolve));
    const port = (impostor.address() as AddressInfo).port;
    const lockInput = { dir: fixture.dir, lockFile: fixture.lockFile, pid: bystanderPid, port, endpoint: `http://127.0.0.1:${port}/`, version: "crashed" };
    const consoleLock = createConsoleLock();
    await consoleLock.acquireLock(lockInput);
    const lifecycle = createConsoleDaemonLifecycle({ env: fixture.env, serverModulePath: FIXTURE_PATH, pollIntervalMs: 20 });

    await expect(lifecycle.stop()).rejects.toThrow(`lock pid ${bystanderPid} is alive but did not prove it owns`);
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(bystanderPid);

    // 아무도 lock 주소를 듣지 않는데 lock을 쓰기 전에 시작한 pid가 살아 있으면, listener를 닫고 정리 중인 Console과 구별되지
    // 않는다(계약의 stopping). 정지 예산만큼 기다릴 뿐 신호도 lock 삭제도 하지 않는다 — 지우면 다음 start가 살아 있는 Console
    // 옆에 두 번째 Console을 띄운다.
    await new Promise<void>((resolve) => impostor.close(() => resolve()));
    await expect(lifecycle.stop()).rejects.toThrow(`lock pid ${bystanderPid} no longer answers at the lock's address`);
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(bystanderPid);

    // A pid that started after the lock was written cannot be its author, but while that pid lives the lock stays: only
    // ESRCH right before the unlink grants deletion. start refuses instead of booting a Console beside it.
    fs.rmSync(fixture.lockFile);
    await createConsoleLock({ now: () => Date.now() - 60_000 }).acquireLock(lockInput);
    fs.writeFileSync(fixture.releaseFile, "ready\n", "utf8");
    await expect(lifecycle.ensureDaemon()).rejects.toThrow(describeReplacedLockAuthor(fixture.lockFile, bystanderPid));
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(bystanderPid);
    expect(fs.existsSync(fixture.pidFile)).toBe(false);
    expect(bystanderSignal).toBeNull();
    expect(() => process.kill(bystanderPid, 0)).not.toThrow();
  });

  it("lets one live reclaimer at a time act on a dead lock and hands over only after it exits", async () => {
    const fixture = createFixturePaths("reclaim-chain");
    const bystanderPid = spawnIdleProcess();
    const lockInput = { dir: fixture.dir, lockFile: fixture.lockFile, pid: bystanderPid, port: await closedPort(), version: "crashed" };
    const consoleLock = createConsoleLock();
    await consoleLock.acquireLock({ ...lockInput, endpoint: `http://127.0.0.1:${lockInput.port}/` });

    // A separate reclaimer reaches its final check while the lock's pid still runs: it removes nothing, and its reclaim
    // marker stays complete for as long as that reclaimer lives.
    const claimant = spawn(process.execPath, ["--import", TSX_LOADER_URL, CLAIMANT_FIXTURE_PATH, fixture.lockFile], { stdio: ["ignore", "pipe", "inherit"] });
    const claimantPid = claimant.pid!;
    CHILD_PIDS.add(claimantPid);
    expect(await readFirstLine(claimant)).toBe("alive");
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(bystanderPid);

    // The lock is dead now, yet no other reclaimer may take over while that claimant is alive: start fails and keeps it.
    process.kill(bystanderPid, "SIGKILL");
    await expectProcessGone(bystanderPid);
    CHILD_PIDS.delete(bystanderPid);
    fs.writeFileSync(fixture.releaseFile, "ready\n", "utf8");
    const lifecycle = createConsoleDaemonLifecycle({ env: fixture.env, serverModulePath: FIXTURE_PATH, startupTimeoutMs: 8_000, pollIntervalMs: 20, report: () => {} });
    await expect(lifecycle.ensureDaemon()).rejects.toThrow();
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(bystanderPid);
    expect(fs.existsSync(fixture.pidFile)).toBe(false);

    // Once the claimant has exited, the next reclaimer takes over, removes the dead lock, and the new Console owns the slot.
    claimant.kill("SIGKILL");
    await expectProcessGone(claimantPid);
    CHILD_PIDS.delete(claimantPid);
    const ensure = lifecycle.ensureDaemon();
    void ensure.catch(() => {});
    const consolePid = await readPidWhenReady(fixture.pidFile);
    CHILD_PIDS.add(consolePid);
    await expect(ensure).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(readConsoleLockFile(fixture.lockFile)?.pid).toBe(consolePid);

    await lifecycle.stop();
    await expectProcessGone(consolePid);
    CHILD_PIDS.delete(consolePid);
  });

  it("keeps the lock a reused pid published when cleaning up an exited child", async () => {
    // The spawned Console exits and its pid now names another live process that published a lock of its own. The exit
    // event is no evidence about that lock, so cleanup keeps it and reports why.
    const fixture = createFixturePaths("child-pid-reused");
    const bystanderPid = spawnIdleProcess();
    const port = await closedPort();
    const reusedLock = { pid: bystanderPid, host: "127.0.0.1", port, endpoint: `http://127.0.0.1:${port}/`, startedAt: Date.now(), token: "reused-pid-token", version: "other" };
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const lifecycle = createConsoleDaemonLifecycle({
      env: fixture.env,
      serverModulePath: FIXTURE_PATH,
      startupTimeoutMs: 8_000,
      pollIntervalMs: 20,
      report: () => {},
      spawnDaemon: () => {
        const child = Object.assign(new EventEmitter(), {
          pid: bystanderPid,
          kill: (signal?: NodeJS.Signals | number) => { signals.push(signal); return true; },
          unref: () => {},
        }) as EventEmitter & ConsoleDaemonProcess;
        fs.mkdirSync(fixture.dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(fixture.lockFile, `${JSON.stringify(reusedLock, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        setImmediate(() => child.emit("exit", 1, null));
        return child;
      },
    });

    await expect(lifecycle.ensureDaemon()).rejects.toThrow();
    expect(readConsoleLockFile(fixture.lockFile)).toEqual(reusedLock);
    expect(signals).toEqual([]);
    expect(() => process.kill(bystanderPid, 0)).not.toThrow();
  });

  // L13 (I1, I2). Once its Console is gone (the pipe ends), the reaper ends every registered group it can prove is still that
  // group — one whose leader still runs, and one whose leader exited and whose first process-table read fails — never a
  // registration a reused number would make it signal, records that the Console vanished, and exits within its drain cap.
  it.skipIf(process.platform === "win32")("lets the reaper end only the groups it proves, then exit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-reaper-"));
    TEMP_DIRS.push(dir);
    const lockFile = path.join(dir, "console.lock");
    const consolePid = await deadProcessPid();
    const lockStartedAt = Date.now();
    const leading = (spawnedAt: number, args: readonly string[]) => {
      const child = spawn(args[0]!, args.slice(1), { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      CHILD_PIDS.add(child.pid!);
      return { child, group: { pgid: child.pid!, spawnedAt, leaderExitedAt: null } };
    };
    const owned = leading(Date.now(), ["/bin/sleep", "300"]);
    // The number a registration names may belong to another process by now: its start time does not match.
    const reused = leading(Date.now() - 600_000, ["/bin/sleep", "300"]);
    const orphaned = leading(Date.now(), ["/bin/sh", "-c", "/bin/sleep 300 & echo $!"]);
    const member = Number((await readFirstLine(orphaned.child as ChildProcessByStdio<null, Readable, null>)).trim());
    CHILD_PIDS.add(member);
    await new Promise((resolve) => orphaned.child.once("exit", resolve));
    // The first process-table read fails; the reaper must ask again.
    const shim = path.join(dir, "bin");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "ps"), `#!/bin/sh\nif [ ! -f ${JSON.stringify(path.join(dir, "failed-once"))} ]; then : > ${JSON.stringify(path.join(dir, "failed-once"))}; exit 1; fi\nexec /bin/ps "$@"\n`, { mode: 0o755 });

    const reaper = spawn(process.execPath, ["--import", TSX_LOADER_URL, REAPER_SOURCE], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, PATH: [shim, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":") },
    });
    CHILD_PIDS.add(reaper.pid!);
    const reaperExit = new Promise<void>((resolve) => reaper.once("exit", () => resolve()));
    const line = (message: unknown) => reaper.stdin!.write(`${JSON.stringify(message)}\n`);
    line({ hello: { consolePid, lockFile, lockStartedAt } });
    for (const entry of [owned, reused, orphaned]) line({ add: entry.group });
    line({ leaderExited: { pgid: orphaned.group.pgid, at: Date.now() } });
    reaper.stdin!.end();

    const ended = await Promise.race([reaperExit.then(() => true), delay(REAPER_DRAIN_MAX_MS + 5_000).then(() => false)]);
    expect(ended, "the reaper exits within its drain cap").toBe(true);
    expect(isRunning(owned.group.pgid), "a proven group whose leader runs is ended").toBe(false);
    expect(isRunning(member), "a proven group whose leader exited is ended after a failed table read").toBe(false);
    expect(isRunning(reused.group.pgid), "a registration its process does not match is never signalled").toBe(true);
    expect(fs.existsSync(path.join(dir, "failed-once"))).toBe(true);
    expect(readConsoleExitRecord(lockFile, { pid: consolePid, lockStartedAt })?.outcome).toBe("external");
  }, 30_000);

  // After the owned groups, the deadline SIGKILLs what no one registered. Only this Console's own descendants that stay in its
  // process group qualify: never the group as a whole (a Desktop sidecar shares Desktop's group), never a child that leads a
  // group of its own (an owned group, the update worker and the Console it starts, a PTY session), never the ps that
  // produced the table.
  it("limits the deadline's fallback SIGKILL to unregistered descendants that stay in the Console's process group", () => {
    const rows = [
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: 500, ppid: 1, pgid: 500 }, // Desktop
      { pid: 600, ppid: 500, pgid: 500 }, // the Console sidecar, in Desktop's group
      { pid: 601, ppid: 500, pgid: 500 }, // another child of Desktop
      { pid: 610, ppid: 600, pgid: 500 }, // an unregistered tool call
      { pid: 611, ppid: 610, pgid: 500 }, // its child
      { pid: 615, ppid: 600, pgid: 615 }, // an owned agent CLI group
      { pid: 616, ppid: 615, pgid: 615 }, // its MCP child
      { pid: 620, ppid: 600, pgid: 620 }, // detached update worker
      { pid: 621, ppid: 620, pgid: 620 }, // the Console the worker starts
      { pid: 630, ppid: 600, pgid: 630 }, // PTY session leader
      { pid: 631, ppid: 630, pgid: 630 }, // a process in that terminal
      { pid: 640, ppid: 600, pgid: 500 }, // the ps that listed this table
    ];
    expect(selectSameGroupDescendants(rows, 600, [640]).sort((left, right) => left - right)).toEqual([610, 611]);
    expect(selectSameGroupDescendants(rows.filter((row) => row.pid !== 600), 600)).toEqual([]);
  });

  // The deadline signals a registered group whose leader already exited only when the process table proves the members are
  // that group's: a number now held by a live process (the leader's pid reused) or members that started before the group
  // was spawned mean the number names someone else's group, which is never signalled (I1).
  it("signals an exited-leader group only when its members prove to be that group's", () => {
    const spawnedAt = Date.UTC(2026, 9, 5, 12, 0, 0);
    const group = { pgid: 700, spawnedAt };
    const member = { pid: 701, pgid: 700, startedAt: spawnedAt + 1_000 };
    expect(proveExitedLeaderGroup([member], group, spawnedAt + 60_000)).toBe(true);
    expect(proveExitedLeaderGroup([{ pid: 700, pgid: 700, startedAt: spawnedAt + 30_000 }, member], group, spawnedAt + 60_000)).toBe(false);
    expect(proveExitedLeaderGroup([member, { pid: 702, pgid: 700, startedAt: spawnedAt - 600_000 }], group, spawnedAt + 60_000)).toBe(false);
    expect(proveExitedLeaderGroup([], group, spawnedAt + 60_000)).toBe(false);
    expect(proveExitedLeaderGroup([{ pid: 2, pgid: 1, startedAt: spawnedAt }], { pgid: 1, spawnedAt }, spawnedAt + 60_000)).toBe(false);
  });
});

function createFixturePaths(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-console-lifecycle-${name}-`));
  TEMP_DIRS.push(dir);
  const pidFile = path.join(dir, "child.pid");
  const releaseFile = path.join(dir, "release");
  const stallFile = path.join(dir, "stall");
  const env = {
    ...process.env,
    FLEET_CONSOLE_DATA_DIR: dir,
    FLEET_TEST_CONSOLE_PID_FILE: pidFile,
    FLEET_TEST_CONSOLE_RELEASE_FILE: releaseFile,
    FLEET_TEST_CONSOLE_STALL_FILE: stallFile,
  };
  const lockFile = createConsolePaths({ env }).lockFile;
  return { dir, env, pidFile, releaseFile, stallFile, lockFile };
}

function spawnIdleProcess(): number {
  const idle = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  CHILD_PIDS.add(idle.pid!);
  return idle.pid!;
}

/** A loopback port nothing listens on, so the lock's endpoint refuses connections. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function readFirstLine(child: ChildProcessByStdio<null, Readable, null>): Promise<string> {
  let output = "";
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`reclaimer printed no outcome: ${output}`)), 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(output.slice(0, newline));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`reclaimer exited with ${code}: ${output}`));
    });
  });
}

/** A pid that just exited: the Console a reaper outlives. */
async function deadProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

/** Alive and not a zombie this test still has to reap. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return state.length > 0 && !state.startsWith("Z");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPidWhenReady(pidFile: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // fixture가 Node에서 부팅되는 동안 기다린다.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("controlled Console child did not publish its pid");
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`controlled Console child ${pid} is still alive`);
}

function expectFileCanBeRenamed(filePath: string): void {
  const renamed = `${filePath}.renamed`;
  fs.renameSync(filePath, renamed);
  fs.renameSync(renamed, filePath);
}
