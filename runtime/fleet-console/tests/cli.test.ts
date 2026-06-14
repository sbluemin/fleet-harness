import { describe, expect, it } from "vitest";

import type { ConsoleLockPayload } from "../src/api-types.js";
import {
  buildConsoleHelpText,
  openFleetConsole,
  parseConsoleCliMode,
  runConsoleStatus,
  runConsoleStop,
} from "../src/cli.js";

const LOCK: ConsoleLockPayload = {
  pid: 1234,
  host: "127.0.0.1",
  port: 37283,
  endpoint: "http://127.0.0.1:37283/",
  startedAt: 1,
  token: "bootstrap-token",
  version: "test",
};

describe("fleet console CLI", () => {
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

  it("documents the usage entry points and subcommands in help text", () => {
    const helpText = buildConsoleHelpText();
    expect(helpText).toContain("fleet console");
    expect(helpText).toContain("fleet-console");
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
        probe: async () => ({ healthy: true, lock: LOCK, buildStale: false, health: { ok: true, pid: LOCK.pid, host: LOCK.host, port: LOCK.port, endpoint: LOCK.endpoint, startedAt: LOCK.startedAt, version: LOCK.version, workspaceCount: 2 } }),
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
