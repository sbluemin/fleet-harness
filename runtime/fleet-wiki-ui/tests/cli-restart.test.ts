import { describe, expect, it } from "vitest";

import { evaluateHealthyLockTrust, evaluateRestartDecision } from "../src/cli.js";
import type { FleetWikiLock } from "../src/lock.js";

const TRUSTED_LOCK: FleetWikiLock = {
  pid: 12345,
  port: 3737,
  host: "127.0.0.1",
  startedAt: "2026-05-04T04:38:06.000Z",
  token: "test-token",
};

const HEALTH_OK = { ok: true as const, cwd: "/workspace" };

describe("evaluateRestartDecision", () => {
  it("returns mode=reuse for a healthy non-stale trusted daemon", () => {
    const result = evaluateRestartDecision(TRUSTED_LOCK, "/workspace", HEALTH_OK, false);
    expect(result.mode).toBe("reuse");
    expect(result.reason).toBeUndefined();
  });

  it("returns mode=restart for a stale trusted daemon", () => {
    const result = evaluateRestartDecision(TRUSTED_LOCK, "/workspace", HEALTH_OK, false, undefined, true);
    expect(result.mode).toBe("restart");
  });

  it("returns mode=reuse when noAutoRestart is true", () => {
    const result = evaluateRestartDecision(TRUSTED_LOCK, "/workspace", HEALTH_OK, true);
    expect(result.mode).toBe("reuse");
    expect(result.reason).toBeUndefined();
  });

  it("returns mode=reuse when current cwd differs because daemon is per-user", () => {
    const result = evaluateRestartDecision(TRUSTED_LOCK, "/other-workspace", HEALTH_OK, false);
    expect(result.mode).toBe("reuse");
  });

  it("returns mode=abort with reason when pid is 1 (init process)", () => {
    const badPidLock = { ...TRUSTED_LOCK, pid: 1 };
    const result = evaluateRestartDecision(badPidLock, "/workspace", HEALTH_OK, false);
    expect(result.mode).toBe("abort");
    expect(result.reason).toMatch(/pid/);
  });

  it("returns mode=abort with reason when pid is negative", () => {
    const badPidLock = { ...TRUSTED_LOCK, pid: -1 };
    const result = evaluateRestartDecision(badPidLock, "/workspace", HEALTH_OK, false);
    expect(result.mode).toBe("abort");
    expect(result.reason).toMatch(/pid/);
  });

  it("returns mode=reuse when health cwd is null", () => {
    const result = evaluateRestartDecision(TRUSTED_LOCK, "/workspace", { ok: true, cwd: null }, false);
    expect(result.mode).toBe("reuse");
  });

  it("returns mode=reuse when health cwd differs", () => {
    const result = evaluateRestartDecision(TRUSTED_LOCK, "/workspace", { ok: true, cwd: "/different" }, false);
    expect(result.mode).toBe("reuse");
  });

  it("returns mode=abort for untrusted locks even when noAutoRestart is true", () => {
    const result = evaluateRestartDecision(
      { ...TRUSTED_LOCK, pid: 1 },
      "/workspace",
      HEALTH_OK,
      true,
    );
    expect(result.mode).toBe("abort");
    expect(result.reason).toMatch(/pid/);
  });

  it("returns mode=abort when lock host differs from requested host", () => {
    const lockWithHost: FleetWikiLock = { ...TRUSTED_LOCK, host: "0.0.0.0" };
    const result = evaluateRestartDecision(lockWithHost, "/workspace", HEALTH_OK, false, "127.0.0.1");
    expect(result.mode).toBe("abort");
    expect(result.reason).toMatch(/host/);
  });

  it("returns mode=reuse for non-loopback lock host when requested host matches", () => {
    const lockWithHost: FleetWikiLock = { ...TRUSTED_LOCK, host: "0.0.0.0" };
    const result = evaluateRestartDecision(lockWithHost, "/workspace", HEALTH_OK, false, "0.0.0.0");
    expect(result.mode).toBe("reuse");
    expect(result.reason).toBeUndefined();
  });

});

describe("evaluateHealthyLockTrust", () => {
  it("trusts owned lock waits without cwd validation", () => {
    const result = evaluateHealthyLockTrust(
      TRUSTED_LOCK,
      { ok: true, cwd: "/different-workspace" },
      { trust: "owned" },
    );
    expect(result.trusted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("trusts existing lock waits without cwd validation", () => {
    const result = evaluateHealthyLockTrust(
      TRUSTED_LOCK,
      HEALTH_OK,
      { trust: "existing" },
    );
    expect(result.trusted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects existing lock waits when lock host differs from requested host", () => {
    const lockWithHost: FleetWikiLock = { ...TRUSTED_LOCK, host: "0.0.0.0" };
    const result = evaluateHealthyLockTrust(
      lockWithHost,
      HEALTH_OK,
      { trust: "existing" },
      "127.0.0.1",
    );
    expect(result.trusted).toBe(false);
    expect(result.reason).toMatch(/host/);
  });
});
