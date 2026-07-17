import { describe, expect, it, vi } from "vitest";

import { inspectRemoteLock, parseRemoteConsoleLock } from "../src/runtime/remote/lock.js";
import { parseSshTarget } from "../src/runtime/remote/target.js";

const target = parseSshTarget("host");
const owner = { id: "9b77d0ec-a591-4a47-8d87-76b1074a0571", version: "0.3.1" };
const lock = (extra = {}) => JSON.stringify({ pid: 42, host: "remote", port: 4310, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "0.3.1", owner: { kind: "desktop", id: owner.id, protocolVersion: 1 }, ...extra });

function adapter(probeResults: readonly boolean[], contents = lock()) {
  return { probe: vi.fn(async () => ({ ok: probeResults.shift?.() ?? true, exitCode: 0 })), run: vi.fn(async () => ({ stdout: contents, stderr: "", exitCode: 0 })) } as never;
}

describe("remote lock inspection", () => {
  it("treats a missing lock as absent without attempting a read", async () => {
    const ssh = adapter([false]);
    await expect(inspectRemoteLock(ssh, target, owner)).resolves.toEqual({ kind: "absent" });
    expect(ssh.run).not.toHaveBeenCalled();
  });
  it("classifies stale, same-owner, foreign desktop, and CLI locks without signaling", async () => {
    await expect(inspectRemoteLock(adapter([true, false]), target, owner)).resolves.toEqual({ kind: "stale" });
    await expect(inspectRemoteLock(adapter([true, true]), target, owner)).resolves.toMatchObject({ kind: "same_owner" });
    await expect(inspectRemoteLock(adapter([true, true], lock({ owner: { kind: "desktop", id: "other", protocolVersion: 1 } })), target, owner)).resolves.toMatchObject({ kind: "remote_console_owned_elsewhere" });
    await expect(inspectRemoteLock(adapter([true, true], lock({ owner: { kind: "cli", id: "cli", protocolVersion: 1 } })), target, owner)).resolves.toMatchObject({ kind: "remote_console_lock_conflict" });
  });
  it("preserves a probe/read TOCTOU as conflict and bounds malformed locks", async () => {
    const ssh = { probe: vi.fn(async () => ({ ok: true, exitCode: 0 })), run: vi.fn(async () => { throw Object.assign(new Error("ssh_failed"), { code: "ssh_failed" }); }) } as never;
    await expect(inspectRemoteLock(ssh, target, owner)).resolves.toEqual({ kind: "remote_console_lock_conflict" });
    expect(() => parseRemoteConsoleLock("x".repeat(64 * 1024 + 1))).toThrow("remote_lock_too_large");
    expect(() => parseRemoteConsoleLock(lock({ endpoint: "http://localhost:4310/" }))).toThrow();
  });
});
