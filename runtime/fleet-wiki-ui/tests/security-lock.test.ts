import { lstat, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { acquireLockFile, ensureLockDirectory, lockDirectoryPath, LockExistsError, removeSymbolicLock } from "../src/lock.js";
import type { FleetWikiLock } from "../src/lock.js";
import { isLockTrustworthyForRestart } from "../src/stale.js";

const LOCK: FleetWikiLock = {
  pid: process.pid,
  port: 0,
  host: "127.0.0.1",
  startedAt: "2026-05-04T00:00:00.000Z",
  token: "test-token",
};

describe("security lock", () => {
  it("creates a private per-user lock directory", async () => {
    const dirPath = await ensureLockDirectory();
    const mode = (await lstat(dirPath)).mode & 0o777;
    expect(dirPath).toBe(lockDirectoryPath());
    expect(mode).toBe(0o700);
  });

  it("allows only one exclusive lock creator", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-lock-"));
    const lockPath = path.join(tempDir, "race.lock");
    const results = await Promise.allSettled([
      acquireLockFile(lockPath, LOCK),
      acquireLockFile(lockPath, LOCK),
    ]);
    await rm(tempDir, { recursive: true, force: true });
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason instanceof LockExistsError).toBe(true);
  });

  it("removes symbolic lock traps before exclusive create", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-lock-symlink-"));
    const targetPath = path.join(tempDir, "target");
    const lockPath = path.join(tempDir, "symbolic.lock");
    await mkdir(targetPath);
    await symlink(targetPath, lockPath);
    await expect(removeSymbolicLock(lockPath)).resolves.toBe(true);
    await expect(acquireLockFile(lockPath, LOCK)).resolves.toBeUndefined();
    expect((await lstat(lockPath)).isSymbolicLink()).toBe(false);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("trusts matching non-default host locks for restart", () => {
    const lock = { ...LOCK, host: "0.0.0.0" };
    expect(isLockTrustworthyForRestart(lock, "", null, "0.0.0.0")).toEqual({ trusted: true });
  });

  it("rejects host drift between lock and current host", () => {
    const lock = { ...LOCK, host: "0.0.0.0" };
    expect(isLockTrustworthyForRestart(lock, "", null, "127.0.0.1")).toMatchObject({
      trusted: false,
      reason: "host 불일치(lock=0.0.0.0, current=127.0.0.1)",
    });
  });
});
