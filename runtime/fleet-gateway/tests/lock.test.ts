import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGatewayLock } from "../src/lock.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("gateway lock", () => {
  it("writes 0700 directories and 0600 lock files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-lock-"));
    tempDirs.push(dir);
    const lockFile = path.join(dir, "gateway.lock");
    const lock = createGatewayLock({ now: () => 1, randomToken: () => "token", hostname: () => "127.0.0.1" });

    const handle = lock.writeLock({ dir, lockFile, pid: 123, port: 37283, endpoint: "http://127.0.0.1:37283/mcp", version: "test" });

    expect(handle.payload.token).toBe("token");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(lockFile).mode & 0o777).toBe(0o600);
    lock.assertLockModes(lockFile);
    lock.assertTrustedLock({
      dir,
      lockFile,
      payload: handle.payload,
      host: "127.0.0.1",
      port: 37283,
      endpointPath: "/mcp",
    });
  });

  it("rejects symbolic lock files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-lock-"));
    tempDirs.push(dir);
    const lockFile = path.join(dir, "gateway.lock");
    const target = path.join(dir, "target.lock");
    fs.writeFileSync(target, "{}");
    fs.symlinkSync(target, lockFile);

    expect(() => createGatewayLock().readLock(lockFile)).toThrow(/symbolic gateway lock/);
  });

  it("rejects loose modes and non-loopback endpoints", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-lock-"));
    tempDirs.push(dir);
    const lockFile = path.join(dir, "gateway.lock");
    const lock = createGatewayLock({ now: () => 1, randomToken: () => "token", hostname: () => "127.0.0.1" });
    const handle = lock.writeLock({ dir, lockFile, pid: 123, port: 37283, endpoint: "http://127.0.0.1:37283/mcp", version: "test" });

    fs.chmodSync(lockFile, 0o644);
    expect(() => lock.assertTrustedLock({
      dir,
      lockFile,
      payload: handle.payload,
      host: "127.0.0.1",
      port: 37283,
      endpointPath: "/mcp",
    })).toThrow(/0600/);
    fs.chmodSync(lockFile, 0o600);

    expect(() => lock.assertTrustedLock({
      dir,
      lockFile,
      payload: { ...handle.payload, host: "203.0.113.1", endpoint: "http://203.0.113.1:37283/mcp" },
      host: "127.0.0.1",
      port: 37283,
      endpointPath: "/mcp",
    })).toThrow(/loopback/);
  });
});
