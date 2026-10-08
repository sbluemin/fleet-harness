import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleLockPayload } from "../core/host/transport/console-contract-types.js";
import {
  buildConsoleHelpText,
  assertCliCanControlDaemon,
  createConsoleDaemonLifecycle,
  type ConsoleDaemonLifecycleDeps,
  type ConsoleDaemonProcess,
  isCliDirectRun,
  main,
  startFleetConsole,
  parseConsoleCliMode,
  decideAgentCall,
  parseConsoleHookCommand,
  runConsoleStatus,
  runConsoleStop,
} from "../core/host/bootstrap/cli.js";
import { describeDaemonStartFailure } from "../core/host/transport/failure-notice.js";
import { runStopLadder, readConsoleLockFile } from "@fleet-console/lifecycle";
import { CONSOLE_START_TIMEOUT_MS, EXTERNAL_ESCALATION_MS } from "@fleet-console/protocol/lifecycle";
import { createConsoleLock } from "../core/host/bootstrap/lock.js";
import { createConsolePaths } from "../core/host/bootstrap/paths.js";

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

  it("never lets a Console session's subagent call run without Console's answer", async () => {
    // 서브에이전트 hook의 침묵은 곧 실행이다 — Console이 사유를 주면 그 사유로, 답하지 못하면 고정 사유로 막는다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-agent-call-"));
    TEMP_DIRS.push(dir);
    const env = { FLEET_CONSOLE_DATA_DIR: dir };
    const paths = createConsolePaths({ env });
    const input = JSON.stringify({ tool_name: "Agent", tool_input: { prompt: "look around" } });
    const answering = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    // 잠금이 없으면(Console이 떠 있지 않으면) 묻지도 못한 채 막는다.
    expect(await decideAgentCall("op-1", input, env, answering({ reason: null }))).toMatch(/could not be reached/);
    await createConsoleLock().acquireLock({ dir, lockFile: paths.lockFile, pid: process.pid, port: 40125, endpoint: "http://127.0.0.1:40125/", version: "test" });
    expect(await decideAgentCall("op-1", input, env, answering({ reason: "Use members." }))).toBe("Use members.");
    expect(await decideAgentCall("op-1", input, env, answering({ reason: null }))).toBeNull();
    expect(await decideAgentCall("op-1", input, env, answering({ error: "agent_call_undecided" }, 500))).toMatch(/could not be reached/);
    // Console이 띄우지 않은 세션과 다른 도구에는 관여하지 않는다.
    expect(await decideAgentCall(undefined, input, env, answering({ reason: "Use members." }))).toBeNull();
    expect(await decideAgentCall("op-1", JSON.stringify({ tool_name: "Bash" }), env, answering({ reason: "Use members." }))).toBeNull();
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

    it("uses the 60s production start budget when no budget is injected", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-production-budget-"));
      TEMP_DIRS.push(dir);
      const fake = createFakeDaemonProcess(4313, (signal, child) => {
        if (signal === "SIGTERM" || signal === "SIGKILL") child.emit("exit", 1, null);
      });
      let clock = 0;
      const lifecycle = createConsoleDaemonLifecycle({
        env: { FLEET_CONSOLE_DATA_DIR: dir },
        serverModulePath: "/pkg/dist/cli.mjs",
        spawnDaemon: () => fake.child,
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        health: { probe: async () => ({ healthy: false, lock: null, error: "lock missing" }) },
      });

      await expect(lifecycle.ensureDaemon()).rejects.toThrow("within 60 seconds");

      expect(CONSOLE_START_TIMEOUT_MS).toBe(60_000);
      expect(clock).toBe(CONSOLE_START_TIMEOUT_MS);
    });

    it("accepts a shorter test start budget without replacing an explicit one", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-injected-budget-"));
      TEMP_DIRS.push(dir);
      const fake = createFakeDaemonProcess(4314, (signal, child) => {
        if (signal === "SIGTERM" || signal === "SIGKILL") child.emit("exit", 1, null);
      });
      let clock = 0;
      const env = { FLEET_CONSOLE_DATA_DIR: dir, FLEET_TEST_CONSOLE_START_TIMEOUT_MS: "250" };
      const injected = createConsoleDaemonLifecycle({
        env,
        serverModulePath: "/pkg/dist/cli.mjs",
        spawnDaemon: () => fake.child,
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        health: { probe: async () => ({ healthy: false, lock: null, error: "lock missing" }) },
      });
      await expect(injected.ensureDaemon()).rejects.toThrow("within 250 ms");
      expect(clock).toBe(250);

      clock = 0;
      const explicit = createConsoleDaemonLifecycle({
        env,
        serverModulePath: "/pkg/dist/cli.mjs",
        spawnDaemon: () => fake.child,
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        startupTimeoutMs: 400,
        health: { probe: async () => ({ healthy: false, lock: null, error: "lock missing" }) },
      });
      await expect(explicit.ensureDaemon()).rejects.toThrow("within 400 ms");
      expect(clock).toBe(400);
    });

    it("uses the production escalation budget unless a test budget is injected", async () => {
      const run = async (escalationMs?: number) => {
        let clock = 0;
        let alive = true;
        const signals: string[] = [];
        const ended = await runStopLadder({
          request: "signal",
          isAlive: () => alive,
          isReleased: () => false,
          reprove: async () => true,
          signal: (signal) => {
            signals.push(signal);
            if (signal === "SIGKILL") alive = false;
          },
          now: () => clock,
          sleep: async (ms) => { clock += ms; },
          ...(escalationMs === undefined ? {} : { escalationMs }),
        });
        return { ended, signals, clock };
      };

      const production = await run();
      expect(production.ended).toBe("forced");
      expect(production.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(EXTERNAL_ESCALATION_MS).toBe(12_000);
      expect(production.clock).toBe(EXTERNAL_ESCALATION_MS);

      const injected = await run(200);
      expect(injected.ended).toBe("forced");
      expect(injected.clock).toBe(200);
    });

    it("adopts a concurrent healthy winner after cleaning only its own child", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-concurrent-winner-"));
      TEMP_DIRS.push(dir);
      const paths = createConsolePaths({ env: { FLEET_CONSOLE_DATA_DIR: dir } });
      const replacement = (await createConsoleLock().acquireLock({
        dir,
        lockFile: paths.lockFile,
        pid: 9877,
        port: 40124,
        endpoint: "http://127.0.0.1:40124/",
        version: "replacement",
      })).payload;
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
      expect(readConsoleLockFile(paths.lockFile)?.pid).toBe(replacement.pid);
    });
  });

  // CLI는 화면을 대신 열지 않는다 — 서버를 보장하고 사용자가 직접 열 주소만 건넨다.
  it("ensures the server and hands back the console URL without browser tokens", async () => {
    const calls: string[] = [];

    const result = await startFleetConsole({
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
    });

    expect(calls).toEqual(["ensure", "probe"]);
    expect(result.url).toBe("http://127.0.0.1:37283/console/");
    expect(result.url).not.toContain("#");
  });

  // 실패 화법 계약: 사용자에게 도달하는 실패는 무슨 일 · 왜 · 지금 할 일 세 조각을 갖는다.
  // 기계 코드만 던지던 예전 문구로 되돌리면 아래 세 건이 모두 깨진다.

  it("stops the console server", async () => {
    const calls: string[] = [];
    const text = await runConsoleStop({
      lifecycle: {
        stop: async () => {
          calls.push("stop");
          return { outcome: "clean" as const, killed: 0 };
        },
      },
    });
    expect(calls).toEqual(["stop"]);
    expect(text).toContain("stopped");
  });
});
