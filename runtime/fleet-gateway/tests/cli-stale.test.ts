import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GatewayHealth, GatewayLockPayload } from "../src/api-types.js";
import { createGatewayDaemonLifecycle } from "../src/cli.js";
import { createGatewayStalePolicy } from "../src/stale.js";

const ENDPOINT = "http://127.0.0.1:37283/mcp";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("gateway stale policy", () => {
  it("detects builds newer than the lock", () => {
    const policy = createGatewayStalePolicy({ fs: { statSync: () => ({ mtimeMs: 20 }) } as never });

    expect(
      policy.isBuildStale(
        {
          pid: 1,
          host: "127.0.0.1",
          port: 37283,
          endpoint: ENDPOINT,
          startedAt: 10,
          token: "token",
          observerToken: "observer-token",
          version: "test",
        },
        "server.mjs",
      ),
    ).toBe(true);
  });

  it("defers stale restart while tenants are active", async () => {
    const fixture = createStaleFixture();
    let spawned = false;
    const lifecycle = createGatewayDaemonLifecycle({
      env: { FLEET_GATEWAY_DIR: fixture.dir },
      serverModulePath: fixture.serverModulePath,
      health: createHealthStub({ tenantCount: 1 }),
      spawnDetached: () => {
        spawned = true;
      },
    });

    await expect(lifecycle.ensureDaemon()).resolves.toBe(ENDPOINT);
    expect(spawned).toBe(false);
  });

  it("restarts stale daemon when no tenants are active", async () => {
    const fixture = createStaleFixture();
    let spawned = false;
    const lifecycle = createGatewayDaemonLifecycle({
      env: { FLEET_GATEWAY_DIR: fixture.dir },
      serverModulePath: fixture.serverModulePath,
      sleep: async () => undefined,
      health: createHealthStub({ tenantCount: 0 }),
      spawnDetached: () => {
        spawned = true;
        writeLock(fixture.lockFile, { ...createLockPayload(Date.now()), token: "fresh-token" });
      },
    });

    await expect(lifecycle.ensureDaemon()).resolves.toBe(ENDPOINT);
    expect(spawned).toBe(true);
  });

  it("restarts stale daemon when health omits tenantCount for backward compatibility", async () => {
    const fixture = createStaleFixture();
    let spawned = false;
    const lifecycle = createGatewayDaemonLifecycle({
      env: { FLEET_GATEWAY_DIR: fixture.dir },
      serverModulePath: fixture.serverModulePath,
      sleep: async () => undefined,
      health: createHealthStub({ omitTenantCount: true }),
      spawnDetached: () => {
        spawned = true;
        writeLock(fixture.lockFile, { ...createLockPayload(Date.now()), token: "fresh-token" });
      },
    });

    await expect(lifecycle.ensureDaemon()).resolves.toBe(ENDPOINT);
    expect(spawned).toBe(true);
  });
});

function createStaleFixture(): { readonly dir: string; readonly lockFile: string; readonly serverModulePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-stale-"));
  tempDirs.push(dir);
  const lockFile = path.join(dir, "gateway.lock");
  const serverModulePath = path.join(dir, "cli.mjs");
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(serverModulePath, "");
  fs.utimesSync(serverModulePath, new Date(20), new Date(20));
  writeLock(lockFile, createLockPayload(10));
  return { dir, lockFile, serverModulePath };
}

function createHealthStub(options: { readonly tenantCount?: number; readonly omitTenantCount?: boolean }) {
  return {
    probe: async (payload: GatewayLockPayload | null) => {
      if (!payload) return { healthy: false, lock: null, error: "lock missing" };
      return {
        healthy: true,
        lock: payload,
        health: createHealth(payload, options),
      };
    },
  };
}

function createHealth(payload: GatewayLockPayload, options: { readonly tenantCount?: number; readonly omitTenantCount?: boolean }): GatewayHealth {
  const health = {
    ok: true,
    pid: payload.pid,
    host: payload.host,
    port: payload.port,
    endpoint: payload.endpoint,
    startedAt: payload.startedAt,
    version: payload.version,
  };
  if (options.omitTenantCount) return health as GatewayHealth;
  return { ...health, tenantCount: options.tenantCount ?? 0 } as GatewayHealth;
}

function createLockPayload(startedAt: number): GatewayLockPayload {
  return {
    pid: 999_999,
    host: "127.0.0.1",
    port: 37283,
    endpoint: ENDPOINT,
    startedAt,
    token: "token",
    observerToken: "observer-token",
    version: "test",
  };
}

function writeLock(lockFile: string, payload: GatewayLockPayload): void {
  fs.writeFileSync(lockFile, JSON.stringify(payload));
  fs.chmodSync(lockFile, 0o600);
}
