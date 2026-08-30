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
  it("treats symlink and platform-alias argv paths as a direct CLI run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-direct-run-"));
    TEMP_DIRS.push(dir);
    const target = path.join(dir, "cli.mjs");
    const link = path.join(dir, "fleet-console");
    fs.writeFileSync(target, "// fixture\n");
    fs.symlinkSync(target, link);

    expect(isCliDirectRun(undefined)).toBe(false);
    expect(isCliDirectRun(target, pathToFileURL(target).href)).toBe(true);
    expect(isCliDirectRun(link, pathToFileURL(target).href)).toBe(true);
    expect(isCliDirectRun(path.join(dir, "missing"), pathToFileURL(target).href)).toBe(false);
    expect(isCliDirectRun(path.join(dir, "other.mjs"), pathToFileURL(target).href)).toBe(false);
  });

  it("allows stop or restart control of a desktop-provenance daemon", () => {
    expect(() => assertCliCanControlDaemon({
      ...LOCK,
      owner: { kind: "desktop", id: "desktop-owner-1", protocolVersion: 1 },
    })).not.toThrow();
    expect(() => assertCliCanControlDaemon(LOCK)).not.toThrow();
  });

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

  it("parses subcommands and help flags, rejecting unknown commands", () => {
    expect(parseConsoleCliMode([])).toBe("start");
    expect(parseConsoleCliMode(["start"])).toBe("start");
    expect(parseConsoleCliMode(["stop"])).toBe("stop");
    expect(parseConsoleCliMode(["restart"])).toBe("restart");
    expect(parseConsoleCliMode(["status"])).toBe("status");
    expect(parseConsoleCliMode(["--help"])).toBe("help");
    expect(parseConsoleCliMode(["-h"])).toBe("help");
    expect(() => parseConsoleCliMode(["--stop"])).toThrow("Unknown fleet console command: --stop");
    expect(() => parseConsoleCliMode(["start", "--bogus"])).toThrow("Unknown fleet console option: --bogus");
  });

  it("parses hook capture-session commands", () => {
    expect(parseConsoleHookCommand(["capture-session", "claude"])).toEqual({ command: "capture-session", provider: "claude" });
    expect(() => parseConsoleHookCommand(["capture-session", "codex"])).toThrow("Unknown fleet-console hook command");
    expect(parseConsoleHookCommand(["background-report"])).toEqual({ command: "background-report" });
    expect(() => parseConsoleHookCommand(["background-report", "extra"])).toThrow("Unknown fleet-console hook command");
    // 퇴역한 이름은 in-flight 세션의 hooks.json이 여전히 부른다. 예외로 죽이지 않고 별개 명령으로 남긴다.
    expect(parseConsoleHookCommand(["background-spawn"])).toEqual({ command: "background-spawn" });
    expect(parseConsoleHookCommand(["background-stop"])).toEqual({ command: "background-stop" });
    expect(() => parseConsoleHookCommand(["background-spawn", "extra"])).toThrow("Unknown fleet-console hook command");
    expect(() => parseConsoleHookCommand(["background-stop", "extra"])).toThrow("Unknown fleet-console hook command");
    expect(parseConsoleHookCommand(["attention"])).toEqual({ command: "attention" });
    expect(() => parseConsoleHookCommand(["attention", "extra"])).toThrow("Unknown fleet-console hook command");
    expect(() => parseConsoleHookCommand(["capture-session"])).toThrow("Unknown fleet-console hook command");
    expect(() => parseConsoleHookCommand(["capture-session", "cursor"])).toThrow("Unknown fleet-console hook command");
    expect(() => parseConsoleHookCommand(["subagents-context"])).toThrow("Unknown fleet-console hook command");
  });

  it("posts capture-session hooks to the session-scoped capture endpoint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-capture-hook-"));
    TEMP_DIRS.push(dir);
    const paths = createConsolePaths({ env: { FLEET_CONSOLE_DATA_DIR: dir } });
    const lock = createConsoleLock().writeLock({
      dir: paths.dir,
      lockFile: paths.lockFile,
      pid: process.pid,
      port: 51239,
      endpoint: "http://127.0.0.1:51239/",
      version: "test",
    });
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const originalArgv = process.argv;
    const originalFetch = globalThis.fetch;
    const originalConsoleDir = process.env.FLEET_CONSOLE_DIR;
    const originalConsoleDataDir = process.env.FLEET_CONSOLE_DATA_DIR;
    const originalSessionId = process.env.FLEET_CONSOLE_SESSION_ID;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    process.argv = ["node", "fleet-console", "hook", "capture-session", "claude"];
    process.env.FLEET_CONSOLE_DATA_DIR = dir;
    delete process.env.FLEET_CONSOLE_DIR;
    process.env.FLEET_CONSOLE_SESSION_ID = "session-x";
    try {
      await main();
    } finally {
      process.argv = originalArgv;
      globalThis.fetch = originalFetch;
      if (originalConsoleDir === undefined) delete process.env.FLEET_CONSOLE_DIR;
      else process.env.FLEET_CONSOLE_DIR = originalConsoleDir;
      if (originalConsoleDataDir === undefined) delete process.env.FLEET_CONSOLE_DATA_DIR;
      else process.env.FLEET_CONSOLE_DATA_DIR = originalConsoleDataDir;
      if (originalSessionId === undefined) delete process.env.FLEET_CONSOLE_SESSION_ID;
      else process.env.FLEET_CONSOLE_SESSION_ID = originalSessionId;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:51239/plugins/terminal/agent/sessions/session-x/capture");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${lock.payload.token}`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ provider: "claude" });
  });

  it("posts the background report, including under the retired hook names, to the session-scoped endpoint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-background-hook-"));
    TEMP_DIRS.push(dir);
    const paths = createConsolePaths({ env: { FLEET_CONSOLE_DATA_DIR: dir } });
    createConsoleLock().writeLock({
      dir: paths.dir,
      lockFile: paths.lockFile,
      pid: process.pid,
      port: 51240,
      endpoint: "http://127.0.0.1:51240/",
      version: "test",
    });
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const originalArgv = process.argv;
    const originalFetch = globalThis.fetch;
    const originalConsoleDir = process.env.FLEET_CONSOLE_DIR;
    const originalConsoleDataDir = process.env.FLEET_CONSOLE_DATA_DIR;
    const originalSessionId = process.env.FLEET_CONSOLE_SESSION_ID;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    process.env.FLEET_CONSOLE_DATA_DIR = dir;
    delete process.env.FLEET_CONSOLE_DIR;
    process.env.FLEET_CONSOLE_SESSION_ID = "session-background";
    try {
      for (const command of ["background-report", "background-spawn", "background-stop"] as const) {
        process.argv = ["node", "fleet-console", "hook", command];
        await main();
      }
    } finally {
      process.argv = originalArgv;
      globalThis.fetch = originalFetch;
      if (originalConsoleDir === undefined) delete process.env.FLEET_CONSOLE_DIR;
      else process.env.FLEET_CONSOLE_DIR = originalConsoleDir;
      if (originalConsoleDataDir === undefined) delete process.env.FLEET_CONSOLE_DATA_DIR;
      else process.env.FLEET_CONSOLE_DATA_DIR = originalConsoleDataDir;
      if (originalSessionId === undefined) delete process.env.FLEET_CONSOLE_SESSION_ID;
      else process.env.FLEET_CONSOLE_SESSION_ID = originalSessionId;
    }

    // 새 이름은 hook payload를 해석 없이 그대로 넘기고, 퇴역한 이름은 퇴역 당시의 {event} 본문을 유지한다 —
    // 업그레이드를 넘겨 살아남은 구 데몬이 그 세션의 hook을 계속 받고 있고, 그 서버는 {event}만 이해한다.
    expect(calls.map((call) => ({
      url: call.url,
      method: call.init?.method,
      body: JSON.parse(String(call.init?.body)) as Record<string, unknown>,
    }))).toEqual([
      {
        url: "http://127.0.0.1:51240/plugins/terminal/agent/sessions/session-background/background",
        method: "POST",
        body: { input: "" },
      },
      {
        url: "http://127.0.0.1:51240/plugins/terminal/agent/sessions/session-background/background",
        method: "POST",
        body: { event: "spawn" },
      },
      {
        url: "http://127.0.0.1:51240/plugins/terminal/agent/sessions/session-background/background",
        method: "POST",
        body: { event: "stop" },
      },
    ]);
  });

  it("documents the usage entry points and subcommands in help text", () => {
    const helpText = buildConsoleHelpText();
    expect(helpText).toContain("fleet console");
    expect(helpText).toContain("fleet-console");
    expect(helpText).toContain("start");
    expect(helpText).toContain("stop");
    expect(helpText).toContain("restart");
    expect(helpText).toContain("status");
    expect(helpText).toMatch(/Fleet Console · .+ · (local|stable)/);
    expect(helpText).not.toContain("Gateway");
  });

  it.each([
    { env: { FLEET_CONSOLE_DIR: "__DIR__" }, expectedEnv: { FLEET_CONSOLE_DIR: "__DIR__", NODE_USE_SYSTEM_CA: "1" } },
    { env: { FLEET_CONSOLE_DIR: "__DIR__", FLEET_CONSOLE_NO_SYSTEM_CA: "1" }, expectedEnv: { FLEET_CONSOLE_DIR: "__DIR__", FLEET_CONSOLE_NO_SYSTEM_CA: "1" } },
    { env: { FLEET_CONSOLE_DIR: "__DIR__", NODE_USE_SYSTEM_CA: "0" }, expectedEnv: { FLEET_CONSOLE_DIR: "__DIR__", NODE_USE_SYSTEM_CA: "0" } },
  ])("passes the configured system CA environment to the daemon: $expectedEnv", async ({ env, expectedEnv }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-system-ca-"));
    TEMP_DIRS.push(dir);
    const spawnDetached = vi.fn<NonNullable<ConsoleDaemonLifecycleDeps["spawnDetached"]>>();
    let clock = 0;
    const lifecycle = createConsoleDaemonLifecycle({
      env: { ...env, FLEET_CONSOLE_DIR: dir },
      execPath: "/node",
      serverModulePath: "/pkg/dist/cli.mjs",
      spawnDetached,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      startupTimeoutMs: 200,
      health: { probe: async () => ({ healthy: false, lock: null, error: "lock missing" }) },
    });

    await expect(lifecycle.ensureDaemon()).rejects.toThrow("Fleet Console server did not start.");

    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(spawnDetached.mock.calls[0]?.[2]).toEqual({
      detached: true,
      env: { ...expectedEnv, FLEET_CONSOLE_DIR: dir },
      stdio: "ignore",
      windowsHide: true,
    });
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

    it("reports a spawn error without waiting for the readiness deadline", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-spawn-error-"));
      TEMP_DIRS.push(dir);
      const fake = createFakeDaemonProcess(undefined);
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
            fake.events.emit("error", new Error("spawn /node ENOENT"));
          }
        },
        now: () => clock,
        startupTimeoutMs: 60_000,
        health: { probe: async () => ({ healthy: false, lock: null, error: "lock missing" }) },
      });

      await expect(lifecycle.ensureDaemon()).rejects.toThrow("could not be spawned — spawn /node ENOENT");

      expect(clock).toBeLessThan(60_000);
      expect(fake.kill).not.toHaveBeenCalled();
      expect(fake.unref).toHaveBeenCalledTimes(1);
    });

    it("uses one hard deadline and escalates cleanup from TERM to KILL", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-start-timeout-"));
      TEMP_DIRS.push(dir);
      const fake = createFakeDaemonProcess(4313, (signal, child) => {
        if (signal === "SIGKILL") child.emit("exit", null, "SIGKILL");
      });
      let clock = 0;
      const lifecycle = createConsoleDaemonLifecycle({
        env: { FLEET_CONSOLE_DATA_DIR: dir },
        serverModulePath: "/pkg/dist/cli.mjs",
        spawnDaemon: () => fake.child,
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        startupTimeoutMs: 300,
        cleanupGraceMs: 25,
        health: { probe: async () => ({ healthy: false, lock: null, error: "lock missing" }) },
      });

      await expect(lifecycle.ensureDaemon()).rejects.toThrow("within 300 ms — lock missing");

      expect(fake.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(fake.unref).toHaveBeenCalledTimes(1);
      expect(clock).toBe(325);
    });

    it("preserves a replacement lock while cleaning the child it spawned", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-replacement-lock-"));
      TEMP_DIRS.push(dir);
      const paths = createConsolePaths({ env: { FLEET_CONSOLE_DATA_DIR: dir } });
      const replacement = createConsoleLock().writeLock({
        dir,
        lockFile: paths.lockFile,
        pid: 9876,
        port: 40123,
        endpoint: "http://127.0.0.1:40123/",
        version: "replacement",
      }).payload;
      fs.rmSync(paths.lockFile);
      const fake = createFakeDaemonProcess(4314, (_signal, child) => child.emit("exit", 0, null));
      let clock = 0;
      let replacementWritten = false;
      const lifecycle = createConsoleDaemonLifecycle({
        env: { FLEET_CONSOLE_DATA_DIR: dir },
        serverModulePath: "/pkg/dist/cli.mjs",
        spawnDaemon: () => fake.child,
        sleep: async (ms) => {
          clock += ms;
          if (clock >= 200 && !replacementWritten) {
            replacementWritten = true;
            fs.writeFileSync(paths.lockFile, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
          }
        },
        now: () => clock,
        startupTimeoutMs: 200,
        health: { probe: async (payload) => ({ healthy: false, lock: payload, error: "health failed: 503" }) },
      });

      await expect(lifecycle.ensureDaemon()).rejects.toThrow("Fleet Console server did not start");

      expect(createConsoleLock().readLock(paths.lockFile)?.pid).toBe(replacement.pid);
      expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
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

    it("retries a partial lock until the owned child becomes healthy", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-probe-error-"));
      TEMP_DIRS.push(dir);
      const paths = createConsolePaths({ env: { FLEET_CONSOLE_DATA_DIR: dir } });
      const ownLock = withPid(LOCK, 4316);
      const fake = createFakeDaemonProcess(ownLock.pid);
      let clock = 0;
      let sleeps = 0;
      const lifecycle = createConsoleDaemonLifecycle({
        env: { FLEET_CONSOLE_DATA_DIR: dir },
        serverModulePath: "/pkg/dist/cli.mjs",
        spawnDaemon: () => fake.child,
        sleep: async (ms) => {
          clock += ms;
          sleeps += 1;
          if (sleeps === 1) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(paths.lockFile, "", { mode: 0o600 });
          } else if (sleeps === 2) {
            fs.writeFileSync(paths.lockFile, `${JSON.stringify(ownLock)}\n`, "utf8");
          }
        },
        now: () => clock,
        startupTimeoutMs: 1_000,
        cleanupGraceMs: 25,
        health: {
          probe: async (payload) => payload
            ? { healthy: true, lock: payload }
            : { healthy: false, lock: null, error: "lock missing" },
        },
      });

      await expect(lifecycle.ensureDaemon()).resolves.toBe(ownLock.endpoint);

      expect(clock).toBe(200);
      expect(fake.kill).not.toHaveBeenCalled();
      expect(fake.unref).toHaveBeenCalledTimes(1);
    });

    it("preserves the last real probe error when the deadline has no budget left", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-last-probe-"));
      TEMP_DIRS.push(dir);
      const fake = createFakeDaemonProcess(4317, (signal, child) => {
        if (signal === "SIGKILL") child.emit("exit", null, "SIGKILL");
      });
      let clock = 0;
      let probes = 0;
      const lifecycle = createConsoleDaemonLifecycle({
        env: { FLEET_CONSOLE_DATA_DIR: dir },
        serverModulePath: "/pkg/dist/cli.mjs",
        spawnDaemon: () => fake.child,
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        startupTimeoutMs: 200,
        cleanupGraceMs: 25,
        health: {
          probe: async () => {
            probes += 1;
            return { healthy: false, lock: null, error: probes === 1 ? "lock missing" : "connect ECONNREFUSED" };
          },
        },
      });

      await expect(lifecycle.ensureDaemon()).rejects.toThrow("within 200 ms — connect ECONNREFUSED");

      expect(probes).toBe(2);
    });

    it("reports cleanup failure accurately when a concurrent server is healthy", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-winner-cleanup-"));
      TEMP_DIRS.push(dir);
      const winner = withPid(LOCK, 9878);
      const fake = createFakeDaemonProcess(4318);
      let clock = 0;
      let probes = 0;
      const lifecycle = createConsoleDaemonLifecycle({
        env: { FLEET_CONSOLE_DATA_DIR: dir },
        serverModulePath: "/pkg/dist/cli.mjs",
        spawnDaemon: () => fake.child,
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        startupTimeoutMs: 1_000,
        cleanupGraceMs: 10,
        health: {
          probe: async () => {
            probes += 1;
            return probes === 1
              ? { healthy: false, lock: null, error: "lock missing" }
              : { healthy: true, lock: winner };
          },
        },
      });

      const start = lifecycle.ensureDaemon();
      await expect(start).rejects.toThrow("Fleet Console is running, but startup cleanup failed");
      await expect(start).rejects.toThrow(`${winner.endpoint}console/`);

      expect(fake.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(fake.unref).toHaveBeenCalledTimes(1);
    });

    it("does not unlink when PID-guarded cleanup observes no lock", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-absent-lock-"));
      TEMP_DIRS.push(dir);
      const lockFile = path.join(dir, "console.lock");
      const rmSync = vi.fn<typeof fs.rmSync>(fs.rmSync.bind(fs));
      const guardedLock = createConsoleLock({ fs: { ...fs, rmSync } as typeof fs });

      guardedLock.removeLock(lockFile, 4319);

      expect(rmSync).not.toHaveBeenCalled();
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
  describe("failure notices", () => {
    it("tells a daemon start failure apart by whether the process ever spawned", () => {
      const spawnFailed = describeDaemonStartFailure({
        spawnError: "spawn /node ENOENT",
        childError: null,
        readinessError: null,
        probeError: null,
        cleanupError: null,
        healthyEndpoint: null,
        dataDir: "/tmp/fleet",
        startupTimeoutMs: 60_000,
      });
      expect(spawnFailed).toContain("Fleet Console server did not start.");
      expect(spawnFailed).toContain("the server process could not be spawned — spawn /node ENOENT");
      expect(spawnFailed).toContain("node --version");

      const neverAnswered = describeDaemonStartFailure({
        spawnError: null,
        childError: null,
        readinessError: null,
        probeError: "lock missing",
        cleanupError: null,
        healthyEndpoint: null,
        dataDir: "/tmp/fleet",
        startupTimeoutMs: 60_000,
      });
      expect(neverAnswered).toContain("did not become healthy within 60 seconds — lock missing");
      // 원인이 무엇이든 사용자가 지금 확인할 수 있는 자리를 준다.
      expect(neverAnswered).toContain("/tmp/fleet");
      expect(neverAnswered).toContain("fleet console status");
    });

    it("keeps every notice in the what/why/next shape", () => {
      const text = formatFailureNotice({ what: "It broke.", why: "a reason", next: ["do this", "then that"] });
      expect(text.split("\n")).toEqual([
        "It broke.",
        "  Why   a reason",
        "  Next  do this",
        "        then that",
      ]);
    });

    it("hands the address over when the console runs but no browser opened", () => {
      expect(describeConsoleLaunch("Fleet Console opened.", {
        url: "http://127.0.0.1:37283/console/",
        browserOpened: true,
      })).toBe("Fleet Console opened.");

      const failed = describeConsoleLaunch("Fleet Console opened.", {
        url: "http://127.0.0.1:37283/console/",
        browserOpened: false,
        browserError: "xdg-open is not on PATH",
      });
      expect(failed).toContain("Fleet Console is running, but no browser opened");
      expect(failed).toContain("xdg-open is not on PATH");
      expect(failed).toContain("Open this address yourself: http://127.0.0.1:37283/console/");
      expect(failed).not.toBe("Fleet Console opened.");
    });

    it("treats a launcher that exits nonzero as a failure, not a success", async () => {
      // xdg-open은 필요한 도구가 없으면 3, 동작이 실패하면 4로 끝낸다 — 'error' 이벤트가 아니라
      // 종료 코드로 온다. 이것을 보지 않으면 브라우저가 뜨지 않았는데도 열렸다고 말하게 된다.
      const options = { detached: true, stdio: "ignore", windowsHide: true } as const;
      const failed = await defaultSpawnBrowser(process.execPath, ["-e", "process.exit(3)"], options);
      expect(failed.opened).toBe(false);
      expect(failed.reason).toContain("status 3");

      const succeeded = await defaultSpawnBrowser(process.execPath, ["-e", "process.exit(0)"], options);
      expect(succeeded.opened).toBe(true);
    });

    it("reports a browser launcher that is missing instead of claiming success", async () => {
      const result = await openBrowser("http://127.0.0.1:37283/console/", {
        platform: "linux",
        spawnBrowser: () => Promise.resolve({ opened: false, reason: "xdg-open is not on PATH" }),
      });
      expect(result).toEqual({ opened: false, reason: "xdg-open is not on PATH" });
    });

    it("carries a failed browser launch out of openFleetConsole", async () => {
      const result = await openFleetConsole({
        lifecycle: {
          ensureDaemon: async () => LOCK.endpoint,
          probe: async () => ({ healthy: true, lock: LOCK, buildStale: false }),
        },
        openBrowser: async () => ({ opened: false, reason: "open is not executable" }),
      });
      expect(result).toEqual({
        url: "http://127.0.0.1:37283/console/",
        browserOpened: false,
        browserError: "open is not executable",
      });
    });
  });

  it("fails when the console is not healthy after ensure", async () => {
    await expect(openFleetConsole({
      lifecycle: {
        ensureDaemon: async () => "http://127.0.0.1:37283/",
        probe: async () => ({ healthy: false, lock: null, error: "lock missing", buildStale: false }),
      },
      openBrowser: () => {
        throw new Error("browser must not open on unhealthy console");
      },
    })).rejects.toThrow("Fleet Console server is not healthy after ensure");
  });

  it("reports a running server with the console URL", async () => {
    const text = await runConsoleStatus({
      lifecycle: {
        probe: async () => ({
          healthy: true,
          lock: LOCK,
          buildStale: false,
          health: {
            ok: true,
            pid: LOCK.pid,
            host: LOCK.host,
            port: LOCK.port,
            portMode: "dynamic",
            requestedPort: null,
            effectivePort: LOCK.port,
            portHonored: true,
            endpoint: LOCK.endpoint,
            startedAt: LOCK.startedAt,
            version: LOCK.version,
            workspaceCount: 2,
          },
        }),
      },
    });
    expect(text).toContain("running");
    expect(text).toContain("http://127.0.0.1:37283/console/");
    expect(text).toContain("workspaces 2");
  });

  it("reports a not-running server when the console is absent", async () => {
    const text = await runConsoleStatus({
      lifecycle: {
        probe: async () => ({ healthy: false, lock: null, error: "lock missing", buildStale: false }),
      },
    });
    expect(text).toContain("not running");
    expect(text).toContain("lock missing");
  });

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
