import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolvePathBinary, type AuthEnvResolver } from "@dotobokuri/core-agent";
import {
  createSystemPromptBuilder,
  injectAgentCliProfile,
  resolveAgentCliProfile,
  type AgentCliId,
  type AgentCliProfile,
  type FleetAgentRuntimeLifecycle,
} from "@dotobokuri/fleet-admiral";
import { createInfraServices, getFleetDataDir, type InfraServices } from "@dotobokuri/fleet-infra";
import { resolveAuthEnv } from "@dotobokuri/fleet-infra/auth";

import type { TerminalLaunchContext, TerminalLaunchSpec, TerminalPtyHandle } from "./types.js";
import { buildConsoleCaptureHookCommand, buildConsoleHookCommand, buildConsoleTurnHookCommand, runCodexCommand, withConsoleMarketplaceLock, type ConsoleHookCommandEntry } from "./host-hooks.js";

export interface TerminalLaunchResolverDeps {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly homedir?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly entryPath?: string;
  readonly tsxLoaderPath?: string;
  readonly dataDir?: string;
  readonly infraServices?: InfraServices;
  readonly agentRuntime?: FleetAgentRuntimeLifecycle;
  readonly injectProfile?: typeof injectAgentCliProfile;
  readonly onRuntimeSessionStart?: (session: ConsoleRuntimeSessionInfo) => void;
  readonly resolveProfile?: typeof resolveAgentCliProfile;
}

export interface ConsoleRuntimeSessionInfo {
  readonly cliId: AgentCliId;
  readonly cliLabel: string;
  readonly label: string;
  readonly mcpToolCount: number;
  readonly sessionId: string;
}

export type TerminalLaunchResolver = (cwd?: string, context?: TerminalLaunchContext) => Promise<TerminalLaunchSpec>;

const DEFAULT_TERMINAL_CWD_FALLBACK = os.homedir;
const TERMINAL_TERM = "xterm-256color";
const CONSOLE_ENTRY_PATH = fileURLToPath(import.meta.url);
const HOOK_ENTRY_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".tsx"]);
const require = createRequire(import.meta.url);

export function createDefaultTerminalLaunchResolver(deps: TerminalLaunchResolverDeps = {}): TerminalLaunchResolver {
  const baseCwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const homedir = deps.homedir ?? DEFAULT_TERMINAL_CWD_FALLBACK;
  const platform = deps.platform ?? process.platform;
  const entryPath = resolveHookEntryPath(deps.entryPath ?? process.argv[1]);
  const tsxLoaderPath = deps.tsxLoaderPath ?? resolveOptionalPackage("tsx");
  const dataDir = deps.dataDir ?? getFleetDataDir();
  const infraServices = deps.infraServices ?? createInfraServices();
  const agentRuntime = deps.agentRuntime;
  const injectProfile = deps.injectProfile ?? injectAgentCliProfile;
  const resolveProfile = deps.resolveProfile ?? resolveAgentCliProfile;
  const authEnvResolver: AuthEnvResolver = (cli) => resolveAuthEnv(cli as Parameters<typeof resolveAuthEnv>[0], { authService: infraServices.authService });
  const hookEntry: ConsoleHookCommandEntry = { entryPath, execPath, ...(tsxLoaderPath ? { tsxLoaderPath } : {}) };

  return async (selectedCwd, context) => {
    const cwd = selectedCwd || baseCwd || homedir();
    if (context?.kind === "shell") {
      const shell = resolveWindowsLaunchBinary(resolveUserShell(env, platform), [], env, platform, "user shell");
      return { bin: shell.bin, args: shell.args, cwd, env: buildShellLaunchEnv(env), terminalName: TERMINAL_TERM };
    }
    const launchEnv = buildLaunchEnv(env, cwd, context?.sessionId);
    const override = parseTerminalCommand(env.FLEET_TERMINAL_CMD);
    if (override) {
      const resolvedOverride = resolveWindowsLaunchBinary(
        override.bin,
        override.args,
        env,
        platform,
        "FLEET_TERMINAL_CMD",
      );
      return { ...resolvedOverride, cwd, env: launchEnv, terminalName: TERMINAL_TERM };
    }
    const sessionId = context?.sessionId ?? "default";
    return createAgentCliLaunchSpec({
      authEnvResolver,
      agentRuntime,
      cwd,
      dataDir,
      env: launchEnv,
      hookEntry,
      infraServices,
      injectProfile,
      onRuntimeSessionStart: deps.onRuntimeSessionStart,
      resolveProfile,
      cliId: context?.cliId,
      resumeSessionId: context?.resumeSessionId,
      sessionId,
    });
  };
}

function resolveHookEntryPath(candidate: string | undefined): string {
  if (candidate && hasHookEntryExtension(candidate)) return candidate;
  if (candidate) {
    try {
      const realPath = fs.realpathSync(candidate);
      if (hasHookEntryExtension(realPath)) return realPath;
    } catch {
      // 실행 엔트리 symlink 해석 실패 시 번들 엔트리로 폴백한다.
    }
  }
  return CONSOLE_ENTRY_PATH;
}

function hasHookEntryExtension(entryPath: string): boolean {
  return HOOK_ENTRY_EXTENSIONS.has(path.extname(entryPath));
}

export function startTerminalShell(launch: TerminalLaunchSpec, size: { readonly cols: number; readonly rows: number }): TerminalPtyHandle {
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

async function createAgentCliLaunchSpec(options: {
  readonly authEnvResolver: AuthEnvResolver;
  readonly agentRuntime?: FleetAgentRuntimeLifecycle;
  readonly cliId?: string;
  readonly cwd: string;
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly hookEntry: ConsoleHookCommandEntry;
  readonly infraServices: InfraServices;
  readonly injectProfile: typeof injectAgentCliProfile;
  readonly onRuntimeSessionStart?: (session: ConsoleRuntimeSessionInfo) => void;
  readonly resolveProfile: typeof resolveAgentCliProfile;
  readonly resumeSessionId?: string;
  readonly sessionId: string;
}): Promise<TerminalLaunchSpec> {
  const cleanupStack: Array<() => void | Promise<void>> = [];
  try {
    const agentRuntime = options.agentRuntime;
    if (!agentRuntime) {
      throw new Error("Fleet Console agent runtime is unavailable.");
    }
    const profile = await options.resolveProfile(options.env, options.cwd, {
      authEnvResolver: options.authEnvResolver,
      authService: options.infraServices.authService,
      cliId: options.cliId,
      resumeSessionId: options.resumeSessionId,
    });
    const injectedProfile = await options.injectProfile(profile, {
      buildSystemPrompt: (injectTone) => createSystemPromptBuilder({ carrierRuntime: agentRuntime.carrierRuntime }).build(injectTone),
      carrierRuntime: agentRuntime.carrierRuntime,
      codexCommandRunner: runCodexCommand,
      dataDir: options.dataDir,
      dedicatedMcpSession: agentRuntime.dedicatedMcpSession,
      enableMetaphor: false,
      captureSessionHookExec: buildConsoleCaptureHookCommand(options.hookEntry, profile.id),
      turnStartHookExec: buildConsoleTurnHookCommand(options.hookEntry, "start"),
      turnEndHookExec: buildConsoleTurnHookCommand(options.hookEntry, "end"),
      hookExec: buildConsoleHookCommand(options.hookEntry),
      onCleanup: (cleanup) => cleanupStack.push(cleanup),
      replaceSystemPrompt: false,
      resumeSessionId: options.resumeSessionId,
      withMarketplaceLock: withConsoleMarketplaceLock,
      mcpSessionLabel: options.sessionId,
    } as Parameters<typeof injectAgentCliProfile>[1] & { readonly mcpSessionLabel: string });
    options.onRuntimeSessionStart?.({
      cliId: injectedProfile.id,
      cliLabel: injectedProfile.label,
      label: injectedProfile.label,
      mcpToolCount: countMcpTools(agentRuntime),
      sessionId: options.sessionId,
    });
    return toLaunchSpec(injectedProfile, createOnceCleanup(async () => {
      for (const cleanup of [...cleanupStack].reverse()) {
        await cleanup();
      }
    }));
  } catch (error) {
    for (const cleanup of [...cleanupStack].reverse()) {
      try {
        await cleanup();
      } catch {
        // 실패 launch의 cleanup 에러는 원래 실패 원인을 덮지 않는다.
      }
    }
    throw error;
  }
}

function toLaunchSpec(profile: AgentCliProfile, cleanup: () => Promise<void>): TerminalLaunchSpec {
  return {
    args: [...profile.args],
    bin: profile.bin,
    cleanup,
    cwd: profile.cwd,
    env: { ...profile.env },
    messagePolicy: profile.messagePolicy,
    renameCommand: profile.renameCommand,
    terminalName: profile.terminalName,
  };
}

function countMcpTools(agentRuntime: FleetAgentRuntimeLifecycle): number {
  return agentRuntime.mcpRegistry.getAllAgentTools().length;
}

function createOnceCleanup(cleanup: () => void | Promise<void>): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await cleanup();
  };
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

function resolveOptionalPackage(id: string): string | undefined {
  try {
    return require.resolve(id);
  } catch {
    return undefined;
  }
}
