import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { readFleetConsoleRelease, type FleetConsoleRelease } from "../release.js";
import type { TerminalLaunchContext, TerminalLaunchSpec, TerminalPtyHandle } from "./types.js";

export interface TerminalLaunchResolverDeps {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly homedir?: () => string;
  readonly exists?: (path: string) => boolean;
  // dev/prod 채널과 콘솔 패키지 루트를 주입 가능(테스트·임베드용). 미주입 시 콘솔 자신의 릴리스를 읽는다.
  readonly release?: FleetConsoleRelease;
}

export type TerminalLaunchResolver = (cwd?: string, context?: TerminalLaunchContext) => TerminalLaunchSpec;

const DEFAULT_TERMINAL_CWD_FALLBACK = os.homedir;
const TERMINAL_TERM = "xterm-256color";
// 콘솔 PTY 터미널은 fleet-cli를 headless + native 모드로 띄운다:
// 별도 TUI 크롬 없이 선택한 Agent CLI가 이 터미널을 직접 점유한다.
const FLEET_HEADLESS_NATIVE_FLAGS = ["--headless", "--native"] as const;
const require = createRequire(import.meta.url);

export function createDefaultTerminalLaunchResolver(deps: TerminalLaunchResolverDeps = {}): TerminalLaunchResolver {
  const baseCwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const homedir = deps.homedir ?? DEFAULT_TERMINAL_CWD_FALLBACK;
  const exists = deps.exists ?? fs.existsSync;
  // 채널은 프로세스 수명 동안 불변이므로 resolver 생성 시 1회만 평가한다.
  const release = deps.release ?? readFleetConsoleRelease();

  return (selectedCwd, context) => {
    const cwd = selectedCwd || baseCwd || homedir();
    if (context?.kind === "shell") {
      return { bin: resolveUserShell(env), args: [], cwd, env: buildShellLaunchEnv(env) };
    }
    const launchEnv = buildLaunchEnv(env, cwd, context?.sessionId);
    const override = parseTerminalCommand(env.FLEET_TERMINAL_CMD);
    if (override) {
      return { ...override, cwd, env: launchEnv };
    }
    // dev/prod 판별은 cwd(=선택한 Theater)가 아니라 콘솔 자신의 릴리스 채널로 한다.
    // local: 모노레포 형제 디렉터리의 빌드된 fleet-cli를 node로 실행한다(Theater 위치와 무관).
    // stable: 글로벌 설치된 `fleet` 바이너리를 PATH에서 실행한다.
    if (release.channel === "local") {
      const localCli = resolveSiblingFleetCliEntry(release.packageRoot, exists);
      if (!localCli) {
        // local 빌드에서 형제 fleet-cli 산출물이 없으면 글로벌 `fleet`로 조용히 폴백하지 않고 명확히 실패한다
        // (잘못된 바이너리를 띄우는 대신 빌드 누락을 즉시 드러낸다). server.ts가 이 throw를 503으로 표면화한다.
        throw new Error(
          `Fleet Console is running from a local build (channel=local) but the sibling fleet-cli build was not found at ${expectedSiblingFleetCliEntry(release.packageRoot)}. Run \`pnpm build\` in runtime/fleet-cli before launching a terminal session.`,
        );
      }
      return { bin: execPath, args: [localCli, ...FLEET_HEADLESS_NATIVE_FLAGS], cwd, env: launchEnv };
    }
    return { bin: "fleet", args: [...FLEET_HEADLESS_NATIVE_FLAGS], cwd, env: launchEnv };
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

function resolveUserShell(env: NodeJS.ProcessEnv): string {
  if (env.SHELL) return env.SHELL;
  if (process.platform === "win32") return env.ComSpec || "powershell.exe";
  return "/bin/bash";
}

function resolveSiblingFleetCliEntry(consolePackageRoot: string, exists: (path: string) => boolean = fs.existsSync): string | null {
  const candidate = expectedSiblingFleetCliEntry(consolePackageRoot);
  return exists(candidate) ? candidate : null;
}

function expectedSiblingFleetCliEntry(consolePackageRoot: string): string {
  // 모노레포 레이아웃: runtime/fleet-console 과 runtime/fleet-cli 는 형제 디렉터리다.
  return path.join(consolePackageRoot, "..", "fleet-cli", "dist", "index.js");
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

function buildShellLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    TERM: TERMINAL_TERM,
  };
}
