import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { MAX_TUNNEL_ATTEMPTS, RemoteTunnelPortCollision, RemoteTunnelPortConflictExhausted, openSamePortTunnel, openTunnelWithReroll } from "../src/runtime/remote/tunnel.js";
import { parseSshTarget } from "../src/runtime/remote/target.js";

function process() { const events = new EventEmitter(); return { pid: 1, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), terminate: vi.fn(), exited: new Promise((resolve) => events.once("exit", resolve)), exit: (code = 0) => events.emit("exit", { code, signal: null }) }; }

describe("same-port remote tunnels", () => {
  it("uses an identical local/remote q and ExitOnForwardFailure", async () => {
    const child = process(); const open = vi.fn(async () => child); const ssh = { open } as never;
    const tunnel = await openSamePortTunnel(ssh, parseSshTarget("host"), 4310, undefined, { settle: async () => {} });
    expect(open.mock.calls[0][1]).toEqual(expect.arrayContaining(["-N", "-T", "-o", "ExitOnForwardFailure=yes", "-L", "4310:127.0.0.1:4310"]));
    child.exit(); await tunnel.dispose();
  });
  it("maps an OpenSSH local bind failure to the collision path", async () => {
    const child = process(); child.stderr.write("bind: Address already in use"); child.exit(255);
    await expect(openSamePortTunnel({ open: async () => child } as never, parseSshTarget("host"), 4310, undefined, { settle: async () => {} })).rejects.toBeInstanceOf(RemoteTunnelPortCollision);
  });
  it("rerolls exactly through attempt five then exhausts", async () => {
    const reroll = vi.fn(async (service: { port: number }) => ({ port: service.port + 1 }));
    await expect(openTunnelWithReroll({ port: 1 }, async () => { throw new RemoteTunnelPortCollision(); }, reroll)).rejects.toBeInstanceOf(RemoteTunnelPortConflictExhausted);
    expect(reroll).toHaveBeenCalledTimes(MAX_TUNNEL_ATTEMPTS - 1);
  });
});
