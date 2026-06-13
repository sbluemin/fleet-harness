import { describe, expect, it } from "vitest";

import {
  buildConsoleHelpText,
  openFleetConsole,
  parseConsoleCliMode,
  runConsoleStatus,
  runConsoleStop,
} from "../src/cli.js";
import type { GatewayLockPayload } from "@dotobokuri/fleet-gateway";

const LOCK: GatewayLockPayload = {
  pid: 1234,
  host: "127.0.0.1",
  port: 37283,
  endpoint: "http://127.0.0.1:37283/mcp",
  startedAt: 1,
  token: "bootstrap-token",
  observerToken: "observer-token",
  version: "test",
};

describe("fleet console CLI", () => {
  it("parses subcommands and help flags, rejecting unknown commands", () => {
    expect(parseConsoleCliMode([])).toBe("start");
    expect(parseConsoleCliMode(["start"])).toBe("start");
    expect(parseConsoleCliMode(["stop"])).toBe("stop");
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
    expect(helpText).toContain("status");
  });

  it("ensures the daemon and opens the console with the observer token in the URL fragment only", async () => {
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
    expect(opened).toEqual(["http://127.0.0.1:37283/console/#observerToken=observer-token"]);
    expect(result.url).toBe(opened[0]);
    expect(opened[0]).not.toContain("?observerToken=");
  });

  it("fails when the gateway is not healthy after ensure", async () => {
    await expect(openFleetConsole({
      lifecycle: {
        ensureDaemon: async () => "http://127.0.0.1:37283/mcp",
        probe: async () => ({ healthy: false, lock: null, error: "lock missing", buildStale: false }),
      },
      openBrowser: () => {
        throw new Error("browser must not open on unhealthy gateway");
      },
    })).rejects.toThrow("Fleet Gateway daemon is not healthy after ensure");
  });

  it("reports a running daemon with the console URL", async () => {
    const text = await runConsoleStatus({
      lifecycle: {
        probe: async () => ({ healthy: true, lock: LOCK, buildStale: false }),
      },
    });
    expect(text).toContain("running");
    expect(text).toContain("http://127.0.0.1:37283/console/");
    expect(text).not.toContain("observerToken");
  });

  it("reports a not-running daemon when the gateway is absent", async () => {
    const text = await runConsoleStatus({
      lifecycle: {
        probe: async () => ({ healthy: false, lock: null, error: "lock missing", buildStale: false }),
      },
    });
    expect(text).toContain("not running");
    expect(text).toContain("lock missing");
  });

  it("stops the gateway daemon", async () => {
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
