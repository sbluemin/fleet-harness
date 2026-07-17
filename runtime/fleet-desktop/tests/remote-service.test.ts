import { describe, expect, it, vi } from "vitest";

import { startRemoteService, stopOwnedRemoteService } from "../src/runtime/remote/service.js";
import { parseSshTarget } from "../src/runtime/remote/target.js";

const target = parseSshTarget("host"); const owner = "9b77d0ec-a591-4a47-8d87-76b1074a0571";
const json = JSON.stringify({ pid: 42, host: "remote", port: 4310, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "0.3.1", owner: { kind: "desktop", id: owner, protocolVersion: 1 } });
const launch = { serviceRootRel: ".fleet/desktop/runtime/console/latest", nodeBinRel: ".fleet/desktop/runtime/node/bin/node", cliRel: ".fleet/desktop/runtime/console/latest/dist/cli.mjs", ownerId: owner, protocolVersion: 1, desktopVersion: "0.3.1", consoleDirRel: ".fleet/console" };

describe("remote service lifecycle", () => {
  it("starts with relative paths and returns the same-owner ready lock", async () => {
    const ssh = { run: vi.fn(async (_target, command) => command.operation === "start_console" ? { stdout: "42", stderr: "", exitCode: 0 } : { stdout: json, stderr: "", exitCode: 0 }), probe: vi.fn(async (_target, command) => ({ ok: command.operation === "probe_path" || command.args[0] === "42", exitCode: 0 })) } as never;
    const ready = await startRemoteService(ssh, target, launch, { wait: async () => {} });
    expect(ready.port).toBe(4310);
    expect(ssh.run.mock.calls[0][1]).toMatchObject({ operation: "start_console", args: expect.arrayContaining([".fleet/console"]) });
  });
  it("refuses to stop an unclassified foreign pid", async () => {
    const ssh = { run: vi.fn(async () => ({ stdout: json, stderr: "", exitCode: 0 })), probe: vi.fn(async (_target, command) => command.operation === "probe_path" ? ({ ok: true, exitCode: 0 }) : ({ ok: true, exitCode: 0 })) } as never;
    await expect(stopOwnedRemoteService(ssh, target, { pid: 99, host: "remote", port: 4310, endpoint: "http://127.0.0.1:4310/", token: "secret", version: "0.3.1", owner: { kind: "desktop", id: "foreign", protocolVersion: 1 } }, { id: owner, version: "0.3.1" })).rejects.toThrow("remote_console_stop_not_owned");
    expect(ssh.run).toHaveBeenCalledTimes(1); // The read is harmless; stop_console is never issued.
    expect(ssh.run.mock.calls[0][1].operation).toBe("read_lock");
  });
});
