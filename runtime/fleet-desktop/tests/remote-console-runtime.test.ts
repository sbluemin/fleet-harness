import { describe, expect, it, vi } from "vitest";

import { formatDesktopResourceRootMarker } from "@fleet-console/desktop-protocol";

import { ensureRemoteConsole } from "../src/runtime/remote/console-runtime.js";
import { parseSshTarget } from "../src/runtime/remote/target.js";

const node = { root: ".fleet/desktop/runtime/node", nodeBin: ".fleet/desktop/runtime/node/bin/node", npmCli: ".fleet/desktop/runtime/node/lib/node_modules/npm/bin/npm-cli.js", version: "22.23.1" };

describe("remote Console runtime", () => {
  it("installs literal latest into staging and validates before atomic promotion", async () => {
    const ssh = { run: vi.fn(async (_target: unknown, command: { operation: string; args: readonly string[] }) => {
      if (command.operation === "read_runtime_file" && command.args.at(-1)?.endsWith("/package.json")) {
        if (command.args.join("/").includes("latest")) throw new Error("missing");
        return { stdout: JSON.stringify({ version: "2.0.0", engines: { node: ">=22.12.0" } }), stderr: "", exitCode: 0 };
      }
      if (command.operation === "read_runtime_file") return { stdout: formatDesktopResourceRootMarker(), stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    }), probe: vi.fn(async () => ({ ok: true, exitCode: 0 })) };
    const registry = { check: vi.fn(async () => ({ latest: "2.0.0", shouldNotify: true })) };
    await expect(ensureRemoteConsole(parseSshTarget("devbox"), node, { ssh, registry, nonce: () => "test" })).resolves.toMatchObject({ version: "2.0.0" });
    expect(ssh.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: "install_console", args: [node.nodeBin, node.npmCli, ".fleet/desktop/runtime/console/.staging-test", "@dotobokuri/fleet-console@latest"] }));
    expect(ssh.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: "normalize_console_prefix", args: [".fleet/desktop/runtime/console/.staging-test"] }));
    expect(ssh.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: "upload_file", args: [".fleet/desktop/runtime/console/.staging-test/.fleet-console-resource-root"], stdin: new TextEncoder().encode(formatDesktopResourceRootMarker()) }));
    expect(ssh.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: "promote_runtime_path", args: [".fleet/desktop/runtime/console/.staging-test", ".fleet/desktop/runtime/console/latest"] }));
  });

  it("preserves a valid installed Console when the registry is offline", async () => {
    const ssh = { run: vi.fn(async (_target: unknown, command: { operation: string; args: readonly string[] }) => command.operation === "read_runtime_file" ? { stdout: command.args.at(-1)?.endsWith("package.json") ? JSON.stringify({ version: "1.0.0", engines: { node: ">=22.12.0" } }) : formatDesktopResourceRootMarker(), stderr: "", exitCode: 0 } : { stdout: "", stderr: "", exitCode: 0 }), probe: vi.fn(async () => ({ ok: true, exitCode: 0 })) };
    const result = await ensureRemoteConsole(parseSshTarget("devbox"), node, { ssh, registry: { check: async () => ({ latest: null, shouldNotify: false, unavailable: true }) } });
    expect(result.version).toBe("1.0.0");
    expect(ssh.run).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: "install_console" }));
  });
});
