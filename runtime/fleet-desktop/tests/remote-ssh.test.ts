import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createOpenSshAdapter } from "../src/runtime/remote/ssh.js";
import { parseSshTarget } from "../src/runtime/remote/target.js";

function fakeProcess() {
  const events = new EventEmitter();
  const stdout = new PassThrough(); const stderr = new PassThrough(); const stdin = new PassThrough();
  return { pid: 1, stdout, stderr, stdin, terminate: vi.fn(), exited: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => events.once("exit", resolve)), exit: (code = 0, signal: NodeJS.Signals | null = null) => events.emit("exit", { code, signal }) };
}

const runtime = ".fleet/desktop/runtime/node/staging";
const fleet = ".fleet/console/console.lock";
const owner = "9b77d0ec-a591-4a47-8d87-76b1074a0571";

describe("OpenSSH transport", () => {
  it("uses fixed noninteractive argv, composition-only extras, and target immediately after --", async () => {
    const process = fakeProcess(); const spawn = vi.fn(() => process);
    const adapter = await createOpenSshAdapter({ locate: async () => "/usr/bin/ssh", spawn, extraBaseArgv: ["-F", "/tmp/test-config"] });
    const pending = adapter.run(parseSshTarget("dev@host"), { operation: "detect_platform", args: [] });
    process.exit(); await pending;
    const args = calls(spawn)[0]![1];
    expect(args).toEqual(expect.arrayContaining(["-T", "-F", "/tmp/test-config", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "dev@host", "sh -c 'set -eu; uname -s; uname -m' fleet-remote"]));
    expect(args[args.indexOf("--") + 1]).toBe("dev@host");
  });

  it.each([
    ["read_lock", [], "cat \"$HOME/.fleet/console/console.lock\""],
    ["stop_console", ["42"], "kill \"$1\""],
    ["prepare_staging", [runtime], "mkdir -p \"$HOME/$1\""],
    ["upload_file", [runtime], "cat > \"$HOME/$1\""],
    ["extract_archive", [".fleet/desktop/runtime/node.tar.xz", runtime], "tar -xJf \"$HOME/$1\""],
    ["read_runtime_file", [fleet], "cat \"$HOME/$1\""],
    ["remove_runtime_path", [runtime], "rm -rf \"$HOME/$1\""],
    ["promote_runtime_path", [runtime, ".fleet/desktop/runtime/node"], "mv \"$HOME/$1\" \"$HOME/$2\""],
    ["chmod_exec", [runtime], "chmod 0755 \"$HOME/$1\""],
    ["normalize_console_prefix", [runtime], "mv \"$root/node_modules/@dotobokuri/fleet-console\" \"$held\""],
    ["install_console", [".fleet/desktop/runtime/node/bin/node", ".fleet/desktop/runtime/node/lib/npm.js", runtime, "@dotobokuri/fleet-console@latest"], "install --prefix \"$prefix\""],
    ["start_console", [runtime, ".fleet/desktop/runtime/node/bin/node", ".fleet/desktop/runtime/console/latest/dist/cli.mjs", owner, "1", "0.3.1", ".fleet/console"], "FLEET_CONSOLE_DIR=\"$HOME/$7\""],
  ] as const)("uses a fixed set -eu script and exact argv for %s", async (operation, commandArgs, fragment) => {
    const process = fakeProcess(); const spawn = vi.fn(() => process);
    const adapter = await createOpenSshAdapter({ locate: async () => "ssh", spawn });
    const command = operation === "upload_file" ? { operation, args: commandArgs, stdin: new Uint8Array([1, 2]) } : { operation, args: commandArgs };
    const pending = adapter.run(parseSshTarget("host"), command);
    process.exit(); await pending;
    const args = calls(spawn)[0]![1];
    const program = args.at(-1)!;
    expect(program).toMatch(/^sh -c 'set -eu;/u);
    expect(program).toContain(fragment);
    expect(program).toContain(["fleet-remote", ...commandArgs.map(shellQuote)].join(" "));
  });

  it("interprets predicate exit 0/1 while treating 255 as an SSH transport failure", async () => {
    for (const [operation, commandArgs, exitCode, expected, scriptFragment] of [
      ["check_process", ["42"], 0, { ok: true, exitCode: 0 }, "kill -0 \"$1\""],
      ["probe_path", [fleet], 1, { ok: false, exitCode: 1 }, "test -e \"$HOME/$1\""],
    ] as const) {
      const process = fakeProcess(); const spawn = vi.fn(() => process);
      const adapter = await createOpenSshAdapter({ locate: async () => "ssh", spawn });
      const pending = adapter.probe(parseSshTarget("host"), { operation, args: commandArgs } as never);
      process.exit(exitCode);
      await expect(pending).resolves.toEqual(expected);
      expect(calls(spawn)[0]![1].join(" ")).toContain(scriptFragment);
    }
    const process = fakeProcess(); const adapter = await createOpenSshAdapter({ locate: async () => "ssh", spawn: () => process });
    const pending = adapter.probe(parseSshTarget("host"), { operation: "check_process", args: ["42"] });
    process.exit(255);
    await expect(pending).rejects.toThrow("ssh_failed");
  });

  it("reserves predicates for probe() and rejects non-predicates in probe()", async () => {
    const spawn = vi.fn(); const adapter = await createOpenSshAdapter({ locate: async () => "ssh", spawn });
    await expect(adapter.run(parseSshTarget("host"), { operation: "check_process", args: ["42"] })).rejects.toThrow("remote_command_invalid");
    await expect(adapter.run(parseSshTarget("host"), { operation: "probe_path", args: [fleet] })).rejects.toThrow("remote_command_invalid");
    await expect(adapter.probe(parseSshTarget("host"), { operation: "read_lock", args: [] })).rejects.toThrow("remote_command_invalid");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects invalid paths, PID values, literal specs, stdin misuse, and wrong arity before spawning", async () => {
    const spawn = vi.fn(); const adapter = await createOpenSshAdapter({ locate: async () => "ssh", spawn });
    const invalid = [
      { operation: "probe_path", args: ["../.fleet/x"] }, { operation: "probe_path", args: ["/.fleet/x"] }, { operation: "probe_path", args: ["~/.fleet/x"] }, { operation: "probe_path", args: [".fleet/-option"] },
      { operation: "check_process", args: ["0"] }, { operation: "check_process", args: ["1.5"] }, { operation: "check_process", args: ["9007199254740992"] },
      { operation: "install_console", args: [runtime, runtime, runtime, "@dotobokuri/fleet-console@next"] }, { operation: "read_lock", args: ["unexpected"] }, { operation: "read_lock", args: [], stdin: new Uint8Array([1]) }, { operation: "upload_file", args: [runtime] },
    ] as const;
    for (const command of invalid) await expect(adapter.run(parseSshTarget("host"), command as never)).rejects.toThrow("remote_command_invalid");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("cancels, bounds output, and reports missing Windows ssh.exe", async () => {
    await expect(createOpenSshAdapter({ platform: "win32", locate: async () => null })).rejects.toThrow("ssh_unavailable");
    const controller = new AbortController(); controller.abort();
    const adapter = await createOpenSshAdapter({ locate: async () => "ssh" });
    await expect(adapter.run(parseSshTarget("host"), { operation: "read_lock", args: [] }, { signal: controller.signal })).rejects.toThrow("ssh_cancelled");
    const process = fakeProcess(); const limited = await createOpenSshAdapter({ locate: async () => "ssh", spawn: () => process, outputLimitBytes: 2 });
    const pending = limited.run(parseSshTarget("host"), { operation: "read_lock", args: [] });
    process.stdout.write("too much"); process.exit();
    await expect(pending).rejects.toThrow("remote_command_output_too_large");
    expect(process.terminate).toHaveBeenCalled();
  });
});

function calls(spawn: ReturnType<typeof vi.fn>): readonly [string, string[]][] { return spawn.mock.calls as unknown as readonly [string, string[]][]; }
function shellQuote(value: string): string { return `'${value.replace(/'/gu, "'\\''")}'`; }
