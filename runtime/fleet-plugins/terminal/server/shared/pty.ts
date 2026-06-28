import { createRequire } from "node:module";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolvePathBinary } from "@dotobokuri/core-agent";

import type { TerminalLaunchContext, TerminalLaunchSpec, TerminalPtyHandle } from "./terminal-types.js";

export type TerminalLaunchResolver = (cwd?: string, context?: TerminalLaunchContext) => Promise<TerminalLaunchSpec>;

type NodePtyModule = {
  readonly spawn: (bin: string, args: readonly string[], options: {
    readonly cols: number;
    readonly rows: number;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly name: string;
    readonly useConptyDll?: boolean;
  }) => TerminalPtyHandle;
};

type NodeRequire = ReturnType<typeof createRequire>;

const DEFAULT_TERMINAL_CWD_FALLBACK = os.homedir;
const TERMINAL_TERM = "xterm-256color";
const FLEET_CONSOLE_PACKAGE_NAME = "@dotobokuri/fleet-console";
const require = createRequire(import.meta.url);

export function createShellTerminalLaunchResolver(deps: {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homedir?: () => string;
  readonly platform?: NodeJS.Platform;
} = {}): TerminalLaunchResolver {
  const baseCwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? DEFAULT_TERMINAL_CWD_FALLBACK;
  const platform = deps.platform ?? process.platform;
  return async (selectedCwd) => {
    const cwd = selectedCwd || baseCwd || homedir();
    const shell = resolveWindowsLaunchBinary(resolveUserShell(env, platform), [], env, platform, "user shell");
    return { bin: shell.bin, args: shell.args, cwd, env: buildShellLaunchEnv(env), terminalName: TERMINAL_TERM };
  };
}

export function startTerminalShell(launch: TerminalLaunchSpec, size: { readonly cols: number; readonly rows: number }): TerminalPtyHandle {
  const testStartShell = (globalThis as { __fleetTerminalStartShell?: (launch: TerminalLaunchSpec, size: { readonly cols: number; readonly rows: number }) => TerminalPtyHandle }).__fleetTerminalStartShell;
  if (testStartShell) return testStartShell(launch, size);
  const { spawn: spawnPty } = loadNodePty();
  const useConptyDll = resolveUseConptyDll(process.platform, process.env);
  return spawnPty(launch.bin, [...launch.args], {
    cols: size.cols,
    rows: size.rows,
    cwd: launch.cwd,
    env: launch.env,
    name: launch.terminalName ?? TERMINAL_TERM,
    ...(useConptyDll ? { useConptyDll: true } : {}),
  });
}

export function resolveNodePtyModulePath(currentFile: string = fileURLToPath(import.meta.url)): string {
  return loadNodePtyRequire(currentFile).resolve("node-pty");
}

export function resolveUseConptyDll(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== "win32") return false;
  const override = env.FLEET_USE_CONPTY_DLL?.toLowerCase();
  return override !== "0" && override !== "false";
}

function loadNodePty(): NodePtyModule {
  return loadNodePtyRequire(fileURLToPath(import.meta.url))("node-pty") as NodePtyModule;
}

function loadNodePtyRequire(currentFile: string): NodeRequire {
  const consolePackageRequire = findConsolePackageRequire(currentFile);
  return consolePackageRequire ?? require;
}

function findConsolePackageRequire(currentFile: string): NodeRequire | null {
  let dir = path.dirname(currentFile);
  while (true) {
    const packageJson = path.join(dir, "package.json");
    if (isFleetConsolePackage(packageJson)) return createRequire(packageJson);
    const nestedConsolePackage = path.join(dir, "runtime", "fleet-console", "package.json");
    if (isFleetConsolePackage(nestedConsolePackage)) return createRequire(nestedConsolePackage);
    const siblingConsolePackage = path.join(dir, "..", "..", "fleet-console", "package.json");
    if (isFleetConsolePackage(siblingConsolePackage)) return createRequire(siblingConsolePackage);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isFleetConsolePackage(packageJson: string): boolean {
  if (!existsSync(packageJson)) return false;
  try {
    const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { readonly name?: unknown };
    return manifest.name === FLEET_CONSOLE_PACKAGE_NAME;
  } catch {
    return false;
  }
}

function resolveUserShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.SHELL) return env.SHELL;
  if (platform === "win32") return env.ComSpec || "powershell.exe";
  return "/bin/bash";
}

function resolveWindowsLaunchBinary(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  label: string,
): { readonly bin: string; readonly args: readonly string[] } {
  if (platform !== "win32") {
    return { bin, args };
  }
  const resolved = resolvePathBinary(bin, env, { platform });
  if (!resolved) {
    throw new Error(`${label} "${bin}" was not found on PATH; provide an absolute path or install it before launching a terminal session.`);
  }
  return { bin: resolved.bin, args: [...resolved.prefixArgs, ...args] };
}

function buildShellLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    TERM: TERMINAL_TERM,
  };
}
