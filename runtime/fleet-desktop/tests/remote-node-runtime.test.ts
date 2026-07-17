import { describe, expect, it, vi } from "vitest";

import { detectRemotePlatform, ensureRemoteNode } from "../src/runtime/remote/node-runtime.js";
import { parseSshTarget } from "../src/runtime/remote/target.js";

const manifest = { version: "22.23.1", source: "https://node.invalid", targets: { "darwin-arm64": { archive: "node-v22.23.1-darwin-arm64.tar.gz", sha256: "darwin-arm64" }, "darwin-x64": { archive: "node-v22.23.1-darwin-x64.tar.gz", sha256: "darwin-x64" }, "linux-arm64": { archive: "node-v22.23.1-linux-arm64.tar.xz", sha256: "0294e8b915ab75f92c7513d2fcb830ae06e10684e6c603e99a87dbf8835389c1" }, "linux-x64": { archive: "node-v22.23.1-linux-x64.tar.xz", sha256: "x64" } } };

describe("remote Node runtime", () => {
  it("maps supported Linux and Darwin uname pairs to their pinned archives", async () => {
    const ssh = { run: vi.fn(async () => ({ stdout: "Linux\x0aaarch64\x0a", stderr: "", exitCode: 0 })) };
    await expect(detectRemotePlatform(parseSshTarget("devbox"), manifest, ssh)).resolves.toMatchObject({ targetKey: "linux-arm64", architecture: "arm64", archive: manifest.targets["linux-arm64"] });
    ssh.run.mockResolvedValueOnce({ stdout: "Darwin\x0aarm64\x0a", stderr: "", exitCode: 0 });
    await expect(detectRemotePlatform(parseSshTarget("devbox"), manifest, ssh)).resolves.toMatchObject({ targetKey: "darwin-arm64", architecture: "arm64", archive: manifest.targets["darwin-arm64"] });
    ssh.run.mockResolvedValueOnce({ stdout: "FreeBSD\x0ax86_64\x0a", stderr: "", exitCode: 0 });
    await expect(detectRemotePlatform(parseSshTarget("devbox"), manifest, ssh)).rejects.toMatchObject({ code: "remote_platform_unsupported" });
  });

  it("verifies local bytes before streaming only those bytes to the fixed upload operation", async () => {
    const ssh = { run: vi.fn(async (target: unknown, command: { operation: string }) => {
      if (command.operation === "read_runtime_file") throw new Error("missing");
      if (command.operation === "detect_platform") return { stdout: "Linux\x0ax86_64\x0a", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    }), probe: vi.fn(async () => ({ ok: true, exitCode: 0 })) };
    await ensureRemoteNode(parseSshTarget("devbox"), manifest, { ssh, nonce: () => "test", temporaryDirectory: async () => "/tmp/fleet", removeTemporaryDirectory: async () => undefined, downloadArchive: async () => ({ path: "/tmp/fleet/node.tar.xz", content: new Uint8Array([7, 8]) }) });
    expect(ssh.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: "upload_file", args: [".fleet/desktop/runtime/node.staging-test/node-v22.23.1-linux-x64.tar.xz"], stdin: new Uint8Array([7, 8]) }));
    expect(ssh.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: "upload_file", args: [".fleet/desktop/runtime/node.staging-test/.runtime-version"], stdin: new TextEncoder().encode("22.23.1\n") }));
    expect(ssh.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: "promote_runtime_path", args: [".fleet/desktop/runtime/node.staging-test", ".fleet/desktop/runtime/node"] }));
    expect(ssh.probe).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: "probe_path", args: [".fleet/desktop/runtime/node.staging-test/bin/node"] }));
  });
});
