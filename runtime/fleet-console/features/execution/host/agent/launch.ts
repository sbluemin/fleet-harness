import { ROSTER_FALLBACK_MODEL, resolveRosterCoordinate } from "../../../ai-gateway/shared/models.js";
import { buildModelRoster } from "../../../ai-gateway/host/model-roster.js";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolvePathBinary } from "@fleet-console/process";
import { exposableEffortLadder, findGatewayModel, GATEWAY_REASONING_EFFORTS, resolveAiGatewaySelection, toClaudeGatewayModelId, visibleGatewayModels } from "@fleet-console/ai-gateway";
import type { AiGatewaySelection, AiGatewayStoredSettings, GatewayModel, GatewayReasoningEffort, ProviderStatusMap } from "@fleet-console/ai-gateway";
import { ALL_SUBAGENTS, OBJECTIVE_PEER_TOOLS, createSessionCaptureHookExec, injectAgentCliProfile, prepareClaudeSession, resolveAgentCliId, resolveAgentCliProfile, resolveNativeClaudeModelAlias, type AgentCliId, type AgentCliProfile, type AgentCliPlugin, type ClaudeSessionHandle, type ClaudeSessionOrigin, LaunchPromptError, type FleetGatewayAgentRuntimeLifecycle, type LaunchPromptDirectoryAllocator } from "@fleet-console/agent-runtime/fleet";
import { modelSpeedLaunchEnv, prepareAiGatewayLaunchProfile, type ModelSpeedChoice } from "@fleet-console/ai-gateway";
import type { AgentOptionsService } from "@fleet-console/infra";

import type { CommodoreSystemPromptService } from "../../../settings/host/agent-options.js";
import { createSessionIdentityResolver } from "./session-identity.js";
import type { WorkspaceHookBinding } from "./workspace-hooks.js";
import { buildConsoleCaptureHookCommand, buildConsoleHookEntry, buildConsoleTurnHookCommand, buildConsoleWorkspaceHookCommand, toCaptureProvider, type ConsoleHookCommandEntry } from "./host-hooks.js";
import type { TerminalLaunchContext, TerminalLaunchSpec } from "../terminal/terminal-types.js";
import { stripConsoleInternalEnv, TERMINAL_TERM, withTerminalCapabilities } from "../terminal/launch-env.js";
import { applyAgentCliPathEnvOverlay } from "./agent-cli-paths.js";

/** AI gateway를 Console의 실제 listening origin에 연결하는 launch 바인딩. */
export interface AiGatewayLaunchBinding {
  /** Console 루트 기준 라우트 경로. 예: "/api/v1/ai-gateway" */
  readonly routePath: string;
  /** Console이 리슨 중인 origin. MCP는 별도 포트라 여기서 유도하면 안 된다. */
  origin(): string | null;
  /** Process-local credential accepted only by the compact lifecycle endpoint. */
  readonly compactHookToken?: string;
  /** 라우팅 Mod가 정체성을 물을 때 쓰는 자격. */
  readonly modHookToken?: string;
}

export interface TerminalLaunchResolverDeps {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly homedir?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly entryPath?: string;
  readonly tsxLoaderPath?: string;
  /**
   * 이 Console 인스턴스의 슬롯. 세션 자산이 그 아래 산다.
   */
  readonly dataDir: string;
  /** 기동에 한 번 렌더해 둔 플러그인 트리. 런치는 이것을 쓰기만 한다. */
  readonly plugin: AgentCliPlugin;
  /** launch 프롬프트 파일의 자리(이 Console의 lock 도메인). 생략하면 OS temp에 바로 만든다. */
  readonly promptDirectories?: LaunchPromptDirectoryAllocator;
  readonly infraServices: { readonly agentOptionsService: AgentOptionsService };
  readonly commodoreSystemPrompts?: CommodoreSystemPromptService;
  /** 사령관이 고른 플러그인의 로컬 디렉터리 — 그 사령관 목표의 세션이 새로 열릴 때 싣는다. */
  readonly commodorePluginDirs?: (commodoreId: string) => readonly string[];
  /** 그 플러그인 MCP 선언의 `${VAR}`에 채울 키 — 같은 세션의 자식 환경에 얹는다. */
  readonly commodorePluginEnv?: (commodoreId: string) => Readonly<Record<string, string>>;
  readonly agentRuntime?: FleetGatewayAgentRuntimeLifecycle;
  readonly aiGateway?: AiGatewayLaunchBinding;
  readonly injectProfile?: typeof injectAgentCliProfile;
  readonly onRuntimeSessionStart?: (session: ConsoleRuntimeSessionInfo) => void;
  readonly bindWorkspaceHook?: (objectiveId: string, providerSessionId: string) => WorkspaceHookBinding;
  readonly resolveProfile?: typeof resolveAgentCliProfile;
  readonly createSessionIdentityResolver?: typeof createSessionIdentityResolver;
  readonly readAgentCliPaths?: () => Promise<Readonly<Record<string, string>>>;
  readonly readAiGatewaySettings?: () => AiGatewayStoredSettings;
  /** 공급자 로그인 상태. 없으면 미상으로 보아 카탈로그 전체를 실행 가능한 모델로 본다. */
  readonly readProviderStatuses?: () => ProviderStatusMap | undefined;
}

export interface ConsoleRuntimeSessionInfo {
  readonly cliId: AgentCliId;
  readonly cliLabel: string;
  readonly label: string;
  readonly mcpToolCount: number;
  readonly sessionId: string;
  /**
   * 이 런치가 연 Claude 세션의 id. Fleet이 못박은 값이라 자식의 첫 프롬프트를 기다리지 않고
   * 여기서 이미 확정이다 — capture hook이 오기 전에도 호스트가 그 세션의 좌표를 안다.
   */
  readonly claudeSessionId?: string;
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
  model: GatewayModel,
  effort: string,
): boolean {
  // ultra는 카탈로그 사다리 밖의 Console launch sentinel이다 — 하네스 능력(launch factory가
  // `--effort ultracode`로 전달)이라 사다리와 무관하게 허용한다.
  if (effort === "ultra") return true;
  if (!(GATEWAY_REASONING_EFFORTS as readonly string[]).includes(effort)) return false;
  return exposableEffortLadder(model).includes(effort as GatewayReasoningEffort);
}

function readLaunchProviderStatuses(read: (() => ProviderStatusMap | undefined) | undefined): ProviderStatusMap | undefined {
  if (!read) return undefined;
  try {
    return read();
  } catch {
    return undefined;
  }
}

export type TerminalLaunchResolver = (cwd?: string, context?: TerminalLaunchContext) => Promise<TerminalLaunchSpec>;

const DEFAULT_TERMINAL_CWD_FALLBACK = os.homedir;
const CONSOLE_ENTRY_PATH = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

/**
 * Chat Mode 세션이 SDK에 넘길 Claude 세션 핸들을 admiral에서 받는다.
 *
 * 여기서 조립하는 것은 아무것도 없다 — 세션 id, 플러그인 트리, 스킬 억제, 설정 층, 시스템
 * 프롬프트 정책은 전부 핸들이 들고 온다. PTY 런치가 같은 함수에서 같은 것을 받으므로, 정책이
 * 바뀌면 두 표면이 함께 움직인다. 반환된 핸들의 `release`를 세션 teardown에 연결하지 않으면
 * 트리가 회수되지 않는다.
 */
export async function prepareChatClaudeSession(
  deps: Omit<TerminalLaunchResolverDeps, "infraServices"> & {
    readonly cwd: string;
    readonly origin: ClaudeSessionOrigin;
    readonly claudeCodeSystemPrompt?: "on" | "off";
    readonly claudeCodeDisabledAgents?: readonly string[];
    readonly disableAutoMemory?: boolean;
    readonly objectiveMessaging?: boolean;
    readonly pluginDirs?: readonly string[];
    readonly pluginEnv?: Readonly<Record<string, string>>;
  },
): Promise<ClaudeSessionHandle> {
  const gatewaySelection = deps.readAiGatewaySettings
    ? resolveAiGatewaySelection(deps.readAiGatewaySettings())
    : undefined;
  return prepareClaudeSession({
    cliId: CHAT_PLUGIN_CLI_ID,
    cwd: deps.cwd,
    plugin: deps.plugin,
    ...(deps.pluginDirs?.length ? { pluginDirs: deps.pluginDirs } : {}),
    ...(deps.pluginEnv ? { pluginEnv: deps.pluginEnv } : {}),
    origin: deps.origin,
    ...(deps.claudeCodeSystemPrompt ? { claudeCodeSystemPrompt: deps.claudeCodeSystemPrompt } : {}),
    ...(deps.claudeCodeDisabledAgents ? { claudeCodeDisabledAgents: deps.claudeCodeDisabledAgents } : {}),
    ...(deps.disableAutoMemory !== undefined ? { disableAutoMemory: deps.disableAutoMemory } : {}),
    claudeCodeDisabledTools: consoleDisabledTools(deps.objectiveMessaging),
    workspaceHookExec: buildConsoleWorkspaceHookCommand(buildConsoleHookEntry(deps)),
    ...(gatewaySelection
      ? {
      }
      : {}),
  });
}

const CHAT_PLUGIN_CLI_ID: AgentCliId = "claude";
/**
 * Console이 띄우는 Claude 세션이 늘 빼는 대화형 도구 — 사람에게 묻는 질문, 계획 모드 진입과 계획 승인.
 * 두 표면 모두 이 이름들을 deny 목록에 싣는다. 진입만 남기면 승인 없이 계획 모드를 빠져나올 수 없으므로 함께 뺀다.
 */
export const CONSOLE_DISABLED_TOOLS: readonly string[] = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];
/** 목표 세션만 피어 도구를 더 뺀다. 그 밖은 기존 목록 그대로다. */
export function consoleDisabledTools(objectiveMessaging: boolean | undefined): readonly string[] {
  return objectiveMessaging ? [...CONSOLE_DISABLED_TOOLS, ...OBJECTIVE_PEER_TOOLS] : CONSOLE_DISABLED_TOOLS;
}

export function createAgentTerminalLaunchResolver(deps: TerminalLaunchResolverDeps): TerminalLaunchResolver {
  const baseCwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? DEFAULT_TERMINAL_CWD_FALLBACK;
  const platform = deps.platform ?? process.platform;
  const dataDir = deps.dataDir;
  const infraServices = deps.infraServices;
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
    if (context?.additionalDirectories !== undefined) launchEnv.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";
    if (deps.readAgentCliPaths) {
      launchEnv = applyAgentCliPathEnvOverlay(launchEnv, context?.cliId, await deps.readAgentCliPaths());
    }
    // FLEET_TERMINAL_CMD는 Agent CLI 실행을 통째로 대체한다 — 모델·강도·resume·시스템 프롬프트·
    // MCP 설정·플러그인 디렉터리와 마찬가지로 런치 프롬프트도 실을 자리가 없다. 임의 명령의 argv
    // 계약을 알 수 없어 사용자 텍스트를 뒤에 붙일 수 없기 때문이다. 조용히 버리면 Objective은
    // 열렸는데 아무 지시도 받지 못한 세션이 남으므로, 프롬프트를 들고 온 런치는 아예 거부한다.
    const override = parseTerminalCommand(env.FLEET_TERMINAL_CMD);
    if (override && (context?.prompt || context?.additionalDirectories !== undefined)) {
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
      ...(deps.readProviderStatuses ? { readProviderStatuses: deps.readProviderStatuses } : {}),
      cwd,
      dataDir,
      env: launchEnv,
      hookEntry,
      plugin: deps.plugin,
      ...(deps.promptDirectories ? { promptDirectories: deps.promptDirectories } : {}),
      infraServices,
      ...(deps.commodoreSystemPrompts ? { commodoreSystemPrompts: deps.commodoreSystemPrompts } : {}),
      ...(deps.commodorePluginDirs ? { commodorePluginDirs: deps.commodorePluginDirs } : {}),
      ...(deps.commodorePluginEnv ? { commodorePluginEnv: deps.commodorePluginEnv } : {}),
      theaterId: context?.theaterId,
      commodoreId: context?.commodoreId,
      additionalDirectories: context?.additionalDirectories,
      createSessionCaptureHookExec,
      injectProfile,
      onRuntimeSessionStart: deps.onRuntimeSessionStart,
      bindWorkspaceHook: deps.bindWorkspaceHook,
      resolveProfile,
      cliId: context?.cliId,
      model: context?.model,
      effort: context?.effort,
      prompt: context?.prompt,
      createSessionIdentityResolver: resolveSessionIdentityResolver,
      resumeSessionId: context?.resumeSessionId,
      sessionName: context?.sessionName,
      ...(context?.disableSubagents ? { disableSubagents: true } : {}),
      ...(context?.disableAutoMemory !== undefined ? { disableAutoMemory: context?.disableAutoMemory } : {}),
      ...(context?.modelSpeed ? { modelSpeed: context.modelSpeed } : {}),
      ...(context?.objectiveMessaging ? { objectiveMessaging: true } : {}),
      sessionId,
    });
  };
}

export const createDefaultTerminalLaunchResolver = createAgentTerminalLaunchResolver;

async function createAgentCliLaunchSpec(options: {
  readonly agentRuntime?: FleetGatewayAgentRuntimeLifecycle;
  readonly aiGateway?: AiGatewayLaunchBinding;
  readonly readAiGatewaySettings?: () => AiGatewayStoredSettings;
  readonly readProviderStatuses?: () => ProviderStatusMap | undefined;
  readonly cliId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly createSessionCaptureHookExec: typeof createSessionCaptureHookExec;
  readonly createSessionIdentityResolver: typeof createSessionIdentityResolver;
  readonly cwd: string;
  readonly theaterId?: string;
  readonly commodoreId?: string;
  readonly additionalDirectories?: readonly string[];
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompt?: string;
  readonly hookEntry: ConsoleHookCommandEntry;
  readonly plugin: AgentCliPlugin;
  readonly promptDirectories?: LaunchPromptDirectoryAllocator;
  readonly infraServices: { readonly agentOptionsService: AgentOptionsService };
  readonly commodoreSystemPrompts?: CommodoreSystemPromptService;
  /** 사령관이 고른 플러그인의 로컬 디렉터리 — 그 사령관 목표의 세션이 새로 열릴 때 싣는다. */
  readonly commodorePluginDirs?: (commodoreId: string) => readonly string[];
  /** 그 플러그인 MCP 선언의 `${VAR}`에 채울 키 — 같은 세션의 자식 환경에 얹는다. */
  readonly commodorePluginEnv?: (commodoreId: string) => Readonly<Record<string, string>>;
  readonly injectProfile: typeof injectAgentCliProfile;
  readonly onRuntimeSessionStart?: (session: ConsoleRuntimeSessionInfo) => void;
  readonly bindWorkspaceHook?: (objectiveId: string, providerSessionId: string) => WorkspaceHookBinding;
  readonly resolveProfile: typeof resolveAgentCliProfile;
  readonly resumeSessionId?: string;
  readonly sessionName?: string;
  /** 서브에이전트 전부 끄기 — 설정의 옵트아웃 목록 대신 `Agent` 도구 자체를 막는다. */
  readonly disableSubagents?: boolean;
  /** 명시한 auto-memory 정책(true=끔, false=켬) — Chat 표면과 같은 설정 키로 실린다. */
  readonly disableAutoMemory?: boolean;
  /** 사람이 그 모델에 고른 속도 — 게이트웨이 요청 헤더로 실린다. */
  readonly modelSpeed?: ModelSpeedChoice;
  /** 목표 세션이면 SendMessage·ListAgents를 deny 목록에 더한다. */
  readonly objectiveMessaging?: boolean;
  readonly sessionId: string;
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
    const gatewaySettings = cliId === "claude" && options.readAiGatewaySettings
      ? options.readAiGatewaySettings()
      : undefined;
    const gatewaySelection = gatewaySettings
      ? resolveAiGatewaySelection(gatewaySettings)
      : undefined;
    let resolvedModel = options.model;
    let effort = options.effort;
    const launchStatuses = cliId === "claude" ? readLaunchProviderStatuses(options.readProviderStatuses) : undefined;
    const launchCatalog = cliId === "claude" ? visibleGatewayModels(launchStatuses) : [];
    // 모델 로스터 — 로그인된 공급자의 카탈로그다. 켠 목록과 무관하다. 모델 없이 그 카탈로그가 비면
    // (전부 로그아웃) 실행만 폴백하며 기록을 남긴다. 강도는 카탈로그 사다리로 클램프한다.
    // 재개는 이 블록을 타지 않는다 — 이어 붙이는 세션은 아래 별칭 접기만 받고 프로세스를 조사만으로 재시작하지 않는다.
    if (cliId === "claude" && !options.resumeSessionId) {
      const nativeAlias = resolvedModel ? resolveNativeClaudeModelAlias(resolvedModel) : undefined;
      if (resolvedModel ? nativeAlias !== undefined : launchCatalog.length === 0) {
        const roster = buildModelRoster("launch", launchStatuses);
        const wantedEffort = effort ?? null;
        let coordinate = resolveRosterCoordinate(roster, { model: resolvedModel ?? null, effort: wantedEffort }, { model: ROSTER_FALLBACK_MODEL });
        // 정준 `[1m]` 입력이 아직 bare 행만 있는 가족(Haiku)에 막히지 않게, 같은 가족의 bare 행으로 한 번 더 본다.
        if (coordinate.fallback && nativeAlias) {
          const bare = nativeAlias.slice(0, -"[1m]".length);
          if (resolvedModel !== bare) {
            const viaBare = resolveRosterCoordinate(roster, { model: bare, effort: wantedEffort }, { model: ROSTER_FALLBACK_MODEL });
            if (!viaBare.fallback) coordinate = viaBare;
          }
        }
        if (coordinate.fallback) {
          process.stderr.write(`[fleet-launch] ${JSON.stringify({ ts: new Date().toISOString(), event: "model_fallback", requested: nativeAlias ?? null, model: coordinate.model, effort: coordinate.effort ?? null, reason: coordinate.reason ?? null })}\n`);
          resolvedModel = coordinate.model;
          effort = coordinate.effort;
        } else {
          resolvedModel = nativeAlias ?? coordinate.model;
          if (effort !== undefined) effort = coordinate.effort;
        }
      }
    }
    if (cliId === "claude" && resolvedModel) {
      const nativeAlias = resolveNativeClaudeModelAlias(resolvedModel);
      if (nativeAlias) {
        resolvedModel = nativeAlias;
      } else {
        // 스코프 id와 게이트웨이 표기(`claude-gateway--…[1m]`)를 같은 모델로 받는다 — 어느 철자를
        // 옮겨 적은 호출자도 거절당하면 안 된다.
        const model = findGatewayModel(resolvedModel, launchCatalog);
        if (!model) {
          throw new GatewayLaunchOptionError(
            "gateway_model_not_enabled",
            `Gateway model "${resolvedModel}" is not enabled.`,
          );
        }
        if (effort !== undefined && !isGatewayLaunchEffortAllowed(model, effort)) {
          throw new GatewayLaunchOptionError(
            "invalid_effort",
            `Gateway effort "${effort}" is not enabled for model "${resolvedModel}".`,
          );
        }
        resolvedModel = toClaudeGatewayModelId(model);
      }
    }
    const profile = await options.resolveProfile(options.env, options.cwd, {
      cliId,
      resumeSessionId: options.resumeSessionId,
      model: resolvedModel,
      effort,
      prompt: options.prompt,
      sessionName: options.sessionName,
    });
    const basePromptEnabled = options.commodoreSystemPrompts?.basePromptEnabled(options.commodoreId) ?? true;
    const pluginDirs = options.commodoreId ? options.commodorePluginDirs?.(options.commodoreId) ?? [] : [];
    const pluginEnv = options.commodoreId && pluginDirs.length ? options.commodorePluginEnv?.(options.commodoreId) : undefined;
    const injectedProfile = await options.injectProfile(profile, {
      plugin: options.plugin,
      ...(pluginDirs.length ? { pluginDirs } : {}),
      ...(pluginEnv && Object.keys(pluginEnv).length ? { pluginEnv } : {}),
      ...(options.additionalDirectories ? { additionalDirectories: options.additionalDirectories } : {}),
      dedicatedMcpSession: agentRuntime.dedicatedMcpSession,
      workspaceHookExec: buildConsoleWorkspaceHookCommand(options.hookEntry),
      onCleanup: (cleanup) => cleanupStack.push(cleanup),
      ...(options.promptDirectories ? { promptDirectories: options.promptDirectories } : {}),
      // 사령관 설정은 새 세션에만 적용된다 — 값이 없으면 Claude Code 기본값으로 연다.
      ...(basePromptEnabled ? {} : { claudeCodeSystemPrompt: "off" as const }),
      ...(options.disableSubagents ? { claudeCodeDisabledAgents: [ALL_SUBAGENTS] } : {}),
      ...(options.disableAutoMemory !== undefined ? { disableAutoMemory: options.disableAutoMemory } : {}),
      // 사람에게 묻는 도구와 계획 모드 도구는 늘 뺀다 — 서브에이전트 규칙과 합쳐 같은 deny 목록으로 실린다.
      // 목표 세션은 여기에 SendMessage·ListAgents를 더한다.
      claudeCodeDisabledTools: consoleDisabledTools(options.objectiveMessaging),
      // 이어 붙일 세션이 있으면 그 좌표로 연다. 없으면 admiral이 새 id를 발급해 못박는다.
      origin: options.resumeSessionId
        ? { kind: "resume", sessionId: options.resumeSessionId }
        : { kind: "new" },
      mcpSessionLabel: options.sessionId,
      ...(gatewaySelection
        ? {
          // identity와 roster는 delegationModels를, wire·launch picker·validation은 models를 사용한다.
          }
        : {}),
    });
    options.onRuntimeSessionStart?.({
      cliId: injectedProfile.id,
      cliLabel: injectedProfile.label,
      label: injectedProfile.label,
      mcpToolCount: countMcpTools(agentRuntime),
      sessionId: options.sessionId,
      claudeSessionId: injectedProfile.session.sessionId,
    });
    let launchProfile: AgentCliProfile = injectedProfile;
    if (injectedProfile.id === "claude") {
      if (!options.aiGateway) {
        throw new Error("The AI gateway launch binding is unavailable.");
      }
      const origin = options.aiGateway.origin();
      if (!origin) {
        throw new Error("Fleet Console has not bound a port yet, so the AI gateway URL cannot be derived.");
      }
      launchProfile = prepareAiGatewayLaunchProfile(injectedProfile, {
        baseUrl: `${origin}${options.aiGateway.routePath}`,
        // 와이어·/model 캐시는 로그인된 카탈로그. 위임 후보(delegationModels)는 켠 목록 그대로다.
        selection: gatewaySelection ? { ...gatewaySelection, models: launchCatalog } : undefined,
        compactCeiling: gatewaySettings?.compactCeiling ?? null,
        compactHookToken: options.aiGateway.compactHookToken,
        ...(options.aiGateway.modHookToken ? { modHookToken: options.aiGateway.modHookToken } : {}),
      });
      if (options.modelSpeed) launchProfile = { ...launchProfile, env: { ...launchProfile.env, ...modelSpeedLaunchEnv(launchProfile.env, options.modelSpeed) } };
    }
    const workspaceHook = options.bindWorkspaceHook?.(options.sessionId, injectedProfile.session.sessionId);
    if (workspaceHook) {
      cleanupStack.push(() => workspaceHook.dispose());
      launchProfile = { ...launchProfile, env: { ...launchProfile.env, ...workspaceHook.env } };
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
  const launchEnv = stripConsoleInternalEnv(env);
  // Console Objective은 상위 Claude의 하위 세션이 아니라 독립 transcript를 갖는다.
  delete launchEnv.CLAUDE_CODE_CHILD_SESSION;
  return withTerminalCapabilities({
    ...launchEnv,
    ...(sessionId ? { FLEET_CONSOLE_SESSION_ID: sessionId, FLEET_CONSOLE_AGENT_CALL_SESSION_ID: sessionId, INIT_CWD: cwd, PWD: cwd } : {}),
    // 배경을 질의하지 않는 agent CLI를 위한 고전적 테마 극성 힌트 — spawn 시점 값에 고정된다.
    ...(colorScheme ? { COLORFGBG: colorScheme === "light" ? "0;15" : "15;0" } : {}),
  });
}
