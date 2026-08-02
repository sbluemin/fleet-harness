import { describe, expect, it, vi } from "vitest";

import { inspectRemoteLock, parseRemoteConsoleLock } from "../src/runtime/remote/lock.js";
import { parseSshTarget } from "../src/runtime/remote/contracts.js";
import type { OpenSshAdapter } from "../src/runtime/remote/ssh.js";

const target = parseSshTarget("host");
const owner = { id: "9b77d0ec-a591-4a47-8d87-76b1074a0571", serviceVersion: "0.3.1" };
const lock = (extra = {}) => JSON.stringify({ pid: 42, host: "remote", port: 4310, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "0.3.1", owner: { kind: "desktop", id: owner.id, protocolVersion: 1 }, ...extra });

function adapter(probeResults: boolean[], contents = lock()) {
  const probe = vi.fn<OpenSshAdapter["probe"]>(async () => ({ ok: probeResults.shift() ?? true, exitCode: 0 }));
  const run = vi.fn<OpenSshAdapter["run"]>(async () => ({ stdout: contents, stderr: "", exitCode: 0 }));
  const open = vi.fn<OpenSshAdapter["open"]>(async () => { throw new Error("not used"); });
  return { executable: "ssh", probe, run, open };
}

describe("remote lock inspection", () => {
  it("treats a missing lock as absent without attempting a read", async () => {
    const ssh = adapter([false]);
    await expect(inspectRemoteLock(ssh, target, owner)).resolves.toEqual({ kind: "absent" });
    expect(ssh.run).not.toHaveBeenCalled();
  });
  it("classifies stale, same-owner, foreign desktop, and CLI locks without signaling", async () => {
    await expect(inspectRemoteLock(adapter([true, false]), target, owner)).resolves.toMatchObject({ kind: "stale", lock: { pid: 42 } });
    await expect(inspectRemoteLock(adapter([true, true]), target, owner)).resolves.toMatchObject({ kind: "same_owner" });
    await expect(inspectRemoteLock(adapter([true, true], lock({ owner: { kind: "desktop", id: "other", protocolVersion: 1 } })), target, owner)).resolves.toMatchObject({ kind: "remote_console_owned_elsewhere" });
    await expect(inspectRemoteLock(adapter([true, true], lock({ owner: { kind: "cli", id: "cli", protocolVersion: 1 } })), target, owner)).resolves.toMatchObject({ kind: "remote_console_lock_conflict" });
  });
  it("keeps this Desktop's older Console distinct from another Desktop", async () => {
    await expect(inspectRemoteLock(adapter([true, true]), target, { ...owner, serviceVersion: "1.0.0" })).resolves.toMatchObject({ kind: "same_owner_version_mismatch" });
  });
  it("reuses a live same-owner Desktop lock without a registry version only when explicitly requested", async () => {
    await expect(inspectRemoteLock(adapter([true, true]), target, { id: owner.id }, { versionAgnostic: true })).resolves.toMatchObject({ kind: "same_owner" });
    await expect(inspectRemoteLock(adapter([true, true], lock({ owner: { kind: "desktop", id: "other", protocolVersion: 1 } })), target, { id: owner.id }, { versionAgnostic: true })).resolves.toMatchObject({ kind: "remote_console_owned_elsewhere" });
  });
  it("preserves a probe/read TOCTOU as conflict and bounds malformed locks", async () => {
    const probe = vi.fn<OpenSshAdapter["probe"]>(async () => ({ ok: true, exitCode: 0 }));
    const run = vi.fn<OpenSshAdapter["run"]>(async () => { throw Object.assign(new Error("ssh_failed"), { code: "ssh_failed" }); });
    const open = vi.fn<OpenSshAdapter["open"]>(async () => { throw new Error("not used"); });
    const ssh = { executable: "ssh", probe, run, open };
    await expect(inspectRemoteLock(ssh, target, owner)).resolves.toEqual({ kind: "remote_console_lock_conflict" });
    expect(() => parseRemoteConsoleLock("x".repeat(64 * 1024 + 1))).toThrow("remote_lock_too_large");
    expect(() => parseRemoteConsoleLock(lock({ endpoint: "http://localhost:4310/" }))).toThrow();
  });
});
