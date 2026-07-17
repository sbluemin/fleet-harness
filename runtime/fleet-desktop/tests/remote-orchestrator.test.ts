import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  inspect: vi.fn(), provision: vi.fn(), start: vi.fn(), stop: vi.fn(), open: vi.fn(), reroll: vi.fn(),
}));

vi.mock("../src/runtime/remote/lock.js", () => ({ inspectRemoteLock: seams.inspect }));
vi.mock("../src/runtime/remote/provisioner.js", () => ({ provisionRemoteRuntime: seams.provision }));
vi.mock("../src/runtime/remote/service.js", () => ({ startRemoteService: seams.start, stopOwnedRemoteService: seams.stop }));
vi.mock("../src/runtime/remote/tunnel.js", () => ({ openSamePortTunnel: seams.open, openTunnelWithReroll: seams.reroll }));

import { connectManagedRemote } from "../src/runtime/remote/orchestrator.js";

const ownerId = "9b77d0ec-a591-4a47-8d87-76b1074a0571";
const lock = { pid: 42, host: "remote", port: 4310, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "0.3.1" };

describe("managed remote orchestrator", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("classifies before provisioning, then serves and tunnels in order", async () => {
    const order: string[] = [];
    seams.inspect.mockImplementation(async () => { order.push("lock"); return { kind: "absent" }; });
    seams.provision.mockImplementation(async () => { order.push("provision"); return { node: { nodeBin: ".fleet/desktop/runtime/node/bin/node", version: "22.23.1" }, console: { root: ".fleet/desktop/runtime/console/latest", version: "0.3.1", cli: ".fleet/desktop/runtime/console/latest/dist/cli.mjs" } }; });
    seams.start.mockImplementation(async () => { order.push("serve"); return lock; });
    seams.open.mockImplementation(async () => { order.push("tunnel"); return { port: 4310, dispose: vi.fn(), rollback: vi.fn() }; });
    seams.reroll.mockImplementation(async (initial, open) => ({ service: initial, tunnel: await open(initial.port) }));
    const fetch = vi.fn(async () => { order.push("pairing"); return pairingIdentityResponse(); });
    const phases: string[] = [];
    const session = await connectManagedRemote("devbox", dependencies({ fetch, onPhase: (phase: string) => phases.push(phase) }));
    expect(order).toEqual(["lock", "provision", "serve", "tunnel", "pairing"]);
    expect(phases).toContain("verifying_pairing");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4310/api/v1/pairing-identity", { signal: undefined });
    expect(session.origin).toBe("http://127.0.0.1:4310");
  });

  it("retries a tunnel identity request until the local forwarding is ready", async () => {
    seams.inspect.mockResolvedValue({ kind: "absent" });
    seams.provision.mockResolvedValue(runtime());
    seams.start.mockResolvedValue(lock);
    seams.open.mockResolvedValue({ port: 4310, dispose: vi.fn(), rollback: vi.fn() });
    seams.reroll.mockImplementation(async (initial, open) => ({ service: initial, tunnel: await open(initial.port) }));
    const fetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce(pairingIdentityResponse());
    await expect(connectManagedRemote("devbox", dependencies({ fetch }))).resolves.toMatchObject({ origin: "http://127.0.0.1:4310" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reuses a same-owner runtime after registry observation without provisioning or restart", async () => {
    seams.inspect.mockResolvedValue({ kind: "same_owner", lock });
    seams.open.mockResolvedValue({ port: 4310, dispose: vi.fn(), rollback: vi.fn() });
    seams.reroll.mockImplementation(async (initial, open) => ({ service: initial, tunnel: await open(initial.port) }));
    const registry = { check: vi.fn(async () => ({ latest: "0.3.1", shouldNotify: true })) };
    await connectManagedRemote("devbox", dependencies({ registry }));
    expect(registry.check).toHaveBeenCalledWith("");
    expect(seams.provision).not.toHaveBeenCalled();
    expect(seams.start).not.toHaveBeenCalled();
  });

  it("reuses a live same-owner runtime while the registry is offline without stopping it", async () => {
    seams.inspect.mockResolvedValue({ kind: "same_owner", lock });
    seams.open.mockResolvedValue({ port: 4310, dispose: vi.fn(), rollback: vi.fn() });
    seams.reroll.mockImplementation(async (initial, open) => ({ service: initial, tunnel: await open(initial.port) }));
    const registry = { check: vi.fn(async () => ({ latest: null, shouldNotify: false, unavailable: true })) };
    await connectManagedRemote("devbox", dependencies({ registry }));
    expect(seams.inspect).toHaveBeenCalledWith(expect.anything(), expect.anything(), { id: ownerId }, { versionAgnostic: true });
    expect(seams.provision).not.toHaveBeenCalled();
    expect(seams.start).not.toHaveBeenCalled();
    expect(seams.stop).not.toHaveBeenCalled();
  });

  it("refuses foreign desktop locks before any mutable operation", async () => {
    seams.inspect.mockResolvedValue({ kind: "remote_console_owned_elsewhere", lock });
    await expect(connectManagedRemote("devbox", dependencies())).rejects.toThrow("remote_console_owned_elsewhere");
    expect(seams.provision).not.toHaveBeenCalled();
    expect(seams.open).not.toHaveBeenCalled();
  });

  it("refuses a foreign Desktop lock while the registry is offline", async () => {
    seams.inspect.mockResolvedValue({ kind: "remote_console_owned_elsewhere", lock });
    const registry = { check: vi.fn(async () => ({ latest: null, shouldNotify: false, unavailable: true })) };
    await expect(connectManagedRemote("devbox", dependencies({ registry }))).rejects.toThrow("remote_console_owned_elsewhere");
    expect(seams.inspect).toHaveBeenCalledWith(expect.anything(), expect.anything(), { id: ownerId }, { versionAgnostic: true });
    expect(seams.provision).not.toHaveBeenCalled();
    expect(seams.open).not.toHaveBeenCalled();
  });

  it("provisions after a stale lock while the registry is offline", async () => {
    seams.inspect.mockResolvedValue({ kind: "stale" });
    seams.provision.mockResolvedValue(runtime());
    seams.start.mockResolvedValue(lock);
    seams.open.mockResolvedValue({ port: 4310, dispose: vi.fn(), rollback: vi.fn() });
    seams.reroll.mockImplementation(async (initial, open) => ({ service: initial, tunnel: await open(initial.port) }));
    const registry = { check: vi.fn(async () => ({ latest: null, shouldNotify: false, unavailable: true })) };
    await connectManagedRemote("devbox", dependencies({ registry }));
    expect(seams.inspect).toHaveBeenCalledWith(expect.anything(), expect.anything(), { id: ownerId }, { versionAgnostic: true });
    expect(seams.provision).toHaveBeenCalledOnce();
    expect(seams.start).toHaveBeenCalledOnce();
  });

  it("preserves online version-mismatch replacement behavior", async () => {
    seams.inspect.mockResolvedValue({ kind: "same_owner_version_mismatch", lock });
    seams.provision.mockResolvedValue(runtime());
    seams.start.mockResolvedValue(lock);
    seams.open.mockResolvedValue({ port: 4310, dispose: vi.fn(), rollback: vi.fn() });
    seams.reroll.mockImplementation(async (initial, open) => ({ service: initial, tunnel: await open(initial.port) }));
    await connectManagedRemote("devbox", dependencies({ registry: { check: async () => ({ latest: "0.3.1", shouldNotify: false }) } }));
    expect(seams.inspect).toHaveBeenCalledWith(expect.anything(), expect.anything(), { id: ownerId, serviceVersion: "0.3.1" }, undefined);
    expect(seams.stop).toHaveBeenCalledWith(expect.anything(), expect.anything(), lock, { id: ownerId, serviceVersion: "0.3.1" });
    expect(seams.provision).toHaveBeenCalledOnce();
  });

  it("uses the provisioned Console version for readiness ownership", async () => {
    seams.inspect.mockResolvedValue({ kind: "absent" });
    seams.provision.mockResolvedValue({ node: { nodeBin: ".fleet/desktop/runtime/node/bin/node", version: "22.23.1" }, console: { root: ".fleet/desktop/runtime/console/latest", version: "1.26.2", cli: ".fleet/desktop/runtime/console/latest/dist/cli.mjs" } });
    seams.start.mockResolvedValue(lock);
    seams.open.mockResolvedValue({ port: 4310, dispose: vi.fn(), rollback: vi.fn() });
    seams.reroll.mockImplementation(async (initial, open) => ({ service: initial, tunnel: await open(initial.port) }));
    await connectManagedRemote("devbox", dependencies({ registry: { check: async () => ({ latest: "1.26.2", shouldNotify: false }) } }));
    expect(seams.start).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ serviceVersion: "1.26.2" }));
  });

  it("stops a same-owner candidate when readiness fails after serve", async () => {
    seams.inspect.mockResolvedValueOnce({ kind: "absent" }).mockResolvedValueOnce({ kind: "same_owner", lock });
    seams.provision.mockResolvedValue({ node: { nodeBin: ".fleet/desktop/runtime/node/bin/node", version: "22.23.1" }, console: { root: ".fleet/desktop/runtime/console/latest", version: "0.3.1", cli: ".fleet/desktop/runtime/console/latest/dist/cli.mjs" } });
    seams.start.mockRejectedValue(new Error("remote_console_readiness_timeout"));
    seams.stop.mockResolvedValue(undefined);
    await expect(connectManagedRemote("devbox", dependencies())).rejects.toThrow("remote_console_readiness_timeout");
    expect(seams.stop).toHaveBeenCalledWith(expect.anything(), expect.anything(), lock, { id: ownerId, serviceVersion: "0.3.1" });
  });

  it("cleans the tunnel and owned service when pairing readiness is cancelled", async () => {
    const controller = new AbortController();
    const dispose = vi.fn(async () => undefined);
    seams.inspect.mockResolvedValue({ kind: "absent" });
    seams.provision.mockResolvedValue(runtime());
    seams.start.mockResolvedValue(lock);
    seams.open.mockResolvedValue({ port: 4310, dispose, rollback: vi.fn() });
    seams.reroll.mockImplementation(async (initial, open) => ({ service: initial, tunnel: await open(initial.port) }));
    seams.stop.mockResolvedValue(undefined);
    const fetch = vi.fn(() => new Promise<never>(() => undefined));
    const pending = connectManagedRemote("devbox", dependencies({ cancellation: { signal: controller.signal }, fetch }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ssh_cancelled" });
    expect(dispose).toHaveBeenCalledOnce();
    expect(seams.stop).toHaveBeenCalledWith(expect.anything(), expect.anything(), lock, { id: ownerId, serviceVersion: "0.3.1" });
  });
});

function runtime() {
  return { node: { nodeBin: ".fleet/desktop/runtime/node/bin/node", version: "22.23.1" }, console: { root: ".fleet/desktop/runtime/console/latest", version: "0.3.1", cli: ".fleet/desktop/runtime/console/latest/dist/cli.mjs" } };
}

function pairingIdentityResponse() {
  return { status: 200, json: async () => ({ product: "fleet-console", schemaVersion: 1, pairingProtocolVersion: 1 }) };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    ssh: {}, manifest: { version: "22.23.1", source: "", targets: {} }, registry: { check: async () => ({ latest: "0.3.1", shouldNotify: false }) }, ownerId,
    protocolVersion: 1, desktopVersion: "0.3.1", consoleDirRel: ".fleet/console",
    fetch: async () => pairingIdentityResponse(),
    ...overrides,
  } as never;
}
