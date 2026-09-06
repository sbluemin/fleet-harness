import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleLockPayload } from "../core/host/console-contract-types.js";
import {
  buildConsoleHelpText,
  assertCliCanControlDaemon,
  createConsoleDaemonLifecycle,
  type ConsoleDaemonLifecycleDeps,
  type ConsoleDaemonProcess,
  isCliDirectRun,
  isLockProcessAlive,
  main,
  openFleetConsole,
  parseConsoleCliMode,
  parseConsoleHookCommand,
  runConsoleStatus,
  runConsoleStop,
} from "../core/host/cli.js";
import { defaultSpawnBrowser, openBrowser } from "../core/host/browser.js";
import { describeConsoleLaunch, describeDaemonStartFailure, formatFailureNotice } from "../core/host/failure-notice.js";
import { createConsoleLock } from "../core/host/lock.js";
import { createConsolePaths } from "../core/host/paths.js";

const LOCK: ConsoleLockPayload = {
  pid: 1234,
  host: "127.0.0.1",
  port: 37283,
  endpoint: "http://127.0.0.1:37283/",
  startedAt: 1,
  token: "bootstrap-token",
  version: "test",
};
const TEMP_DIRS: string[] = [];

function createFakeDaemonProcess(pid: number | undefined, onKill?: (signal: NodeJS.Signals | number | undefined, child: EventEmitter) => void) {
  const events = new EventEmitter();
  const kill = vi.fn((signal?: NodeJS.Signals | number) => {
    onKill?.(signal, events);
    return true;
  });
  const unref = vi.fn();
  const child = Object.assign(events, { pid, kill, unref }) as EventEmitter & ConsoleDaemonProcess;
  return { child, kill, unref, events };
}

function withPid(lock: ConsoleLockPayload, pid: number): ConsoleLockPayload {
  return { ...lock, pid };
}

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("fleet console CLI", () => {

  it("treats only dead lock processes as cleanable so a crashed desktop sidecar cannot brick the CLI", () => {
    // 살아있는 pid(자기 자신)는 보호 대상, 존재하지 않는 pid는 stale lock 정리 대상이다.
    expect(isLockProcessAlive(process.pid)).toBe(true);
    let deadPid = process.pid + 40_000;
    for (; deadPid < process.pid + 41_000; deadPid++) {
      try {
        process.kill(deadPid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") break;
      }
    }
    expect(isLockProcessAlive(deadPid)).toBe(false);
  });

  describe("daemon startup lifecycle", () => {
    it("waits beyond the old three-second boundary and releases only after readiness", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-delayed-ready-"));
      TEMP_DIRS.push(dir);
      const ownLock = withPid(LOCK, 4311);
      const fake = createFakeDaemonProcess(ownLock.pid);
      let clock = 0;
      const lifecycle = createConsoleDaemonLifecycle({
        env: { FLEET_CONSOLE_DATA_DIR: dir },
        serverModulePath: "/pkg/dist/cli.mjs",
        spawnDaemon: () => fake.child,
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        startupTimeoutMs: 60_000,
        health: {
          probe: async () => clock >= 3_100
            ? { healthy: true, lock: ownLock }
            : { healthy: false, lock: null, error: "lock missing" },
        },
      });

      await expect(lifecycle.ensureDaemon()).resolves.toBe(ownLock.endpoint);

      expect(clock).toBe(3_100);
      expect(fake.kill).not.toHaveBeenCalled();
      expect(fake.unref).toHaveBeenCalledTimes(1);
    });

    it("fails promptly when the child exits before readiness", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-early-exit-"));
      TEMP_DIRS.push(dir);
      const fake = createFakeDaemonProcess(4312);
      let clock = 0;
      let emitted = false;
      const lifecycle = createConsoleDaemonLifecycle({
        env: { FLEET_CONSOLE_DATA_DIR: dir },
        serverModulePath: "/pkg/dist/cli.mjs",
        spawnDaemon: () => fake.child,
        sleep: async (ms) => {
          clock += ms;
          if (!emitted) {
            emitted = true;
            fake.events.emit("exit", 7, null);
          }
        },
        now: () => clock,
        startupTimeoutMs: 60_000,
        health: { probe: async () => ({ healthy: false, lock: null, error: "lock missing" }) },
      });

      await expect(lifecycle.ensureDaemon()).rejects.toThrow("exited with status 7");

      expect(clock).toBeLessThan(60_000);
      expect(fake.kill).not.toHaveBeenCalled();
      expect(fake.unref).toHaveBeenCalledTimes(1);
    });

    it("adopts a concurrent healthy winner after cleaning only its own child", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-concurrent-winner-"));
      TEMP_DIRS.push(dir);
      const paths = createConsolePaths({ env: { FLEET_CONSOLE_DATA_DIR: dir } });
      const replacement = createConsoleLock().writeLock({
        dir,
        lockFile: paths.lockFile,
        pid: 9877,
        port: 40124,
        endpoint: "http://127.0.0.1:40124/",
        version: "replacement",
      }).payload;
      fs.rmSync(paths.lockFile);
      const fake = createFakeDaemonProcess(4315, (_signal, child) => child.emit("exit", 0, null));
      let clock = 0;
      const lifecycle = createConsoleDaemonLifecycle({
        env: { FLEET_CONSOLE_DATA_DIR: dir },
        serverModulePath: "/pkg/dist/cli.mjs",
        spawnDaemon: () => fake.child,
        sleep: async (ms) => {
          clock += ms;
          if (!fs.existsSync(paths.lockFile)) {
            fs.writeFileSync(paths.lockFile, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
          }
        },
        now: () => clock,
        startupTimeoutMs: 1_000,
        health: {
          probe: async (payload) => payload
            ? { healthy: true, lock: payload }
            : { healthy: false, lock: null, error: "lock missing" },
        },
      });

      await expect(lifecycle.ensureDaemon()).resolves.toBe(replacement.endpoint);

      expect(fake.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM"]);
      expect(fake.unref).toHaveBeenCalledTimes(1);
      expect(createConsoleLock().readLock(paths.lockFile)?.pid).toBe(replacement.pid);
    });
  });

  it("ensures the server and opens the console URL without browser tokens", async () => {
    const calls: string[] = [];
    const opened: string[] = [];

    const result = await openFleetConsole({
      lifecycle: {
        ensureDaemon: async () => {
          calls.push("ensure");
          return LOCK.endpoint;
        },
        probe: async () => {
          calls.push("probe");
          return { healthy: true, lock: LOCK, buildStale: false };
        },
      },
      openBrowser: (url) => {
        opened.push(url);
      },
    });

    expect(calls).toEqual(["ensure", "probe"]);
    expect(opened).toEqual(["http://127.0.0.1:37283/console/"]);
    expect(result.url).toBe(opened[0]);
    expect(opened[0]).not.toContain("#");
  });

  // 실패 화법 계약: 사용자에게 도달하는 실패는 무슨 일 · 왜 · 지금 할 일 세 조각을 갖는다.
  // 기계 코드만 던지던 예전 문구로 되돌리면 아래 세 건이 모두 깨진다.

  it("stops the console server", async () => {
    const calls: string[] = [];
    const text = await runConsoleStop({
      lifecycle: {
        stop: async () => {
          calls.push("stop");
        },
      },
    });
    expect(calls).toEqual(["stop"]);
    expect(text).toContain("stopped");
  });
});
