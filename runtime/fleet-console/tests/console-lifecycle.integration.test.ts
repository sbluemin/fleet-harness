import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createConsoleDaemonLifecycle, type ConsoleDaemonProcess } from "../core/host/bootstrap/console-lifecycle.js";
import { createConsoleLock } from "../core/host/bootstrap/lock.js";
import { createConsolePaths } from "../core/host/bootstrap/paths.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/controlled-console-child.mjs", import.meta.url));
const CLAIMANT_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/lock-reclaim-claimant.ts", import.meta.url));
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
      env: fixture.env,
      serverModulePath: FIXTURE_PATH,
      startupTimeoutMs: 8_000,
      pollIntervalMs: 20,
      cleanupGraceMs: 500,
      shutdownTimeoutMs: 300,
      report: () => {},
    });

    const startedAt = Date.now();
    const ensure = lifecycle.ensureDaemon();
    void ensure.catch(() => {});
    const pid = await readPidWhenReady(fixture.pidFile);
    CHILD_PIDS.add(pid);
    await delay(3_100);
    fs.writeFileSync(fixture.releaseFile, "ready\n", "utf8");

    const endpoint = await ensure;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_000);
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(createConsoleLock().readLock(fixture.lockFile)?.pid).toBe(pid);

    // SIGTERM을 받은 Console이 listener만 닫고 lock을 쥔 채 멈춘다. SIGTERM 전에 증명한 그 프로세스이므로 강제 종료한다.
    // Windows의 SIGTERM은 TerminateProcess라 정리가 아예 돌지 않는다 — 멈출 정리가 없으니 강제 종료도 아니며, 남은 lock은
    // 끝난 pid의 것이라 stop이 치운다. 정체를 SIGKILL로 끝내는 계약은 POSIX에서만 성립한다.
    fs.writeFileSync(fixture.stallFile, "stall\n", "utf8");
    expect(await lifecycle.stop()).toEqual(process.platform === "win32" ? { forced: false } : { forced: true, shutdownTimeoutMs: 300 });
    await expectProcessGone(pid);
    CHILD_PIDS.delete(pid);
    expect(createConsoleLock().readLock(fixture.lockFile)).toBeNull();
    expectFileCanBeRenamed(fixture.pidFile);
  });

  it("terminates the real pre-lock child when readiness reaches its deadline", async () => {
    const fixture = createFixturePaths("timeout");
    const lifecycle = createConsoleDaemonLifecycle({
      env: fixture.env,
      serverModulePath: FIXTURE_PATH,
      startupTimeoutMs: 4_000,
      pollIntervalMs: 20,
      cleanupGraceMs: 500,
    });

    const ensure = lifecycle.ensureDaemon();
    void ensure.catch(() => {});
    const pid = await readPidWhenReady(fixture.pidFile);
    CHILD_PIDS.add(pid);

    await expect(ensure).rejects.toThrow("did not become healthy within 4 seconds");
    await expectProcessGone(pid);
    CHILD_PIDS.delete(pid);
    expect(createConsoleLock().readLock(fixture.lockFile)).toBeNull();
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
    expect(consoleLock.readLock(fixture.lockFile)?.pid).toBe(bystanderPid);

    // 아무도 lock 주소를 듣지 않는데 lock을 쓰기 전에 시작한 pid가 살아 있으면, listener를 닫고 정리 중이거나 멈춘 Console과
    // 구별되지 않는다. 신호도 lock 삭제도 하지 않는다 — 지우면 다음 start가 살아 있는 Console 옆에 두 번째 Console을 띄운다.
    await new Promise<void>((resolve) => impostor.close(() => resolve()));
    await expect(lifecycle.stop()).rejects.toThrow(`lock pid ${bystanderPid} is alive but did not prove it owns`);
    expect(consoleLock.readLock(fixture.lockFile)?.pid).toBe(bystanderPid);

    // A pid that started after the lock was written cannot be its author, but while that pid lives the lock stays: only
    // ESRCH right before the unlink grants deletion. start refuses instead of booting a Console beside it.
    fs.rmSync(fixture.lockFile);
    await createConsoleLock({ now: () => Date.now() - 60_000 }).acquireLock(lockInput);
    fs.writeFileSync(fixture.releaseFile, "ready\n", "utf8");
    await expect(lifecycle.ensureDaemon()).rejects.toThrow(`lock pid ${bystanderPid} is alive but did not prove it owns`);
    expect(consoleLock.readLock(fixture.lockFile)?.pid).toBe(bystanderPid);
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
    expect(consoleLock.readLock(fixture.lockFile)?.pid).toBe(bystanderPid);

    // The lock is dead now, yet no other reclaimer may take over while that claimant is alive: start fails and keeps it.
    process.kill(bystanderPid, "SIGKILL");
    await expectProcessGone(bystanderPid);
    CHILD_PIDS.delete(bystanderPid);
    fs.writeFileSync(fixture.releaseFile, "ready\n", "utf8");
    const lifecycle = createConsoleDaemonLifecycle({ env: fixture.env, serverModulePath: FIXTURE_PATH, startupTimeoutMs: 8_000, pollIntervalMs: 20, report: () => {} });
    await expect(lifecycle.ensureDaemon()).rejects.toThrow();
    expect(consoleLock.readLock(fixture.lockFile)?.pid).toBe(bystanderPid);
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
    expect(consoleLock.readLock(fixture.lockFile)?.pid).toBe(consolePid);

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
    expect(createConsoleLock().readLock(fixture.lockFile)).toEqual(reusedLock);
    expect(signals).toEqual([]);
    expect(() => process.kill(bystanderPid, 0)).not.toThrow();
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
