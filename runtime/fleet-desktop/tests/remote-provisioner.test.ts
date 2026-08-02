import { describe, expect, it, vi } from "vitest";

import { formatDesktopResourceRootMarker } from "@fleet-console/desktop-protocol";

import { provisionRemoteRuntime } from "../src/runtime/remote/provisioner.js";
import { parseSshTarget } from "../src/runtime/remote/contracts.js";

describe("remote provisioner", () => {
  it("composes Node then Console through injected SSH and registry seams", async () => {
    const ssh = { run: vi.fn(async (_target: unknown, command: { operation: string; args: readonly string[] }) => {
      if (command.operation === "read_runtime_file") {
        if (command.args.join("/").includes("node/.runtime-version")) throw new Error("missing");
        if (command.args.join("/").includes("latest")) throw new Error("missing");
        return { stdout: command.args.at(-1)?.endsWith("package.json") ? JSON.stringify({ version: "2.0.0", engines: { node: ">=22.12.0" } }) : formatDesktopResourceRootMarker(), stderr: "", exitCode: 0 };
      }
      if (command.operation === "detect_platform") return { stdout: "Linux\x0ax86_64\x0a", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    }), probe: vi.fn(async () => ({ ok: true, exitCode: 0 })) };
    const phases: string[] = [];
    const result = await provisionRemoteRuntime(parseSshTarget("devbox"), { ssh, registry: { check: async () => ({ latest: "2.0.0", shouldNotify: true }) }, manifest: { version: "22.23.1", source: "https://node.invalid", targets: { "linux-x64": { archive: "node.tar.xz", sha256: "ok" } } }, nonce: () => "test", temporaryDirectory: async () => "/tmp/fleet", removeTemporaryDirectory: async () => undefined, downloadArchive: async () => ({ path: "/tmp/fleet/node.tar.xz", content: new Uint8Array([1]) }) }, (phase) => phases.push(phase));
    expect(result.console.version).toBe("2.0.0");
    expect(phases).toEqual(["provisioning_node", "provisioning_console"]);
  });
});
