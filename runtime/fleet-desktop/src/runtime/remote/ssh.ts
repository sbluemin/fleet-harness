import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

import { RemoteRuntimeError, type RemoteCancellation, type RemoteCommand, type RemoteCommandResult, type RemoteOperation, type RemoteProcessHandle } from "./contracts.js";
import type { ValidatedSshTarget } from "./target.js";

const CONNECT_TIMEOUT_SECONDS = 10;
const MAX_OUTPUT_BYTES = 64 * 1024;
const FLEET_RELATIVE_PATH = /^\.fleet\/[A-Za-z0-9._/-]+$/u;
const RUNTIME_RELATIVE_PREFIX = ".fleet/desktop/runtime/";
const POSITIVE_INTEGER = /^[1-9]\d*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const CONSOLE_SPEC = "@dotobokuri/fleet-console@latest";

export interface OpenSshProcess extends RemoteProcessHandle {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly stdin: NodeJS.WritableStream;
}

export interface OpenSshSpawner {
  (file: string, args: readonly string[], options: SpawnOptionsWithoutStdio): OpenSshProcess;
}

export interface OpenSshAdapterOptions {
  readonly platform?: NodeJS.Platform;
  readonly locate?: (file: string) => Promise<string | null>;
  readonly spawn?: OpenSshSpawner;
  /** Composition-only fixed argv, e.g. ["-F", "/test/ssh_config"]. Never derive this from user input. */
  readonly extraBaseArgv?: readonly string[];
  readonly outputLimitBytes?: number;
}

export interface OpenSshAdapter {
  readonly executable: string;
  run(target: ValidatedSshTarget, command: RemoteCommand, cancellation?: RemoteCancellation): Promise<RemoteCommandResult>;
  /** OpenSSH relays remote exits; kill -0/test -e exit 1 is false, while 255 is transport failure. */
  probe(target: ValidatedSshTarget, command: RemoteCommand, cancellation?: RemoteCancellation): Promise<{ readonly ok: boolean; readonly exitCode: number }>;
  open(target: ValidatedSshTarget, arguments_: readonly string[], cancellation?: RemoteCancellation): Promise<OpenSshProcess>;
}

/** Fixed shell source: callers choose an operation and validated argv, never a program string. */
const SCRIPTS: Readonly<Record<RemoteOperation, string>> = {
  detect_platform: "set -eu; uname -s; uname -m",
  read_lock: "set -eu; cat \"$HOME/.fleet/console/console.lock\"",
  check_process: "set -eu; kill -0 \"$1\"",
  stop_console: "set -eu; kill \"$1\"",
  prepare_staging: "set -eu; umask 077; mkdir -p \"$HOME/$1\"",
  upload_file: "set -eu; umask 077; cat > \"$HOME/$1\"",
  extract_archive: "set -eu; case \"$1\" in *.tar.xz) tar -xJf \"$HOME/$1\" -C \"$HOME/$2\" --strip-components=1 ;; *.tar.gz) tar -xzf \"$HOME/$1\" -C \"$HOME/$2\" --strip-components=1 ;; *) exit 64 ;; esac",
  probe_path: "set -eu; test -e \"$HOME/$1\"",
  read_runtime_file: "set -eu; cat \"$HOME/$1\"",
  remove_runtime_path: "set -eu; rm -rf \"$HOME/$1\"",
  promote_runtime_path: "set -eu; rm -rf \"$HOME/$2.old\"; if [ -e \"$HOME/$2\" ]; then mv \"$HOME/$2\" \"$HOME/$2.old\"; fi; mv \"$HOME/$1\" \"$HOME/$2\"; rm -rf \"$HOME/$2.old\"",
  chmod_exec: "set -eu; chmod 0755 \"$HOME/$1\"",
  normalize_console_prefix: "set -eu; root=\"$HOME/$1\"; held=\"$root.package\"; rm -rf \"$held\"; mv \"$root/node_modules/@dotobokuri/fleet-console\" \"$held\"; for entry in \"$held\"/* \"$held\"/.[!.]* \"$held\"/..?*; do [ -e \"$entry\" ] || continue; mv \"$entry\" \"$root/\"; done; rm -rf \"$held\"",
  // node-pty's npm lifecycle runs `sh -c "node …"`, and npm does not add the running node's dir to
  // the child PATH, so prepend the bundled node bin (mirrors the local installer). Isolate the user's
  // account config with two distinct empty npmrc files (npm refuses to load one path as both user and
  // global) and pin the registry so a remote ~/.npmrc cannot redirect or break the install.
  install_console: "set -eu; nodebin=$(dirname \"$HOME/$1\"); prefix=\"$HOME/$3\"; mkdir -p \"$prefix\"; : > \"$prefix/.npmrc\"; : > \"$prefix/.npmrc-global\"; PATH=\"$nodebin:$PATH\" npm_config_userconfig=\"$prefix/.npmrc\" npm_config_globalconfig=\"$prefix/.npmrc-global\" npm_config_registry=https://registry.npmjs.org/ \"$HOME/$1\" \"$HOME/$2\" install --prefix \"$prefix\" --no-audit --no-fund --loglevel=error \"$4\"; rm -f \"$prefix/.npmrc\" \"$prefix/.npmrc-global\"",
  // The Console verifies the full desktop-protocol env before it will serve: owner id/kind/version,
  // the canonical FLEET_CONSOLE_DIR, and FLEET_CONSOLE_RESOURCE_ROOT pointing at the service root
  // (mirrors local environment.ts). The service root doubles as the resource root the marker lives in.
  start_console: "set -eu; cd \"$HOME/$1\"; FLEET_CONSOLE_OWNER_KIND=desktop FLEET_CONSOLE_OWNER_ID=\"$4\" FLEET_CONSOLE_PROTOCOL_VERSION=\"$5\" FLEET_CONSOLE_DESKTOP_VERSION=\"$6\" FLEET_CONSOLE_DIR=\"$HOME/$7\" FLEET_CONSOLE_RESOURCE_ROOT=\"$HOME/$1\" nohup \"$HOME/$2\" \"$HOME/$3\" serve >/dev/null 2>&1 & printf %s \"$!\"",
};

export async function createOpenSshAdapter(options: OpenSshAdapterOptions = {}): Promise<OpenSshAdapter> {
  const executableName = (options.platform ?? process.platform) === "win32" ? "ssh.exe" : "ssh";
  const executable = await (options.locate ?? locateOnPath)(executableName);
  if (!executable) throw new RemoteRuntimeError("ssh_unavailable");
  const extraBaseArgv = options.extraBaseArgv ?? [];
  if (extraBaseArgv.some((argument) => argument.length === 0 || /[\u0000-\u001f\u007f]/u.test(argument))) throw new RemoteRuntimeError("remote_command_invalid");
  const spawnFor = options.spawn ?? defaultSpawn;
  const outputLimit = options.outputLimitBytes ?? MAX_OUTPUT_BYTES;
  const base = ["-T", ...extraBaseArgv, "-o", "BatchMode=yes", "-o", `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`] as const;

  const open = async (target: ValidatedSshTarget, arguments_: readonly string[], cancellation?: RemoteCancellation): Promise<OpenSshProcess> => {
    throwIfAborted(cancellation);
    const child = spawnFor(executable, [...base, ...arguments_, "--", target.value], { stdio: "pipe", windowsHide: true });
    bindCancellation(child, cancellation);
    return child;
  };

  return {
    executable,
    open,
    async run(target, command, cancellation) {
      if (isPredicate(command.operation)) throw invalidCommand();
      validateCommand(command);
      const child = startCommand(executable, base, spawnFor, target, command, cancellation);
      return collect(child, outputLimit, cancellation);
    },
    async probe(target, command, cancellation) {
      if (!isPredicate(command.operation)) throw invalidCommand();
      validateCommand(command);
      return collectProbe(startCommand(executable, base, spawnFor, target, command, cancellation), outputLimit, cancellation);
    },
  };
}

function startCommand(executable: string, base: readonly string[], spawnFor: OpenSshSpawner, target: ValidatedSshTarget, command: RemoteCommand, cancellation?: RemoteCancellation): OpenSshProcess {
  const script = SCRIPTS[command.operation];
  if (!script) throw invalidCommand();
  throwIfAborted(cancellation);
  // OpenSSH joins every post-target argv with spaces and hands the result to the remote login
  // shell, which re-parses it. Splitting `sh -c <script> arg…` into separate local argv items is
  // therefore lost across the wire, so build one already-quoted remote program string instead.
  // Target stays the sole user-derived argv item, directly after OpenSSH's -- boundary.
  const remoteProgram = buildRemoteProgram(script, command.args);
  const child = spawnFor(executable, [...base, "--", target.value, remoteProgram], { stdio: "pipe", windowsHide: true });
  bindCancellation(child, cancellation);
  writeStdin(child, command);
  return child;
}

/** POSIX single-quote: wrap in '…' and escape embedded quotes as '\'' so the remote shell sees a literal. */
function shSingleQuote(value: string): string { return `'${value.replace(/'/gu, "'\\''")}'`; }

/** Compose the remote program the login shell will re-parse: sh -c '<script>' fleet-remote '<arg>'… */
function buildRemoteProgram(script: string, args: readonly string[]): string {
  return ["sh", "-c", shSingleQuote(script), "fleet-remote", ...args.map(shSingleQuote)].join(" ");
}

function validateCommand(command: RemoteCommand): void {
  const { operation, args, stdin } = command;
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) throw invalidCommand();
  const requireArgs = (...validators: readonly ((value: string) => boolean)[]) => {
    if (args.length !== validators.length || !validators.every((validator, index) => validator(args[index]!))) throw invalidCommand();
  };
  if (operation === "upload_file") {
    requireArgs(runtimePath);
    if (!stdin) throw invalidCommand();
    return;
  }
  if (stdin !== undefined) throw invalidCommand();
  switch (operation) {
    case "detect_platform": case "read_lock": requireArgs(); return;
    case "check_process": case "stop_console": requireArgs(positiveInteger); return;
    case "prepare_staging": case "remove_runtime_path": case "chmod_exec": case "normalize_console_prefix": requireArgs(runtimePath); return;
    case "extract_archive": requireArgs(runtimePath, runtimePath); return;
    case "probe_path": case "read_runtime_file": requireArgs(fleetPath); return;
    case "promote_runtime_path": requireArgs(runtimePath, runtimePath); return;
    case "install_console": requireArgs(runtimePath, runtimePath, runtimePath, (value) => value === CONSOLE_SPEC); return;
    case "start_console": requireArgs(runtimePath, runtimePath, runtimePath, uuid, positiveInteger, version, fleetPath); return;
  }
}

function isPredicate(operation: RemoteOperation): operation is "check_process" | "probe_path" { return operation === "check_process" || operation === "probe_path"; }

function fleetPath(value: string): boolean {
  if (!FLEET_RELATIVE_PATH.test(value) || value.startsWith("/") || value.startsWith("~")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith("-"));
}
function runtimePath(value: string): boolean { return value.startsWith(RUNTIME_RELATIVE_PREFIX) && fleetPath(value); }
function positiveInteger(value: string): boolean { return POSITIVE_INTEGER.test(value) && Number.isSafeInteger(Number(value)); }
function uuid(value: string): boolean { return UUID.test(value); }
function version(value: string): boolean { return VERSION.test(value); }
function invalidCommand(): never { throw new RemoteRuntimeError("remote_command_invalid"); }

function writeStdin(child: OpenSshProcess, command: RemoteCommand): void {
  if (!command.stdin) { child.stdin.end(); return; }
  if (command.stdin instanceof Uint8Array) { child.stdin.end(command.stdin); return; }
  command.stdin.pipe(child.stdin);
}

function bindCancellation(child: OpenSshProcess, cancellation?: RemoteCancellation): void {
  const abort = () => child.terminate();
  cancellation?.signal.addEventListener("abort", abort, { once: true });
  void child.exited.finally(() => cancellation?.signal.removeEventListener("abort", abort));
}

async function collect(child: OpenSshProcess, limit: number, cancellation?: RemoteCancellation): Promise<RemoteCommandResult> {
  let stdout = ""; let stderr = ""; let total = 0;
  const add = (which: "stdout" | "stderr", value: unknown) => {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    total += Buffer.byteLength(text);
    if (total > limit) child.terminate();
    if (which === "stdout") stdout += text; else stderr += text;
  };
  child.stdout.on("data", (value) => add("stdout", value));
  child.stderr.on("data", (value) => add("stderr", value));
  const outcome = await child.exited;
  if (cancellation?.signal.aborted) throw new RemoteRuntimeError("ssh_cancelled");
  if (total > limit) throw new RemoteRuntimeError("remote_command_output_too_large");
  if (outcome.code !== 0) throw new RemoteRuntimeError("ssh_failed");
  return { stdout, stderr, exitCode: outcome.code };
}

async function collectProbe(child: OpenSshProcess, limit: number, cancellation?: RemoteCancellation): Promise<{ readonly ok: boolean; readonly exitCode: number }> {
  let total = 0;
  const count = (value: unknown) => {
    total += Buffer.byteLength(Buffer.isBuffer(value) ? value : String(value));
    if (total > limit) child.terminate();
  };
  child.stdout.on("data", count);
  child.stderr.on("data", count);
  const outcome = await child.exited;
  if (cancellation?.signal.aborted) throw new RemoteRuntimeError("ssh_cancelled");
  if (total > limit) throw new RemoteRuntimeError("remote_command_output_too_large");
  if (outcome.signal !== null || outcome.code === null || outcome.code === 255) throw new RemoteRuntimeError("ssh_failed");
  if (outcome.code === 0) return { ok: true, exitCode: 0 };
  return { ok: false, exitCode: outcome.code };
}

function throwIfAborted(cancellation?: RemoteCancellation): void { if (cancellation?.signal.aborted) throw new RemoteRuntimeError("ssh_cancelled"); }

async function locateOnPath(file: string): Promise<string | null> {
  const path = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const { access, constants } = await import("node:fs/promises");
  const { join } = await import("node:path");
  for (const directory of path.split(separator)) {
    if (!directory) continue;
    const candidate = join(directory, file);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* search next path */ }
  }
  return null;
}

function defaultSpawn(file: string, args: readonly string[], options: SpawnOptionsWithoutStdio): OpenSshProcess {
  const child = spawn(file, args, options) as ChildProcessWithoutNullStreams;
  return { pid: child.pid, stdout: child.stdout, stderr: child.stderr, stdin: child.stdin, terminate: () => { child.kill(); }, exited: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))) };
}
