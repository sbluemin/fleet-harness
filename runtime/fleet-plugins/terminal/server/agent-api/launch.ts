import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolvePathBinary } from "@dotobokuri/core-agent";
import { resolveAiGatewaySelection } from "@dotobokuri/core-ai-gateway";
import type { AiGatewayStoredSettings } from "@dotobokuri/core-ai-gateway";
import { createSessionIdentityResolver } from "@dotobokuri/core-unified-agent";
import {
  createSessionCaptureHookExec,
  createSystemPromptBuilder,
  injectAgentCliProfile,
  prepareAiGatewayLaunchProfile,
  resolveAgentCliProfile,
  type AgentCliId,
  type AgentCliProfile,
  type FleetGatewayAgentRuntimeLifecycle,
} from "@dotobokuri/fleet-admiral";
import {
  createInfraServices,
  getFleetDataDir,
  type GlobalOptionsService,
} from "@dotobokuri/core-infra";

import { buildConsoleAttentionHookCommand, buildConsoleAutoNameHookCommand, buildConsoleBackgroundHookCommand, buildConsoleCaptureHookCommand, buildConsoleTurnHookCommand, toCaptureProvider, withConsoleMarketplaceLock, type ConsoleHookCommandEntry } from "./host-hooks.js";
import type { TerminalLaunchContext, TerminalLaunchSpec } from "../shared/terminal-types.js";
import { stripConsoleInternalEnv } from "../shared/launch-env.js";
import { applyAgentCliPathEnvOverlay } from "./agent-cli-paths.js";

/** AI gateway를 Console의 실제 listening origin에 연결하는 launch 바인딩. */
export interface AiGatewayLaunchBinding {
  /** Console 루트 기준 라우트 경로. 예: "/plugins/terminal/ai-gateway" */
  readonly routePath: string;
  /** Console이 리슨 중인 origin. MCP는 별도 포트라 여기서 유도하면 안 된다. */
  origin(): string | null;
}

export interface TerminalLaunchResolverDeps {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly homedir?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly entryPath?: string;
  readonly tsxLoaderPath?: string;
  readonly dataDir?: string;
  readonly infraServices?: { readonly globalOptionsService: GlobalOptionsService };
  readonly agentRuntime?: FleetGatewayAgentRuntimeLifecycle;
  readonly aiGateway?: AiGatewayLaunchBinding;
  readonly injectProfile?: typeof injectAgentCliProfile;
  readonly onRuntimeSessionStart?: (session: ConsoleRuntimeSessionInfo) => void;
  readonly resolveProfile?: typeof resolveAgentCliProfile;
  readonly createSessionIdentityResolver?: typeof createSessionIdentityResolver;
  readonly readAgentCliPaths?: () => Promise<Readonly<Record<string, string>>>;
  readonly readAiGatewaySettings?: () => AiGatewayStoredSettings;
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

export function createAgentTerminalLaunchResolver(deps: TerminalLaunchResolverDeps = {}): TerminalLaunchResolver {
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
  const resolveSessionIdentityResolver = deps.createSessionIdentityResolver ?? createSessionIdentityResolver;
  const hookEntry: ConsoleHookCommandEntry = { entryPath, execPath, ...(tsxLoaderPath ? { tsxLoaderPath } : {}) };

  return async (selectedCwd, context) => {
    const cwd = selectedCwd || baseCwd || homedir();
    const testLaunch = (globalThis as { __fleetTerminalLaunch?: TerminalLaunchResolver }).__fleetTerminalLaunch;
    if (testLaunch) return testLaunch(cwd, context);
    let launchEnv = buildLaunchEnv(env, cwd, context?.sessionId, context?.colorScheme);
    if (deps.readAgentCliPaths) {
      launchEnv = applyAgentCliPathEnvOverlay(launchEnv, context?.cliId, await deps.readAgentCliPaths());
    }
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
      agentRuntime,
      ...(deps.aiGateway ? { aiGateway: deps.aiGateway } : {}),
      ...(deps.readAiGatewaySettings ? { readAiGatewaySettings: deps.readAiGatewaySettings } : {}),
      cwd,
      dataDir,
      env: launchEnv,
      hookEntry,
      infraServices,
      createSessionCaptureHookExec,
      createSystemPromptBuilder,
      injectProfile,
      onRuntimeSessionStart: deps.onRuntimeSessionStart,
      resolveProfile,
      cliId: context?.cliId,
      createSessionIdentityResolver: resolveSessionIdentityResolver,
      resumeSessionId: context?.resumeSessionId,
      sessionId,
    });
  };
}

export const createDefaultTerminalLaunchResolver = createAgentTerminalLaunchResolver;

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

async function createAgentCliLaunchSpec(options: {
  readonly agentRuntime?: FleetGatewayAgentRuntimeLifecycle;
  readonly aiGateway?: AiGatewayLaunchBinding;
  readonly readAiGatewaySettings?: () => AiGatewayStoredSettings;
  readonly cliId?: string;
  readonly createSessionCaptureHookExec: typeof createSessionCaptureHookExec;
  readonly createSessionIdentityResolver: typeof createSessionIdentityResolver;
  readonly createSystemPromptBuilder: typeof createSystemPromptBuilder;
  readonly cwd: string;
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly hookEntry: ConsoleHookCommandEntry;
  readonly infraServices: { readonly globalOptionsService: GlobalOptionsService };
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
      cliId: options.cliId,
      resumeSessionId: options.resumeSessionId,
    });
    // gateway Agent 주입과 ANTHROPIC_MODEL/cache는 같은 selection을 공유한다.
    // inject보다 먼저 읽어 `--agents`에 노출 모델×effort를 스폰 인자로만 실는다.
    const gatewaySelection = profile.id === "claude-gateway" && options.readAiGatewaySettings
      ? resolveAiGatewaySelection(options.readAiGatewaySettings())
      : undefined;
    const injectedProfile = await options.injectProfile(profile, {
      buildSystemPrompt: () => options.createSystemPromptBuilder().build(),
      dataDir: options.dataDir,
      dedicatedMcpSession: agentRuntime.dedicatedMcpSession,
      captureSessionHookExec: buildConsoleCaptureHookCommand(
        options.hookEntry,
        profile.id,
        options.createSessionCaptureHookExec,
      ),
      turnStartHookExec: buildConsoleTurnHookCommand(options.hookEntry, "start"),
      turnEndHookExec: buildConsoleTurnHookCommand(options.hookEntry, "end"),
      backgroundReportHookExec: buildConsoleBackgroundHookCommand(options.hookEntry),
      inputWaitingHookExec: buildConsoleAttentionHookCommand(options.hookEntry),
      autoNameHookExec: buildConsoleAutoNameHookCommand(options.hookEntry),
      onCleanup: (cleanup) => cleanupStack.push(cleanup),
      resumeSessionId: options.resumeSessionId,
      withMarketplaceLock: withConsoleMarketplaceLock,
      mcpSessionLabel: options.sessionId,
      ...(gatewaySelection
        ? {
          gatewayExposedModels: gatewaySelection.models,
          gatewayEffortExposure: gatewaySelection.effortExposure,
        }
        : {}),
    } as Parameters<typeof injectAgentCliProfile>[1] & { readonly mcpSessionLabel: string });
    options.onRuntimeSessionStart?.({
      cliId: injectedProfile.id,
      cliLabel: injectedProfile.label,
      label: injectedProfile.label,
      mcpToolCount: countMcpTools(agentRuntime),
      sessionId: options.sessionId,
    });
    let launchProfile = injectedProfile;
    if (injectedProfile.id === "claude-gateway") {
      if (!options.aiGateway) {
        throw new Error("The AI gateway launch binding is unavailable.");
      }
      const origin = options.aiGateway.origin();
      if (!origin) {
        throw new Error("Fleet Console has not bound a port yet, so the AI gateway URL cannot be derived.");
      }
      launchProfile = prepareAiGatewayLaunchProfile(injectedProfile, {
        baseUrl: `${origin}${options.aiGateway.routePath}`,
        selection: gatewaySelection,
      });
    }
    const sessionIdentityResolver = options.createSessionIdentityResolver({
      provider: toCaptureProvider(launchProfile.id),
      command: launchProfile.bin,
      commandPrefixArgs: launchProfile.binPrefixArgs,
      cwd: launchProfile.cwd,
      env: launchProfile.env,
    });
    return toLaunchSpec(launchProfile, createOnceCleanup(async () => {
      for (const cleanup of [...cleanupStack].reverse()) {
        await cleanup();
      }
    }), sessionIdentityResolver);
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

function toLaunchSpec(profile: AgentCliProfile, cleanup: () => Promise<void>, sessionIdentityResolver: TerminalLaunchSpec["sessionIdentityResolver"]): TerminalLaunchSpec {
  return {
    args: [...profile.args],
    bin: profile.bin,
    cleanup,
    cwd: profile.cwd,
    env: { ...profile.env },
    messagePolicy: profile.messagePolicy,
    renameCommand: profile.renameCommand,
    sessionIdentityResolver,
    terminalName: profile.terminalName,
  };
}

function countMcpTools(agentRuntime: FleetGatewayAgentRuntimeLifecycle): number {
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

function buildLaunchEnv(env: NodeJS.ProcessEnv, cwd: string, sessionId: string | undefined, colorScheme?: "light" | "dark"): NodeJS.ProcessEnv {
  return {
    ...stripConsoleInternalEnv(env),
    ...(sessionId ? { FLEET_CONSOLE_SESSION_ID: sessionId, INIT_CWD: cwd, PWD: cwd } : {}),
    TERM: TERMINAL_TERM,
    // 배경을 질의하지 않는 agent CLI를 위한 고전적 테마 극성 힌트 — spawn 시점 값에 고정된다.
    ...(colorScheme ? { COLORFGBG: colorScheme === "light" ? "0;15" : "15;0" } : {}),
  };
}

function resolveOptionalPackage(id: string): string | undefined {
  try {
    return require.resolve(id);
  } catch {
    return undefined;
  }
}
