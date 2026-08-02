import { EventEmitter } from "node:events";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createOpenSshAdapter } from "../src/runtime/remote/ssh.js";
import { parseSshTarget } from "../src/runtime/remote/contracts.js";

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:child_process")>()), spawn: childProcess.spawn }));
const execFileAsync = promisify(execFile);

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
    ["remove_console_lock", ["42"], "grep -q"],
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

  it("hydrates start_console PATH from a validated remote login shell without changing the SSH argv boundary", async () => {
    const process = fakeProcess(); const spawn = vi.fn(() => process);
    const adapter = await createOpenSshAdapter({ locate: async () => "ssh", spawn });
    const pending = adapter.run(parseSshTarget("dev@host"), { operation: "start_console", args: [runtime, ".fleet/desktop/runtime/node/bin/node", ".fleet/desktop/runtime/console/latest/dist/cli.mjs", owner, "1", "0.3.1", ".fleet/console"] });
    process.exit(); await pending;
    const args = calls(spawn)[0]![1];
    const boundary = args.indexOf("--");
    const program = args.at(-1)!;
    expect(args.slice(boundary + 1)).toEqual(["dev@host", program]);
    expect(program).toContain('loginsh="${SHELL:-/bin/sh}"');
    expect(program).toContain('loginpath=$("$loginsh" -ilc');
    expect(program).toContain('case "$loginpath" in ""|:*|*:|*[[:cntrl:]]*) loginpath_valid=0');
    expect(program).toContain('case "$loginpath_entry" in /*) ;; *) loginpath_valid=0 ;; esac');
    expect(program).toContain('PATH="$loginpath:$PATH"; export PATH; fi; unset NODE_OPTIONS');
    expect(program).toContain('FLEET_CONSOLE_RESOURCE_ROOT="$HOME/$1" nohup "$HOME/$2" "$HOME/$3" serve >/dev/null 2>&1 & printf %s "$!"');
  });

  it("sanitizes inherited Node and Desktop control environment before remote Node execution", async () => {
    const install = await remoteProgram("install_console", [".fleet/desktop/runtime/node/bin/node", ".fleet/desktop/runtime/node/lib/npm.js", runtime, "@dotobokuri/fleet-console@latest"]);
    const start = await remoteProgram("start_console", [runtime, ".fleet/desktop/runtime/node/bin/node", ".fleet/desktop/runtime/console/latest/dist/cli.mjs", owner, "1", "0.3.1", ".fleet/console"]);
    const unset = "unset NODE_OPTIONS FLEET_CONSOLE_OWNER_ID FLEET_CONSOLE_OWNER_KIND FLEET_CONSOLE_PROTOCOL_VERSION FLEET_CONSOLE_RESOURCE_ROOT FLEET_CONSOLE_DIR FLEET_CONSOLE_DESKTOP_VERSION FLEET_CONSOLE_DESKTOP_DEVELOPMENT";
    for (const program of [install, start]) {
      expect(program).toContain(unset);
      expect(program).toContain("for v in $(env | sed -n");
    }
    const npmConfigUnset = "grep -iE";
    expect(install).toContain(npmConfigUnset);
    expect(install).toContain("^npm_config_");
    expect(install).toContain("cut -d= -f1");
    expect(install.indexOf(npmConfigUnset)).toBeLessThan(install.indexOf('npm_config_userconfig="$prefix/.npmrc"'));
    expect(install).toContain('npm_config_userconfig="$prefix/.npmrc" npm_config_globalconfig="$prefix/.npmrc-global" npm_config_registry=https://registry.npmjs.org/');
    expect(install.indexOf(unset)).toBeLessThan(install.indexOf('"$HOME/$1" "$HOME/$2" install'));
    expect(start.indexOf(unset)).toBeLessThan(start.indexOf('FLEET_CONSOLE_OWNER_KIND=desktop'));
  });

  it("reconciles an interrupted promotion backup before continuing the promotion", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fleet-remote-promote-"));
    const latest = ".fleet/desktop/runtime/node";
    const backup = path.join(home, `${latest}.old`);
    try {
      await mkdir(backup, { recursive: true });
      await writeFile(path.join(backup, "marker"), "recoverable");
      const program = await remoteProgram("promote_runtime_path", [".fleet/desktop/runtime/node.staging", latest]);
      expect(program).toContain('if [ ! -e "$HOME/$2" ] && [ -e "$HOME/$2.old" ]; then mv "$HOME/$2.old" "$HOME/$2"; fi;');
      await expect(execFileAsync("/bin/sh", ["-c", program], { env: { ...process.env, HOME: home } })).rejects.toBeDefined();
      await expect(readFile(path.join(backup, "marker"), "utf8")).resolves.toBe("recoverable");
    } finally { await rm(home, { force: true, recursive: true }); }
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
      { operation: "install_console", args: [runtime, runtime, runtime, "@dotobokuri/fleet-console@next"] }, { operation: "read_lock", args: ["unexpected"] }, { operation: "remove_console_lock", args: [] }, { operation: "remove_console_lock", args: ["1.5"] }, { operation: "read_lock", args: [], stdin: new Uint8Array([1]) }, { operation: "upload_file", args: [runtime] },
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

  it("absorbs upload stdin write errors and reports the SSH process failure", async () => {
    const process = fakeProcess(); const spawn = vi.fn(() => process);
    const adapter = await createOpenSshAdapter({ locate: async () => "ssh", spawn });
    const pending = adapter.run(parseSshTarget("host"), { operation: "upload_file", args: [runtime], stdin: new Uint8Array([1, 2]) });
    expect(process.stdin.listenerCount("error")).toBeGreaterThan(0);
    expect(() => process.stdin.emit("error", new Error("EPIPE"))).not.toThrow();
    expect(process.terminate).toHaveBeenCalled();
    process.exit(255);
    await expect(pending).rejects.toThrow("ssh_failed");
    expect(process.stdin.listenerCount("error")).toBe(0);
  });

  it("stops an errored upload stream without leaking its error", async () => {
    const process = fakeProcess(); const source = new PassThrough(); const spawn = vi.fn(() => process);
    const adapter = await createOpenSshAdapter({ locate: async () => "ssh", spawn });
    const pending = adapter.run(parseSshTarget("host"), { operation: "upload_file", args: [runtime], stdin: source });
    expect(source.listenerCount("error")).toBeGreaterThan(0);
    expect(() => source.emit("error", new Error("archive read failed"))).not.toThrow();
    expect(process.terminate).toHaveBeenCalled();
    process.exit(255);
    await expect(pending).rejects.toThrow("ssh_failed");
    expect(source.listenerCount("error")).toBe(0);
  });

  it("waits for child close so stdout written after exit is collected", async () => {
    const events = new EventEmitter();
    const stdout = new PassThrough(); const stderr = new PassThrough(); const stdin = new PassThrough();
    const process = { pid: 1, stdout, stderr, stdin, kill: vi.fn(), exit: (code = 0) => events.emit("exit", code, null), close: (code = 0) => events.emit("close", code, null), once: events.once.bind(events) };
    childProcess.spawn.mockReturnValueOnce(process as never);
    const adapter = await createOpenSshAdapter({ locate: async () => "ssh" });
    const pending = adapter.run(parseSshTarget("host"), { operation: "detect_platform", args: [] });
    let completed = false;
    void pending.then(() => { completed = true; });
    process.exit();
    stdout.write("Darwin\narm64\n");
    await Promise.resolve();
    expect(completed).toBe(false);
    stdout.end(); stderr.end(); process.close();
    await expect(pending).resolves.toMatchObject({ stdout: "Darwin\narm64\n", exitCode: 0 });
  });

  it("removes only the matching dead remote Console lock PID", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fleet-remote-lock-"));
    const lockFile = path.join(home, ".fleet", "console", "console.lock");
    const deadPid = "2147483647";
    try {
      await mkdir(path.dirname(lockFile), { recursive: true });
      await writeFile(lockFile, JSON.stringify({ pid: Number(deadPid), host: "remote" }, null, 2));
      await runRemoveConsoleLock(deadPid, home);
      await expect(access(lockFile)).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(lockFile, JSON.stringify({ pid: 42, host: "remote" }, null, 2));
      await runRemoveConsoleLock(deadPid, home);
      await expect(access(lockFile)).resolves.toBeUndefined();

      await writeFile(lockFile, JSON.stringify({ pid: process.pid, host: "remote" }, null, 2));
      await runRemoveConsoleLock(String(process.pid), home);
      await expect(access(lockFile)).resolves.toBeUndefined();
    } finally { await rm(home, { force: true, recursive: true }); }
  });
});

async function runRemoveConsoleLock(pid: string, home: string): Promise<void> {
  const program = await remoteProgram("remove_console_lock", [pid]);
  await execFileAsync("/bin/sh", ["-c", program], { env: { ...process.env, HOME: home } });
}

async function remoteProgram(operation: string, args: readonly string[]): Promise<string> {
  const child = fakeProcess(); const spawn = vi.fn(() => child);
  const adapter = await createOpenSshAdapter({ locate: async () => "ssh", spawn });
  const pending = adapter.run(parseSshTarget("host"), { operation, args } as never);
  child.exit(); await pending;
  return calls(spawn)[0]![1].at(-1)!;
}

function calls(spawn: ReturnType<typeof vi.fn>): readonly [string, string[]][] { return spawn.mock.calls as unknown as readonly [string, string[]][]; }
function shellQuote(value: string): string { return `'${value.replace(/'/gu, "'\\''")}'`; }
