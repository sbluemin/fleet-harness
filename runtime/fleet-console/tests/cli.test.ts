import { describe, expect, it } from "vitest";

import { buildConsoleHelpText, openFleetConsole, parseConsoleCliMode } from "../src/cli.js";
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
  it("parses help flags and rejects unknown options", () => {
    expect(parseConsoleCliMode([])).toBe("open");
    expect(parseConsoleCliMode(["--help"])).toBe("help");
    expect(parseConsoleCliMode(["-h"])).toBe("help");
    expect(() => parseConsoleCliMode(["--stop"])).toThrow("Unknown fleet console option: --stop");
  });

  it("documents the usage entry points in help text", () => {
    const helpText = buildConsoleHelpText();
    expect(helpText).toContain("fleet console");
    expect(helpText).toContain("fleet-console");
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
});
