import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import type { TerminalLaunchContext, TerminalLaunchSpec, TerminalPtyHandle } from "./types.js";

export interface TerminalLaunchResolverDeps {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly homedir?: () => string;
  readonly exists?: (path: string) => boolean;
}

export type TerminalLaunchResolver = (cwd?: string, context?: TerminalLaunchContext) => TerminalLaunchSpec;

const DEFAULT_TERMINAL_CWD_FALLBACK = os.homedir;
const TERMINAL_TERM = "xterm-256color";
// 콘솔 PTY 터미널은 fleet-cli를 터미널 전용(--native) 모드로 띄운다:
// 2-pane Fleet TUI 대신 선택한 Agent CLI가 이 터미널을 직접 점유한다.
const FLEET_NATIVE_TERMINAL_FLAG = "--native";
const require = createRequire(import.meta.url);

export function createDefaultTerminalLaunchResolver(deps: TerminalLaunchResolverDeps = {}): TerminalLaunchResolver {
  const baseCwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const homedir = deps.homedir ?? DEFAULT_TERMINAL_CWD_FALLBACK;
  const exists = deps.exists ?? fs.existsSync;

  return (selectedCwd, context) => {
    const cwd = selectedCwd || baseCwd || homedir();
    const launchEnv = buildLaunchEnv(env, cwd, context?.sessionId);
    const override = parseTerminalCommand(env.FLEET_TERMINAL_CMD);
    if (override) {
      return { ...override, cwd, env: launchEnv };
    }
    const localCli = findLocalFleetCliEntry(cwd, exists);
    if (localCli) {
      return { bin: execPath, args: [localCli, FLEET_NATIVE_TERMINAL_FLAG], cwd, env: launchEnv };
    }
    return { bin: "fleet", args: [FLEET_NATIVE_TERMINAL_FLAG], cwd, env: launchEnv };
  };
}

export function startTerminalShell(launch: TerminalLaunchSpec, size: { readonly cols: number; readonly rows: number }): TerminalPtyHandle {
  const { spawn: spawnPty } = require("node-pty") as {
    readonly spawn: (bin: string, args: readonly string[], options: {
      readonly cols: number;
      readonly rows: number;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly name: string;
    }) => TerminalPtyHandle;
  };
  return spawnPty(launch.bin, [...launch.args], {
    cols: size.cols,
    rows: size.rows,
    cwd: launch.cwd,
    env: launch.env,
    name: TERMINAL_TERM,
  });
}

export function findLocalFleetCliEntry(cwd: string, exists: (path: string) => boolean = fs.existsSync): string | null {
  let currentDir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(currentDir, "runtime", "fleet-cli", "dist", "index.js");
    if (exists(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function parseTerminalCommand(command: string | undefined): { readonly bin: string; readonly args: readonly string[] } | null {
  const parts = command?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return null;
  const [bin, ...args] = parts;
  if (!bin) return null;
  return { bin, args };
}

function buildLaunchEnv(env: NodeJS.ProcessEnv, cwd: string, sessionId: string | undefined): NodeJS.ProcessEnv {
  return {
    ...env,
    ...(sessionId ? { FLEET_CONSOLE_SESSION_ID: sessionId, INIT_CWD: cwd, PWD: cwd } : {}),
    TERM: TERMINAL_TERM,
  };
}
