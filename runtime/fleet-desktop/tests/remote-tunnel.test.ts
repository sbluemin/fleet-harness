import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { MAX_TUNNEL_ATTEMPTS, RemoteTunnelPortCollision, RemoteTunnelPortConflictExhausted, openSamePortTunnel, openTunnelWithReroll } from "../src/runtime/remote/tunnel.js";
import { parseSshTarget } from "../src/runtime/remote/target.js";
import type { OpenSshAdapter, OpenSshProcess } from "../src/runtime/remote/ssh.js";

function process(): OpenSshProcess & { readonly stderr: PassThrough; exit(code?: number): void } {
  const events = new EventEmitter();
  const stderr = new PassThrough();
  return { pid: 1, stdout: new PassThrough(), stderr, stdin: new PassThrough(), terminate: vi.fn(), exited: new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => events.once("exit", resolve)), exit: (code = 0) => events.emit("exit", { code, signal: null }) };
}

function adapter(open: OpenSshAdapter["open"]): OpenSshAdapter {
  return { executable: "ssh", open, run: async () => { throw new Error("not used"); }, probe: async () => ({ ok: false, exitCode: 1 }) };
}

describe("same-port remote tunnels", () => {
  it("uses an explicit loopback bind with an identical local/remote q and ExitOnForwardFailure", async () => {
    const child = process(); const open = vi.fn<OpenSshAdapter["open"]>(async () => child); const ssh = adapter(open);
    const tunnel = await openSamePortTunnel(ssh, parseSshTarget("host"), 4310, undefined, { settle: async () => {} });
    expect(open).toHaveBeenCalledWith(expect.anything(), ["-N", "-T", "-o", "ExitOnForwardFailure=yes", "-L", "127.0.0.1:4310:127.0.0.1:4310"], undefined);
    child.exit(); await tunnel.dispose();
  });
  it("maps an OpenSSH local bind failure to the collision path", async () => {
    const child = process(); child.stderr.write("bind: Address already in use"); child.exit(255);
    await expect(openSamePortTunnel(adapter(async () => child), parseSshTarget("host"), 4310, undefined, { settle: async () => {} })).rejects.toBeInstanceOf(RemoteTunnelPortCollision);
  });
  it("waits through the bounded settle window for a delayed bind failure", async () => {
    vi.useFakeTimers();
    try {
      const child = process();
      const pending = openSamePortTunnel(adapter(async () => child), parseSshTarget("host"), 4310);
      await vi.advanceTimersByTimeAsync(1);
      child.stderr.write("bind: Address already in use");
      child.exit(255);
      await expect(pending).rejects.toBeInstanceOf(RemoteTunnelPortCollision);
    } finally { vi.useRealTimers(); }
  });
  it("returns a healthy tunnel after the bounded settle window", async () => {
    vi.useFakeTimers();
    try {
      const child = process();
      const pending = openSamePortTunnel(adapter(async () => child), parseSshTarget("host"), 4310);
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ port: 4310 });
    } finally { vi.useRealTimers(); }
  });
  it("rerolls exactly through attempt five then exhausts", async () => {
    const reroll = vi.fn(async (service: { port: number }) => ({ port: service.port + 1 }));
    await expect(openTunnelWithReroll({ port: 1 }, async () => { throw new RemoteTunnelPortCollision(); }, reroll)).rejects.toBeInstanceOf(RemoteTunnelPortConflictExhausted);
    expect(reroll).toHaveBeenCalledTimes(MAX_TUNNEL_ATTEMPTS - 1);
  });
});
