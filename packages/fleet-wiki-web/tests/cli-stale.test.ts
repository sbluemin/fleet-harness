import { describe, expect, it } from "vitest";

import { isLockTrustworthyForRestart, isStaleLock } from "../src/stale.js";
import type { FleetWikiLock } from "../src/lock.js";

const BASE_LOCK: FleetWikiLock = {
  pid: 12345,
  port: 3737,
  cwd: "/workspace",
  startedAt: "2026-05-04T04:38:06.000Z",
};

describe("isStaleLock", () => {
  it("returns true when lock.startedAt is before distMtime", () => {
    const distMtime = new Date("2026-05-04T13:36:00.000Z").getTime();
    expect(isStaleLock(BASE_LOCK, distMtime)).toBe(true);
  });

  it("returns false when lock.startedAt equals distMtime", () => {
    const distMtime = new Date("2026-05-04T04:38:06.000Z").getTime();
    expect(isStaleLock(BASE_LOCK, distMtime)).toBe(false);
  });

  it("returns false when lock.startedAt is after distMtime (fresh server)", () => {
    const distMtime = new Date("2026-05-04T03:00:00.000Z").getTime();
    expect(isStaleLock(BASE_LOCK, distMtime)).toBe(false);
  });

  it("returns false for malformed startedAt", () => {
    const malformed: FleetWikiLock = { ...BASE_LOCK, startedAt: "not-a-date" };
    const distMtime = new Date("2026-05-04T13:36:00.000Z").getTime();
    expect(isStaleLock(malformed, distMtime)).toBe(false);
  });

  it("returns false when distMtime is 0 (stat failed, skip stale check)", () => {
    expect(isStaleLock(BASE_LOCK, 0)).toBe(false);
  });
});

describe("isLockTrustworthyForRestart", () => {
  const VALID_LOCK: FleetWikiLock = {
    pid: 12345,
    port: 3737,
    cwd: "/workspace",
    startedAt: "2026-05-04T04:38:06.000Z",
  };

  it("returns trusted=true when all three guards pass", () => {
    const result = isLockTrustworthyForRestart(VALID_LOCK, "/workspace", "/workspace");
    expect(result.trusted).toBe(true);
  });

  it("returns trusted=false when pid is 1 (init process)", () => {
    const lock = { ...VALID_LOCK, pid: 1 };
    const result = isLockTrustworthyForRestart(lock, "/workspace", "/workspace");
    expect(result.trusted).toBe(false);
    expect(result.reason).toMatch(/pid/);
  });

  it("returns trusted=false when pid is -1", () => {
    const lock = { ...VALID_LOCK, pid: -1 };
    const result = isLockTrustworthyForRestart(lock, "/workspace", "/workspace");
    expect(result.trusted).toBe(false);
  });

  it("returns trusted=false when pid is NaN", () => {
    const lock = { ...VALID_LOCK, pid: NaN };
    const result = isLockTrustworthyForRestart(lock, "/workspace", "/workspace");
    expect(result.trusted).toBe(false);
  });

  it("returns trusted=false when lock.cwd differs from currentCwd", () => {
    const result = isLockTrustworthyForRestart(VALID_LOCK, "/other-workspace", "/workspace");
    expect(result.trusted).toBe(false);
    expect(result.reason).toMatch(/cwd/);
  });

  it("returns trusted=false when healthResponseCwd is null", () => {
    const result = isLockTrustworthyForRestart(VALID_LOCK, "/workspace", null);
    expect(result.trusted).toBe(false);
  });

  it("returns trusted=false when healthResponseCwd differs from lock.cwd", () => {
    const result = isLockTrustworthyForRestart(VALID_LOCK, "/workspace", "/different-path");
    expect(result.trusted).toBe(false);
  });

  it("returns trusted=false when lock.host differs from currentHost", () => {
    const lockWithHost: FleetWikiLock = { ...VALID_LOCK, host: "0.0.0.0" };
    const result = isLockTrustworthyForRestart(lockWithHost, "/workspace", "/workspace", "127.0.0.1");
    expect(result.trusted).toBe(false);
    expect(result.reason).toMatch(/host/);
  });

  it("returns trusted=true when lock.host matches currentHost", () => {
    const lockWithHost: FleetWikiLock = { ...VALID_LOCK, host: "0.0.0.0" };
    const result = isLockTrustworthyForRestart(lockWithHost, "/workspace", "/workspace", "0.0.0.0");
    expect(result.trusted).toBe(true);
  });

  it("allows legacy lock (no host field) when currentHost is default", () => {
    const result = isLockTrustworthyForRestart(VALID_LOCK, "/workspace", "/workspace", "127.0.0.1");
    expect(result.trusted).toBe(true);
  });

  it("rejects legacy lock (no host field) when currentHost is explicit non-default", () => {
    const result = isLockTrustworthyForRestart(VALID_LOCK, "/workspace", "/workspace", "0.0.0.0");
    expect(result.trusted).toBe(false);
    expect(result.reason).toMatch(/legacy/);
  });

  it("allows legacy lock (no host field) when currentHost is undefined", () => {
    const result = isLockTrustworthyForRestart(VALID_LOCK, "/workspace", "/workspace", undefined);
    expect(result.trusted).toBe(true);
  });

  it("ignores host comparison when currentHost is undefined", () => {
    const lockWithHost: FleetWikiLock = { ...VALID_LOCK, host: "0.0.0.0" };
    const result = isLockTrustworthyForRestart(lockWithHost, "/workspace", "/workspace", undefined);
    expect(result.trusted).toBe(true);
  });
});
