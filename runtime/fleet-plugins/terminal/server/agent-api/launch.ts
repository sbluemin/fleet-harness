import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolvePathBinary } from "@dotobokuri/core-agent";
import { GATEWAY_MODELS, buildAnthropicModelList, toClaudeGatewayModelId } from "@dotobokuri/core-ai-gateway";
import type { GatewayModel } from "@dotobokuri/core-ai-gateway";
import { createSessionIdentityResolver } from "@dotobokuri/core-unified-agent";
import {
  createSessionCaptureHookExec,
  createSystemPromptBuilder,
  injectAgentCliProfile,
  resolveAgentCliProfile,
  type AgentCliId,
  type AgentCliProfile,
  type FleetAgentRuntimeLifecycle,
} from "@dotobokuri/fleet-admiral";
import {
  createInfraServices,
  getFleetDataDir,
  writeAtomicSync,
  type GlobalOptionsService,
} from "@dotobokuri/core-infra";

import { buildConsoleAttentionHookCommand, buildConsoleAutoNameHookCommand, buildConsoleBackgroundHookCommand, buildConsoleCaptureHookCommand, buildConsoleTurnHookCommand, toCaptureProvider, withConsoleMarketplaceLock, type ConsoleHookCommandEntry } from "./host-hooks.js";
import { resolveAiGatewaySelection, type AiGatewaySelection, type AiGatewayStoredSettings } from "../ai-gateway-settings.js";
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
  readonly agentRuntime?: FleetAgentRuntimeLifecycle;
  readonly aiGateway?: AiGatewayLaunchBinding;
  readonly injectProfile?: typeof injectAgentCliProfile;
  readonly onRuntimeSessionStart?: (session: ConsoleRuntimeSessionInfo) => void;
  readonly resolveProfile?: typeof resolveAgentCliProfile;
  readonly createSessionIdentityResolver?: typeof createSessionIdentityResolver;
  readonly readAgentCliPaths?: () => Promise<Readonly<Record<string, string>>>;
  readonly readAiGatewaySettings?: () => Promise<AiGatewayStoredSettings>;
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
  readonly agentRuntime?: FleetAgentRuntimeLifecycle;
  readonly aiGateway?: AiGatewayLaunchBinding;
  readonly readAiGatewaySettings?: () => Promise<AiGatewayStoredSettings>;
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
    const globalSettings = readGlobalSettingsSnapshot(options.infraServices);
    // gateway Agent 주입과 ANTHROPIC_MODEL/cache는 같은 selection을 공유한다.
    // inject보다 먼저 읽어 `--agents`에 노출 모델×effort를 스폰 인자로만 실는다.
    const gatewaySelection = profile.id === "claude-gateway" && options.readAiGatewaySettings
      ? resolveAiGatewaySelection(await options.readAiGatewaySettings())
      : undefined;
    const injectedProfile = await options.injectProfile(profile, {
      buildSystemPrompt: (injectTone) => options.createSystemPromptBuilder({ carrierRuntime: agentRuntime.carrierRuntime }).build(injectTone),
      dataDir: options.dataDir,
      dedicatedMcpSession: agentRuntime.dedicatedMcpSession,
      enableMetaphor: globalSettings.enableMetaphor,
      captureSessionHookExec: buildConsoleCaptureHookCommand(
        options.hookEntry,
        profile.id,
        options.createSessionCaptureHookExec,
      ),
      turnStartHookExec: buildConsoleTurnHookCommand(options.hookEntry, "start"),
      turnEndHookExec: buildConsoleTurnHookCommand(options.hookEntry, "end"),
      backgroundSpawnHookExec: buildConsoleBackgroundHookCommand(options.hookEntry, "spawn"),
      backgroundStopHookExec: buildConsoleBackgroundHookCommand(options.hookEntry, "stop"),
      inputWaitingHookExec: buildConsoleAttentionHookCommand(options.hookEntry),
      autoNameHookExec: buildConsoleAutoNameHookCommand(options.hookEntry),
      onCleanup: (cleanup) => cleanupStack.push(cleanup),
      resumeSessionId: options.resumeSessionId,
      withMarketplaceLock: withConsoleMarketplaceLock,
      mcpSessionLabel: options.sessionId,
      ...(gatewaySelection ? { gatewayExposedModels: gatewaySelection.models } : {}),
    } as Parameters<typeof injectAgentCliProfile>[1] & { readonly mcpSessionLabel: string });
    options.onRuntimeSessionStart?.({
      cliId: injectedProfile.id,
      cliLabel: injectedProfile.label,
      label: injectedProfile.label,
      mcpToolCount: countMcpTools(agentRuntime),
      sessionId: options.sessionId,
    });
    const launchProfile = applyAiGatewayEnv(
      injectedProfile,
      options.aiGateway,
      gatewaySelection,
    );
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

// claude-gateway는 Console 포트를 알아야 base URL이 정해지므로 정적 프로필이 아니라 여기서 env를 채운다.
export function applyAiGatewayEnv(
  profile: AgentCliProfile,
  aiGateway: AiGatewayLaunchBinding | undefined,
  // 노출은 opt-in: 켠 모델만 캐시에 남는다. 설정 없이 호출되면(테스트 하네스) 전체 카탈로그로 동작한다.
  selection?: AiGatewaySelection,
): AgentCliProfile {
  if (profile.id !== "claude-gateway") return profile;
  if (!aiGateway) {
    throw new Error("The AI gateway launch binding is unavailable.");
  }
  const origin = aiGateway.origin();
  if (!origin) {
    throw new Error("Fleet Console has not bound a port yet, so the AI gateway URL cannot be derived.");
  }
  const baseUrl = `${origin}${aiGateway.routePath}`;
  const env: Record<string, string> = {
    ...profile.env,
    // Claude Code가 이 뒤에 /v1/messages를 붙인다.
    ANTHROPIC_BASE_URL: baseUrl,
    // 이게 있어야 /model picker가 게이트웨이의 GET /v1/models를 조회한다.
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // Gateway가 tool_reference 계약을 보존한다. Cursor는 이를 지연 catalog 선택에 쓰고,
    // 호환 프로바이더 경계는 각자의 eager wire 형식으로 정규화한다.
    ENABLE_TOOL_SEARCH: "true",
  };
  // Marked provider usage is projected onto Claude Code's 1M coordinate, so its
  // native auto policy remains model-relative. Do not inject the process-wide
  // compact-window override: it would also retune built-in Claude models. An
  // explicit user value already present in profile.env remains untouched above.
  if (selection?.defaultModel && !env.ANTHROPIC_MODEL) {
    // AI Gateway 설정의 세션 기본 모델. 프로필 env가 명시한 값이 항상 이긴다.
    env.ANTHROPIC_MODEL = toClaudeGatewayModelId(selection.defaultModel);
  }
  try {
    writeClaudeGatewayModelCache(baseUrl, env, undefined, selection?.models ?? GATEWAY_MODELS);
  } catch (error) {
    console.warn("[terminal] Claude Code gateway model cache refresh failed; /model may show stale entries.", error);
  }
  // 자체 bearer를 주입하지 않는다. 주입하면 Claude Code가 claude.ai OAuth 대신 그것을 보내고,
  // Anthropic 모델을 원문 중계할 자격증명이 사라져 게이트웨이가 토큰을 대신 읽는 우회가 된다.
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  return { ...profile, env };
}

/**
 * Claude Code does not refresh gateway discovery while it relies on its own
 * subscription credential. Pre-write the cache schema it reads in that mode.
 */
export function writeClaudeGatewayModelCache(
  baseUrl: string,
  env: Readonly<NodeJS.ProcessEnv>,
  homeDir = os.homedir(),
  exposedModels: readonly GatewayModel[] = GATEWAY_MODELS,
): string {
  const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0
    ? env.CLAUDE_CONFIG_DIR
    : path.join(homeDir, ".claude");
  const cacheDir = path.join(configDir, "cache");
  const cachePath = path.join(cacheDir, "gateway-models.json");
  const models = buildAnthropicModelList(exposedModels).data
    .filter((model) => /^(claude|anthropic)/i.test(model.id))
    .map((model) => ({ id: model.id, display_name: model.display_name }));

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  writeAtomicSync(cachePath, JSON.stringify({ baseUrl, fetchedAt: Date.now(), models }), { mode: 0o600 });
  return cachePath;
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

// 세션 launch 직전에 전역 옵션(~/.fleet/settings.json)을 1회 스냅샷한다. daemon 재시작 없이도
// 신규 세션이 최신 토글 값을 반영하도록 부팅 캐시가 아닌 launch 시점에 읽는다. 로드 실패(락 타임아웃 등)는
// 세션 launch를 막지 않고 기본값(append / 메타포 off)으로 폴백한다.
function readGlobalSettingsSnapshot(infraServices: { readonly globalOptionsService: GlobalOptionsService }): { readonly enableMetaphor: boolean } {
  try {
    const data = infraServices.globalOptionsService.load();
    return { enableMetaphor: data.enableMetaphor ?? false };
  } catch {
    return { enableMetaphor: false };
  }
}
