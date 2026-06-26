import { createRequire } from "node:module";
import os from "node:os";
import process from "node:process";

import { resolvePathBinary } from "@dotobokuri/core-agent";

import type { TerminalLaunchContext, TerminalLaunchSpec, TerminalPtyHandle } from "./terminal-types.js";

export type TerminalLaunchResolver = (cwd?: string, context?: TerminalLaunchContext) => Promise<TerminalLaunchSpec>;

const DEFAULT_TERMINAL_CWD_FALLBACK = os.homedir;
const TERMINAL_TERM = "xterm-256color";
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
  const { spawn: spawnPty } = require("node-pty") as {
    readonly spawn: (bin: string, args: readonly string[], options: {
      readonly cols: number;
      readonly rows: number;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly name: string;
      readonly useConptyDll?: boolean;
    }) => TerminalPtyHandle;
  };
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

export function resolveUseConptyDll(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== "win32") return false;
  const override = env.FLEET_USE_CONPTY_DLL?.toLowerCase();
  return override !== "0" && override !== "false";
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
