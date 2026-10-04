import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createConsoleDaemonLifecycle } from "../core/host/bootstrap/console-lifecycle.js";
import { createConsoleLock } from "../core/host/bootstrap/lock.js";
import { createConsolePaths } from "../core/host/bootstrap/paths.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/controlled-console-child.mjs", import.meta.url));
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
    fs.writeFileSync(fixture.stallFile, "stall\n", "utf8");
    await lifecycle.stop();
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
    const consoleLock = createConsoleLock();
    consoleLock.writeLock({ dir: fixture.dir, lockFile: fixture.lockFile, pid: bystanderPid, port, endpoint: `http://127.0.0.1:${port}/`, version: "crashed" });
    const lifecycle = createConsoleDaemonLifecycle({ env: fixture.env, serverModulePath: FIXTURE_PATH });

    await expect(lifecycle.stop()).rejects.toThrow(`lock pid ${bystanderPid} is alive but did not prove it owns`);
    expect(consoleLock.readLock(fixture.lockFile)?.pid).toBe(bystanderPid);

    // 아무도 lock 주소를 듣지 않아도 pid가 살아 있으면 listener를 닫고 정리 중이거나 멈춘 Console과 구별되지 않는다.
    // 신호도 lock 삭제도 하지 않는다 — 이 lock을 지우면 다음 start가 살아 있는 Console 옆에 두 번째 Console을 띄운다.
    await new Promise<void>((resolve) => impostor.close(() => resolve()));
    await expect(lifecycle.stop()).rejects.toThrow(`lock pid ${bystanderPid} is alive but did not prove it owns`);
    expect(consoleLock.readLock(fixture.lockFile)?.pid).toBe(bystanderPid);
    expect(bystanderSignal).toBeNull();
    expect(() => process.kill(bystanderPid, 0)).not.toThrow();

    // lock pid가 끝난 stale lock은 신호 없이 파일만 치운다(크래시 복구).
    bystander.kill("SIGKILL");
    await expectProcessGone(bystanderPid);
    CHILD_PIDS.delete(bystanderPid);
    await lifecycle.stop();
    expect(consoleLock.readLock(fixture.lockFile)).toBeNull();
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
