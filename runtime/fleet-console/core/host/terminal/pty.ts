import { chmodSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolvePathBinary } from "@dotobokuri/core-process";

import { resolveConsolePackageRequire } from "./console-require.js";
import { stripConsoleInternalEnv, TERMINAL_TERM, withTerminalCapabilities } from "./launch-env.js";
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
  return async (selectedCwd, context) => {
    const cwd = selectedCwd || baseCwd || homedir();
    const shell = resolveWindowsLaunchBinary(resolveUserShell(env, platform), [], env, platform, "user shell");
    return { bin: shell.bin, args: shell.args, cwd, env: buildShellLaunchEnv(env, context?.colorScheme), terminalName: TERMINAL_TERM };
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
  const nodePtyRequire = loadNodePtyRequire(fileURLToPath(import.meta.url));
  ensureNodePtySpawnHelpersExecutable(path.dirname(nodePtyRequire.resolve("node-pty/package.json")));
  return nodePtyRequire("node-pty") as NodePtyModule;
}

function loadNodePtyRequire(currentFile: string): NodeRequire {
  return resolveConsolePackageRequire(currentFile, require);
}

export function ensureNodePtySpawnHelpersExecutable(
  packageRoot: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): void {
  if (platform !== "darwin") return;
  for (const directory of ["build/Release", "build/Debug", `prebuilds/darwin-${architecture}`]) {
    const helper = path.join(packageRoot, directory, "spawn-helper");
    try {
      const stat = lstatSync(helper);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0o111) continue;
      chmodSync(helper, stat.mode | 0o111);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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

function buildShellLaunchEnv(env: NodeJS.ProcessEnv, colorScheme?: "light" | "dark"): NodeJS.ProcessEnv {
  return withTerminalCapabilities({
    ...stripConsoleInternalEnv(env),
    // COLORFGBG는 배경을 질의하지 않는 CLI/TUI를 위한 고전적 극성 힌트다("fg;bg" ANSI 인덱스).
    // 값이 없으면 변수 자체를 싣지 않아 사용자 셸 환경의 기존 값을 훼손하지 않는다.
    ...(colorScheme ? { COLORFGBG: colorScheme === "light" ? "0;15" : "15;0" } : {}),
  });
}
