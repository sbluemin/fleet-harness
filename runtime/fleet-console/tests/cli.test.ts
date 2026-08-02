import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleLockPayload } from "../core/host/console-contract-types.js";
import {
  buildConsoleHelpText,
  assertCliCanControlDaemon,
  isCliDirectRun,
  isLockProcessAlive,
  main,
  openFleetConsole,
  parseConsoleCliMode,
  parseConsoleHookCommand,
  runConsoleStatus,
  runConsoleStop,
} from "../core/host/cli.js";
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
    expect(parseConsoleHookCommand(["capture-session", "codex"])).toEqual({ command: "capture-session", provider: "codex" });
    expect(parseConsoleHookCommand(["attention"])).toEqual({ command: "attention" });
    expect(() => parseConsoleHookCommand(["attention", "extra"])).toThrow("Unknown fleet-console hook command");
    expect(() => parseConsoleHookCommand(["capture-session"])).toThrow("Unknown fleet-console hook command");
    expect(() => parseConsoleHookCommand(["capture-session", "cursor"])).toThrow("Unknown fleet-console hook command");
    expect(() => parseConsoleHookCommand(["subagents-context"])).toThrow("Unknown fleet-console hook command");
  });

  it("posts capture-session hooks to the session-scoped capture endpoint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-capture-hook-"));
    TEMP_DIRS.push(dir);
    const paths = createConsolePaths({ env: { FLEET_CONSOLE_DIR: dir } });
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
    const originalSessionId = process.env.FLEET_CONSOLE_SESSION_ID;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    process.argv = ["node", "fleet-console", "hook", "capture-session", "claude"];
    process.env.FLEET_CONSOLE_DIR = dir;
    process.env.FLEET_CONSOLE_SESSION_ID = "session-x";
    try {
      await main();
    } finally {
      process.argv = originalArgv;
      globalThis.fetch = originalFetch;
      if (originalConsoleDir === undefined) delete process.env.FLEET_CONSOLE_DIR;
      else process.env.FLEET_CONSOLE_DIR = originalConsoleDir;
      if (originalSessionId === undefined) delete process.env.FLEET_CONSOLE_SESSION_ID;
      else process.env.FLEET_CONSOLE_SESSION_ID = originalSessionId;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:51239/plugins/terminal/agent/sessions/session-x/capture");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${lock.payload.token}`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ provider: "claude" });
  });

  it("documents the usage entry points and subcommands in help text", () => {
    const helpText = buildConsoleHelpText();
    expect(helpText).toContain("fleet-console");
    expect(helpText).not.toContain("fleet console");
    expect(helpText).toContain("start");
    expect(helpText).toContain("stop");
    expect(helpText).toContain("restart");
    expect(helpText).toContain("status");
    expect(helpText).not.toContain("Gateway");
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
