import { describe, expect, it } from "vitest";

import { evaluateHealthyLockTrust, evaluateRestartDecision } from "../src/cli.js";
import type { FleetWikiLock } from "../src/lock.js";

const TRUSTED_LOCK: FleetWikiLock = {
  pid: 12345,
  port: 3737,
  cwd: "/workspace",
  startedAt: "2026-05-04T04:38:06.000Z",
};

const HEALTH_OK = { ok: true as const, cwd: "/workspace" };

describe("evaluateRestartDecision", () => {
  it("returns mode=restart for a healthy trusted server", () => {
    const result = evaluateRestartDecision(TRUSTED_LOCK, "/workspace", HEALTH_OK, false);
    expect(result.mode).toBe("restart");
    expect(result.reason).toBeUndefined();
  });

  it("returns mode=reuse when noAutoRestart is true", () => {
    const result = evaluateRestartDecision(TRUSTED_LOCK, "/workspace", HEALTH_OK, true);
    expect(result.mode).toBe("reuse");
    expect(result.reason).toBeUndefined();
  });

  it("returns mode=abort with reason when lock cwd differs from current cwd", () => {
    const result = evaluateRestartDecision(TRUSTED_LOCK, "/other-workspace", HEALTH_OK, false);
    expect(result.mode).toBe("abort");
    expect(result.reason).toMatch(/cwd/);
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

  it("returns mode=abort with reason when health cwd is null", () => {
    const result = evaluateRestartDecision(TRUSTED_LOCK, "/workspace", { ok: true, cwd: null }, false);
    expect(result.mode).toBe("abort");
    expect(result.reason).toMatch(/cwd/);
  });

  it("returns mode=abort with reason when health cwd differs from lock cwd", () => {
    const result = evaluateRestartDecision(TRUSTED_LOCK, "/workspace", { ok: true, cwd: "/different" }, false);
    expect(result.mode).toBe("abort");
    expect(result.reason).toMatch(/cwd/);
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

  it("returns mode=restart when lock host matches requested host", () => {
    const lockWithHost: FleetWikiLock = { ...TRUSTED_LOCK, host: "0.0.0.0" };
    const result = evaluateRestartDecision(lockWithHost, "/workspace", HEALTH_OK, false, "0.0.0.0");
    expect(result.mode).toBe("restart");
    expect(result.reason).toBeUndefined();
  });

  it("returns mode=abort when legacy lock has no host but currentHost is non-default", () => {
    const result = evaluateRestartDecision(TRUSTED_LOCK, "/workspace", HEALTH_OK, false, "0.0.0.0");
    expect(result.mode).toBe("abort");
    expect(result.reason).toMatch(/legacy/);
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

  it("trusts existing lock waits only when lock and health cwd match current cwd", () => {
    const result = evaluateHealthyLockTrust(
      TRUSTED_LOCK,
      HEALTH_OK,
      { trust: "existing", cwd: "/workspace" },
    );
    expect(result.trusted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects existing lock waits when a later-healthy lock belongs to another cwd", () => {
    const result = evaluateHealthyLockTrust(
      TRUSTED_LOCK,
      HEALTH_OK,
      { trust: "existing", cwd: "/other-workspace" },
    );
    expect(result.trusted).toBe(false);
    expect(result.reason).toMatch(/cwd/);
  });

  it("rejects existing lock waits when lock host differs from requested host", () => {
    const lockWithHost: FleetWikiLock = { ...TRUSTED_LOCK, host: "0.0.0.0" };
    const result = evaluateHealthyLockTrust(
      lockWithHost,
      HEALTH_OK,
      { trust: "existing", cwd: "/workspace" },
      "127.0.0.1",
    );
    expect(result.trusted).toBe(false);
    expect(result.reason).toMatch(/host/);
  });
});
