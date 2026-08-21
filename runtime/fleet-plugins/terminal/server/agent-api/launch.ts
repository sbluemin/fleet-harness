import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolvePathBinary } from "@dotobokuri/core-process";
import { exposableEffortLadder, GATEWAY_REASONING_EFFORTS, resolveAiGatewaySelection, toClaudeGatewayModelId } from "@dotobokuri/core-ai-gateway";
import type { AiGatewaySelection, AiGatewayStoredSettings, GatewayModel, GatewayReasoningEffort } from "@dotobokuri/core-ai-gateway";
import {
  createAgentCliPlugin,
  createSessionCaptureHookExec,
  injectAgentCliProfile,
  prepareAiGatewayLaunchProfile,
  resolveAgentCliId,
  resolveAgentCliProfile,
  resolveNativeClaudeModelAlias,
  type AgentCliId,
  type AgentCliProfile,
  LaunchPromptError,
  type FleetGatewayAgentRuntimeLifecycle,
} from "@dotobokuri/fleet-admiral";
import {
  createInfraServices,
  getFleetDataDir,
  type GlobalOptionsService,
} from "@dotobokuri/core-infra";

import { resolveClaudeCodeSystemPrompt } from "../settings-routes.js";
import { createSessionIdentityResolver } from "./session-identity.js";
import { buildConsoleAttentionHookCommand, buildConsoleAutoNameHookCommand, buildConsoleBackgroundHookCommand, buildConsoleCaptureHookCommand, buildConsoleTurnHookCommand, toCaptureProvider, withConsoleMarketplaceLock, type ConsoleHookCommandEntry } from "./host-hooks.js";
import type { TerminalLaunchContext, TerminalLaunchSpec } from "../shared/terminal-types.js";
import { stripConsoleInternalEnv } from "../shared/launch-env.js";
import { applyAgentCliPathEnvOverlay } from "./agent-cli-paths.js";
import { PANEL_GATEWAY_HEADER_ENV, panelGatewayHeaderValue } from "../ai-gateway-pool.js";

/** AI gateway를 Console의 실제 listening origin에 연결하는 launch 바인딩. */
export interface AiGatewayLaunchBinding {
  /** Console 루트 기준 라우트 경로. 예: "/plugins/terminal/ai-gateway" */
  readonly routePath: string;
  /** Console이 리슨 중인 origin. MCP는 별도 포트라 여기서 유도하면 안 된다. */
  origin(): string | null;
  /**
   * 이 Operation이 자기 게이트웨이를 받을 때 자식이 되돌려 보낼 패널 식별자. 미주입이거나 빈
   * 문자열이면 이 런치는 Console 공용 게이트웨이를 쓴다.
   *
   * 값은 spawn env에 그대로 구워지므로 런치 시점에 한 번만 정해진다 — 설정을 나중에 끄더라도
   * 이미 떠 있는 패널은 자기 식별자를 계속 보낸다. 그게 옳다: 살아 있는 자식의 env를 바꿀
   * 방법은 없고, 라우터는 패널이 사라질 때 회수된다.
   */
  panelIdFor?(operationId: string | undefined): string;
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

export type GatewayLaunchOptionErrorCode = "gateway_model_not_enabled" | "invalid_effort";

export class GatewayLaunchOptionError extends Error {
  readonly code: GatewayLaunchOptionErrorCode;

  constructor(code: GatewayLaunchOptionErrorCode, message: string) {
    super(message);
    this.name = "GatewayLaunchOptionError";
    this.code = code;
  }
}

export function isGatewayLaunchEffortAllowed(
  selection: AiGatewaySelection,
  model: GatewayModel,
  effort: string,
): boolean {
  // ultra는 카탈로그 사다리 밖의 Console launch sentinel이다 — 하네스 능력(launch factory가
  // `--effort ultracode`로 전달)이라 enabled 모델이면 사다리·노출과 무관하게 허용한다.
  if (effort === "ultra") return true;
  // 첫 검사는 어휘만 판별하고, 실제 모델이 그 단을 제공하는지는 아래 카탈로그 사다리가 판다.
  if (!(GATEWAY_REASONING_EFFORTS as readonly string[]).includes(effort)) return false;
  const efforts = selection.effortExposure[model.id] ?? exposableEffortLadder(model);
  return efforts.includes(effort as GatewayReasoningEffort);
}

export type TerminalLaunchResolver = (cwd?: string, context?: TerminalLaunchContext) => Promise<TerminalLaunchSpec>;

const DEFAULT_TERMINAL_CWD_FALLBACK = os.homedir;
const TERMINAL_TERM = "xterm-256color";
const CONSOLE_ENTRY_PATH = fileURLToPath(import.meta.url);
const HOOK_ENTRY_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".tsx"]);
const require = createRequire(import.meta.url);

/**
 * Console CLI를 가리키는 훅 진입점. 세션별 값이 하나도 구워지지 않는다 — 그래서 모든 세션이
 * 렌더한 `hooks.json`이 서로 같고, PTY와 Chat Mode가 한 플러그인 디렉터리를 공유할 수 있다.
 */
function buildConsoleHookEntry(deps: TerminalLaunchResolverDeps): ConsoleHookCommandEntry {
  const entryPath = resolveHookEntryPath(deps.entryPath ?? process.argv[1]);
  const execPath = deps.execPath ?? process.execPath;
  const tsxLoaderPath = deps.tsxLoaderPath ?? resolveOptionalPackage("tsx");
  return { entryPath, execPath, ...(tsxLoaderPath ? { tsxLoaderPath } : {}) };
}

/**
 * Chat Mode 세션이 SDK에 넘길 Fleet 플러그인 루트를 렌더한다.
 *
 * PTY 런치와 **같은 자리에 같은 옵션으로** 쓴다. 옵션이 갈리면 나중에 렌더한 쪽이 앞선 쪽의
 * 훅을 지우므로, 여기서 훅 exec를 빼는 것은 "Chat에는 상태 훅을 걸지 않는다"가 아니라
 * "터미널 세션의 상태 훅을 지운다"가 된다. 두 표면의 신호 차이는 이 파일이 아니라 호스트가
 * 그 신호를 읽는 자리에서 가른다.
 */
export async function renderFleetPluginRootsForChat(
  deps: TerminalLaunchResolverDeps & { readonly cwd: string },
): Promise<readonly string[]> {
  const hookEntry = buildConsoleHookEntry(deps);
  const dataDir = deps.dataDir ?? getFleetDataDir();
  const gatewaySelection = deps.readAiGatewaySettings
    ? resolveAiGatewaySelection(deps.readAiGatewaySettings())
    : undefined;
  const plugin = await createAgentCliPlugin({
    cliId: CHAT_PLUGIN_CLI_ID,
    cwd: deps.cwd,
    dataDir,
    captureSessionHookExec: buildConsoleCaptureHookCommand(hookEntry, CHAT_PLUGIN_CLI_ID, createSessionCaptureHookExec),
    turnStartHookExec: buildConsoleTurnHookCommand(hookEntry, "start"),
    turnEndHookExec: buildConsoleTurnHookCommand(hookEntry, "end"),
    backgroundReportHookExec: buildConsoleBackgroundHookCommand(hookEntry),
    inputWaitingHookExec: buildConsoleAttentionHookCommand(hookEntry),
    autoNameHookExec: buildConsoleAutoNameHookCommand(hookEntry),
    withMarketplaceLock: withConsoleMarketplaceLock,
    ...(gatewaySelection
      ? {
        gatewayDelegationModels: gatewaySelection.delegationModels,
        gatewayEffortExposure: gatewaySelection.effortExposure,
      }
      : {}),
  });
  return plugin.pluginRoots;
}

const CHAT_PLUGIN_CLI_ID: AgentCliId = "claude-gateway";

export function createAgentTerminalLaunchResolver(deps: TerminalLaunchResolverDeps = {}): TerminalLaunchResolver {
  const baseCwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? DEFAULT_TERMINAL_CWD_FALLBACK;
  const platform = deps.platform ?? process.platform;
  const dataDir = deps.dataDir ?? getFleetDataDir();
  const infraServices = deps.infraServices ?? createInfraServices();
  const agentRuntime = deps.agentRuntime;
  const injectProfile = deps.injectProfile ?? injectAgentCliProfile;
  const resolveProfile = deps.resolveProfile ?? resolveAgentCliProfile;
  const resolveSessionIdentityResolver = deps.createSessionIdentityResolver ?? createSessionIdentityResolver;
  const hookEntry = buildConsoleHookEntry(deps);

  return async (selectedCwd, context) => {
    const cwd = selectedCwd || baseCwd || homedir();
    const testLaunch = (globalThis as { __fleetTerminalLaunch?: TerminalLaunchResolver }).__fleetTerminalLaunch;
    if (testLaunch) return testLaunch(cwd, context);
    let launchEnv = buildLaunchEnv(env, cwd, context?.sessionId, context?.colorScheme);
    if (deps.readAgentCliPaths) {
      launchEnv = applyAgentCliPathEnvOverlay(launchEnv, context?.cliId, await deps.readAgentCliPaths());
    }
    // FLEET_TERMINAL_CMD는 Agent CLI 실행을 통째로 대체한다 — 모델·강도·resume·시스템 프롬프트·
    // MCP 설정·플러그인 디렉터리와 마찬가지로 런치 프롬프트도 실을 자리가 없다. 임의 명령의 argv
    // 계약을 알 수 없어 사용자 텍스트를 뒤에 붙일 수 없기 때문이다. 조용히 버리면 Operation은
    // 열렸는데 아무 지시도 받지 못한 세션이 남으므로, 프롬프트를 들고 온 런치는 아예 거부한다.
    const override = parseTerminalCommand(env.FLEET_TERMINAL_CMD);
    if (override && context?.prompt) {
      throw new LaunchPromptError(
        "prompt_unsupported_launch",
        "FLEET_TERMINAL_CMD replaces the Agent CLI launch, so a launch prompt cannot be delivered in this configuration.",
      );
    }
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
      injectProfile,
      onRuntimeSessionStart: deps.onRuntimeSessionStart,
      resolveProfile,
      cliId: context?.cliId,
      model: context?.model,
      effort: context?.effort,
      ...(context?.operationId ? { operationId: context.operationId } : {}),
      prompt: context?.prompt,
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
  readonly model?: string;
  readonly effort?: string;
  readonly createSessionCaptureHookExec: typeof createSessionCaptureHookExec;
  readonly createSessionIdentityResolver: typeof createSessionIdentityResolver;
  readonly cwd: string;
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt?: string;
  readonly hookEntry: ConsoleHookCommandEntry;
  readonly infraServices: { readonly globalOptionsService: GlobalOptionsService };
  readonly injectProfile: typeof injectAgentCliProfile;
  readonly onRuntimeSessionStart?: (session: ConsoleRuntimeSessionInfo) => void;
  readonly resolveProfile: typeof resolveAgentCliProfile;
  readonly resumeSessionId?: string;
  readonly sessionId: string;
  readonly operationId?: string;
}): Promise<TerminalLaunchSpec> {
  const cleanupStack: Array<() => void | Promise<void>> = [];
  try {
    const agentRuntime = options.agentRuntime;
    if (!agentRuntime) {
      throw new Error("Fleet Console agent runtime is unavailable.");
    }
    const cliId = resolveAgentCliId(options.env, { cliId: options.cliId });
    // gateway Agent 주입과 ANTHROPIC_MODEL/cache는 같은 selection을 공유한다.
    // resolveProfile보다 먼저 읽어 명시 모델 검증·Agent 정의 렌더·cache가 한 스냅샷을 공유한다.
    const gatewaySelection = cliId === "claude-gateway" && options.readAiGatewaySettings
      ? resolveAiGatewaySelection(options.readAiGatewaySettings())
      : undefined;
    let resolvedModel = options.model;
    if (cliId === "claude-gateway" && resolvedModel) {
      const nativeAlias = resolveNativeClaudeModelAlias(resolvedModel);
      if (nativeAlias) {
        resolvedModel = nativeAlias;
      } else {
        const model = gatewaySelection?.models.find((candidate) => candidate.id === resolvedModel);
        if (!model) {
          throw new GatewayLaunchOptionError(
            "gateway_model_not_enabled",
            `Gateway model "${resolvedModel}" is not enabled.`,
          );
        }
        if (options.effort !== undefined && (!gatewaySelection || !isGatewayLaunchEffortAllowed(gatewaySelection, model, options.effort))) {
          throw new GatewayLaunchOptionError(
            "invalid_effort",
            `Gateway effort "${options.effort}" is not enabled for model "${resolvedModel}".`,
          );
        }
        resolvedModel = toClaudeGatewayModelId(model);
      }
    }
    const profile = await options.resolveProfile(options.env, options.cwd, {
      cliId,
      resumeSessionId: options.resumeSessionId,
      model: resolvedModel,
      effort: options.effort,
      prompt: options.prompt,
    });
    const injectedProfile = await options.injectProfile(profile, {
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
      // 사용자가 고른 값이며 새 세션에만 적용된다 — 실행 중인 세션은 자기 런치 구성을 유지한다.
      claudeCodeSystemPrompt: resolveClaudeCodeSystemPrompt(options.infraServices.globalOptionsService.load()),
      resumeSessionId: options.resumeSessionId,
      withMarketplaceLock: withConsoleMarketplaceLock,
      mcpSessionLabel: options.sessionId,
      ...(gatewaySelection
        ? {
          // identity와 roster는 delegationModels를, wire·launch picker·validation은 models를 사용한다.
          gatewayDelegationModels: gatewaySelection.delegationModels,
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
      // baseUrl은 패널마다 갈라지지 않는다. Claude Code는 Claude 홈마다 게이트웨이 모델 캐시를
      // 하나만 두고 그 baseUrl이 자기 ANTHROPIC_BASE_URL과 글자 단위로 같을 때만 인정하므로,
      // 패널마다 다른 URL을 주면 마지막에 뜬 패널을 뺀 전부가 빈 /model 픽커를 갖게 된다.
      // 패널 신원은 요청 헤더로 간다.
      launchProfile = prepareAiGatewayLaunchProfile(injectedProfile, {
        baseUrl: `${origin}${options.aiGateway.routePath}`,
        selection: gatewaySelection,
      });
      const panelHeaders = panelGatewayHeaderValue(
        launchProfile.env[PANEL_GATEWAY_HEADER_ENV],
        options.aiGateway.panelIdFor?.(options.operationId) ?? "",
      );
      if (panelHeaders !== undefined) {
        launchProfile = {
          ...launchProfile,
          env: { ...launchProfile.env, [PANEL_GATEWAY_HEADER_ENV]: panelHeaders },
        };
      }
    }
    const sessionIdentityResolver = options.createSessionIdentityResolver({ cwd: launchProfile.cwd });
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
