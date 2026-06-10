import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGatewayDaemonLifecycle } from "../src/cli.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("gateway daemon lifecycle", () => {
  it("constructs explicit lifecycle methods", () => {
    const lifecycle = createGatewayDaemonLifecycle({ env: { FLEET_GATEWAY_DIR: "/tmp/fleet-gateway-test" }, serverModulePath: "/tmp/server.mjs" });

    expect(typeof lifecycle.ensureDaemon).toBe("function");
    expect(typeof lifecycle.probe).toBe("function");
    expect(typeof lifecycle.stop).toBe("function");
  });

  it("cleans hostile locks without probing their endpoint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-hostile-lock-"));
    tempDirs.push(dir);
    const lockFile = path.join(dir, "gateway.lock");
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      host: "203.0.113.1",
      port: 37283,
      endpoint: "http://203.0.113.1:37283/mcp",
      startedAt: Date.now(),
      token: "hostile",
      version: "test",
    }));
    fs.chmodSync(lockFile, 0o600);
    const lifecycle = createGatewayDaemonLifecycle({
      env: { FLEET_GATEWAY_DIR: dir },
      serverModulePath: "/tmp/server.mjs",
      spawnDetached: () => {
        throw new Error("spawn attempted");
      },
    });

    await expect(lifecycle.ensureDaemon()).rejects.toThrow(/spawn attempted/);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("cleans symbolic locks before starting a healthy daemon", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-symlink-lock-"));
    tempDirs.push(dir);
    const lockFile = path.join(dir, "gateway.lock");
    const target = path.join(dir, "target.lock");
    const token = "bootstrap-token";
    const startedAt = Date.now();
    let probeCount = 0;
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(target, "{}");
    fs.symlinkSync(target, lockFile);
    const lifecycle = createGatewayDaemonLifecycle({
      env: { FLEET_GATEWAY_DIR: dir },
      serverModulePath: "/tmp/server.mjs",
      sleep: async () => undefined,
      health: {
        probe: async (payload) => {
          probeCount += 1;
          if (!payload) return { healthy: false, lock: null, error: "lock missing" };
          return {
            healthy: true,
            lock: payload,
            health: {
              ok: true,
              pid: payload.pid,
              host: payload.host,
              port: payload.port,
              endpoint: payload.endpoint,
              startedAt: payload.startedAt,
              version: payload.version,
            },
          };
        },
      },
      spawnDetached: () => {
        expect(fs.existsSync(lockFile)).toBe(false);
        fs.writeFileSync(lockFile, JSON.stringify({
          pid: process.pid,
          host: "127.0.0.1",
          port: 37283,
          endpoint: "http://127.0.0.1:37283/mcp",
          startedAt,
          token,
          version: "test",
        }));
        fs.chmodSync(lockFile, 0o600);
      },
    });

    await expect(lifecycle.ensureDaemon()).resolves.toBe("http://127.0.0.1:37283/mcp");
    expect(fs.lstatSync(lockFile).isSymbolicLink()).toBe(false);
    expect(probeCount).toBe(2);
  });
});
