import { beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({ node: vi.fn(), console: vi.fn(), lock: vi.fn() }));
vi.mock("../src/runtime/remote/node-runtime.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/runtime/remote/node-runtime.js")>()), readRemoteNodeRuntime: seams.node }));
vi.mock("../src/runtime/remote/console-runtime.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/runtime/remote/console-runtime.js")>()), readRemoteConsoleRuntime: seams.console }));
vi.mock("../src/runtime/remote/lock.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/runtime/remote/lock.js")>()), inspectRemoteLock: seams.lock }));

import { runRemoteLiveTest } from "../src/runtime/remote/live-runner.js";

const manifest = { version: "22.23.1", source: "https://node.example", targets: { "linux-x64": { archive: "node.tar.xz", sha256: "x" } } };

describe("remote live runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seams.node.mockResolvedValue({});
    seams.console.mockResolvedValue({ version: "1.26.2" });
    seams.lock.mockResolvedValue({ kind: "same_owner" });
  });

  it("emits the required ordered proof and refuses owner B before it can mutate", async () => {
    const checkpoints: string[] = [];
    const dispose = vi.fn(async () => undefined);
    const connect = vi.fn()
      .mockResolvedValueOnce({ target: { value: "root@disposable", user: "root", host: "disposable" }, origin: "http://127.0.0.1:4310", commit: vi.fn(), dispose, rollback: vi.fn() })
      .mockRejectedValueOnce(new Error("remote_console_owned_elsewhere"));
    const run = vi.fn(async () => ({ stdout: "Linux\nx86_64\n", stderr: "", exitCode: 0 }));
    await runRemoteLiveTest({
      env: disposableEnvironment(), emit: (checkpoint) => checkpoints.push(checkpoint),
      dependencies: { createSsh: async () => ({ run } as never), readManifest: async () => manifest, createRegistry: () => registry(), connect, fetch: async () => response(200), randomUuid: uuidFactory(), temporaryDirectory: () => "/tmp" },
    });
    expect(checkpoints).toEqual(["architecture_detected", "node_installed_or_valid", "console_latest_installed_or_valid", "owned_lock_ready", "same_port_tunnel_ready", "pairing_identity_200", "foreign_owner_refused", "cleanup_complete"]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1]?.[1].ownerId).not.toBe(connect.mock.calls[0]?.[1].ownerId);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("fails closed without an explicit disposable-host opt-in", async () => {
    await expect(runRemoteLiveTest({ env: { FLEET_REMOTE_TEST_TARGET: "root@test" } })).rejects.toThrow("remote_live_disposable_target_required");
  });

  it("injects an optional SSH config only through the adapter composition seam", async () => {
    const createSsh = vi.fn(async () => ({ run: async () => ({ stdout: "Linux\nx86_64\n", stderr: "", exitCode: 0 }) } as never));
    await expect(runRemoteLiveTest({
      env: { ...disposableEnvironment(), FLEET_REMOTE_TEST_SSH_CONFIG: "/tmp/disposable-ssh-config" },
      emit: () => undefined,
      dependencies: { createSsh, readManifest: async () => manifest, createRegistry: () => registry(), connect: async () => { throw new Error("stop_after_composition"); }, randomUuid: uuidFactory(), temporaryDirectory: () => "/tmp" },
    })).rejects.toThrow("stop_after_composition");
    expect(createSsh).toHaveBeenCalledWith({ extraBaseArgv: ["-F", "/tmp/disposable-ssh-config"] });
  });

  it("cleans the candidate after an intermediate identity failure", async () => {
    const checkpoints: string[] = [];
    const dispose = vi.fn(async () => undefined);
    await expect(runRemoteLiveTest({
      env: disposableEnvironment(), emit: (checkpoint) => checkpoints.push(checkpoint),
      dependencies: { createSsh: async () => ({ run: async () => ({ stdout: "Linux\nx86_64\n", stderr: "", exitCode: 0 }) } as never), readManifest: async () => manifest, createRegistry: () => registry(), connect: async () => ({ target: { value: "root@disposable", user: "root", host: "disposable" }, origin: "http://127.0.0.1:4310", commit: vi.fn(), dispose, rollback: vi.fn() }), fetch: async () => response(500), randomUuid: uuidFactory(), temporaryDirectory: () => "/tmp" },
    })).rejects.toThrow("remote_live_pairing_identity_invalid");
    expect(dispose).toHaveBeenCalledOnce();
    expect(checkpoints.at(-1)).toBe("cleanup_complete");
  });
});

function disposableEnvironment(): NodeJS.ProcessEnv { return { FLEET_REMOTE_TEST_TARGET: "root@disposable", FLEET_REMOTE_TEST_EPHEMERAL: "1" }; }
function registry() { return { check: async () => ({ latest: null, shouldNotify: false }), skip: async () => undefined, startPolling: () => () => undefined }; }
function response(status: number) { return { status, json: async () => ({ product: "fleet-console", schemaVersion: 1, pairingProtocolVersion: 1 }) }; }
function uuidFactory() { let value = 0; return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`; }
