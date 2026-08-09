import crypto from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GatewayModel } from "@dotobokuri/core-ai-gateway";

import { buildClaudeGatewayArgs } from "./builders/claude.js";
import { assertLaunchCommandLineBudget } from "./prompt.js";
import { resolveDoctrineFromCliId } from "../protocols/doctrine.js";
import { isHostSessionToolAllowed } from "../tools.js";
import { getAgentCliInjectionCapability } from "./capabilities.js";
import { buildGatewayCustomAgents, type GatewayEffortExposure } from "./gateway-agents.js";
import { GATEWAY_DISABLED_CLAUDE_SKILLS, buildDisabledSkillOverrides } from "./gateway-skills.js";
import { createAgentCliPlugin } from "./plugin/index.js";
import type {
  AgentCliInjectionContext,
  AgentCliMcpServerArg,
  AgentCliProfile,
  FleetHookExec,
} from "./types.js";

export interface InjectAgentCliProfileOptions {
  readonly buildSystemPrompt: () => string;
  readonly dataDir?: string;
  readonly dedicatedMcpSession: DedicatedMcpSession;
  readonly mcpSessionLabel?: string;
  readonly captureSessionHookExec?: FleetHookExec;
  // 턴 시작(UserPromptSubmit)·턴 종료(Stop) 신호 hook. host가 빌드해 주입한다.
  readonly turnStartHookExec?: FleetHookExec;
  readonly turnEndHookExec?: FleetHookExec;
  // 입력 대기 신호 hook. Claude plugin에 와이어링된다.
  readonly inputWaitingHookExec?: FleetHookExec;
  // 살아 있는 백그라운드 작업 보고(SubagentStop) hook. 턴 종료 시점의 같은 보고는 turnEndHookExec이 함께 실어 나른다.
  readonly backgroundReportHookExec?: FleetHookExec;
  // 작전명 자동 작명(UserPromptSubmit) hook. host가 빌드해 주입한다.
  readonly autoNameHookExec?: FleetHookExec;
  readonly onCleanup?: (cleanup: () => void) => void;
  readonly pluginRootDir?: string;
  readonly systemPromptMode?: "append" | "replace" | "off";
  readonly resumeSessionId?: string;
  readonly withMarketplaceLock: AgentCliPluginMarketplaceLock;
  /**
   * claude-gateway 전용: 위임 정체성으로 등록할 모델, 즉 AI Gateway 노출 집합에서 host 전용
   * 모델을 뺀 목록이다. `selection.models`를 넘기는 버그를 막기 위해 이름에 delegation을 명시한다.
   */
  readonly gatewayDelegationModels?: readonly GatewayModel[];
  /** claude-gateway 전용: 모델별로 정체성을 만들 강도. 항목이 없으면 그 모델의 사다리 전체. */
  readonly gatewayEffortExposure?: GatewayEffortExposure;
}

interface AgentCliPluginMarketplaceLock {
  <T>(target: string, fn: () => T | Promise<T>): T | Promise<T>;
}

interface DedicatedMcpSession {
  getEndpoint(): Promise<ExecutorEndpoint>;
  issueSessionToken(request: {
    readonly label: string;
    readonly cwd: string;
    readonly signal?: AbortSignal;
    readonly includeTool?: (toolId: string) => boolean;
  }): readonly ExecutorServerToken[] | Promise<readonly ExecutorServerToken[]>;
  releaseSessionToken(label: string): void;
}

interface ExecutorEndpoint {
  readonly servers: readonly { readonly name: string; readonly url: string }[];
}

interface ExecutorServerToken {
  readonly name: string;
  readonly token: string;
}

const SYSTEM_PROMPT_FILE_MODE = 0o600;

export async function injectAgentCliProfile(
  profile: AgentCliProfile,
  options: InjectAgentCliProfileOptions,
): Promise<AgentCliProfile> {
  const capability = getAgentCliInjectionCapability(profile.id);
  const doctrine = resolveDoctrineFromCliId(profile.id);
  const systemPromptMode = options.systemPromptMode ?? "append";
  const endpoint = await options.dedicatedMcpSession.getEndpoint();
  const tokenLabel = options.mcpSessionLabel ?? `agent:${profile.id}:${crypto.randomUUID()}`;
  const tokens = await options.dedicatedMcpSession.issueSessionToken({
    cwd: profile.cwd,
    // CLI doctrine에 허용된 호스트 도구만 세션 MCP에 노출한다.
    includeTool: (toolId) => isHostSessionToolAllowed(toolId, doctrine),
    label: tokenLabel,
  });
  const mcpServers = buildAgentCliMcpServerConfigs(endpoint.servers, tokens);
  const tempCleanups: Array<() => void> = [];
  try {
    const systemPromptFile = systemPromptMode === "off"
      ? undefined
      : writeSystemPromptFile(profile.id, options.buildSystemPrompt(), (cleanup) => tempCleanups.push(cleanup));
    const plugin = await createAgentCliPlugin({
      cliId: profile.id,
      doctrine,
      cwd: profile.cwd,
      dataDir: options.dataDir,
      rootDir: options.pluginRootDir,
      captureSessionHookExec: options.captureSessionHookExec,
      turnStartHookExec: options.turnStartHookExec,
      turnEndHookExec: options.turnEndHookExec,
      inputWaitingHookExec: options.inputWaitingHookExec,
      backgroundReportHookExec: options.backgroundReportHookExec,
      autoNameHookExec: options.autoNameHookExec,
      // 게이트웨이 정체성은 플러그인이 파일로 싣는다 — argv에는 이미 있던 플러그인 경로만 남는다.
      gatewayDelegationModels: options.gatewayDelegationModels,
      gatewayEffortExposure: options.gatewayEffortExposure,
      withMarketplaceLock: options.withMarketplaceLock,
    });
    const cleanup = createOnceCleanup(() => {
      plugin.cleanup();
      for (const tempCleanup of tempCleanups) {
        tempCleanup();
      }
      options.dedicatedMcpSession.releaseSessionToken(tokenLabel);
    });
    options.onCleanup?.(cleanup);
    const context: AgentCliInjectionContext = {
      cliId: profile.id,
      mcpServers,
      pluginRoot: plugin.pluginRoot,
      pluginRoots: plugin.pluginRoots,
      skillOverrides: buildDisabledSkillOverrides(GATEWAY_DISABLED_CLAUDE_SKILLS),
      systemPromptMode,
      resumeSessionId: options.resumeSessionId,
      systemPromptFile,
    };
    const injectedArgs = buildAgentCliArgs(capability.builderId, context);
    const mergedArgs = mergeAgentCliArgs(profile, capability.builderId, context, injectedArgs);
    // 명령줄 상한은 여기서만 판정할 수 있다 — 프롬프트 길이와 달리 주입 인자까지 합쳐진 뒤라야
    // 실제 값이 나온다. 프롬프트 없는 판본은 같은 병합을 한 번 더 돌려 만든다: 후미 인자라는
    // 위치 가정을 두면 병합 순서가 바뀌는 날 조용히 어긋난다.
    // 거부는 spawn 전에 끝나야 하므로 이 프로필이 만든 플러그인을 먼저 거둔다.
    try {
      assertLaunchCommandLineBudget({
        args: mergedArgs,
        argsWithoutPrompt: mergeAgentCliArgs(
          { ...profile, promptArgs: [] },
          capability.builderId,
          context,
          injectedArgs,
        ),
        bin: profile.bin,
        limit: profile.commandLineLimit,
      });
    } catch (error) {
      cleanup();
      throw error;
    }
    return {
      ...profile,
      args: mergedArgs,
      // 위치 인자는 이미 args 끝에 합쳐졌으므로 비운다. 남겨 두면 하류가 한 번 더 붙일 수 있다.
      promptArgs: [],
      cleanup,
    };
  } catch (error) {
    for (const tempCleanup of tempCleanups) {
      tempCleanup();
    }
    options.dedicatedMcpSession.releaseSessionToken(tokenLabel);
    throw error;
  }
}


function buildAgentCliMcpServerConfigs(
  endpoints: readonly { readonly name: string; readonly url: string }[],
  tokens: readonly { readonly name: string; readonly token: string }[],
): AgentCliMcpServerArg[] {
  return endpoints.map((endpoint) => {
    const token = tokens.find((entry) => entry.name === endpoint.name)?.token;
    if (!token) {
      throw new Error(`Dedicated MCP token missing for ${endpoint.name}`);
    }
    return {
      name: endpoint.name,
      endpointUrl: endpoint.url,
      bearerToken: token,
    };
  });
}

function writeSystemPromptFile(
  cliId: string,
  systemPrompt: string,
  onCleanup: (cleanup: () => void) => void,
): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), `fleet-${cliId}-`));
  onCleanup(() => rmBestEffort(tempDir));
  const filePath = path.join(tempDir, "system-prompt.md");
  writeFileSync(filePath, systemPrompt, { encoding: "utf8", flag: "wx", mode: SYSTEM_PROMPT_FILE_MODE });
  chmodBestEffort(filePath, SYSTEM_PROMPT_FILE_MODE);
  return filePath;
}

function chmodBestEffort(targetPath: string, mode: number): void {
  try {
    chmodSync(targetPath, mode);
  } catch {
    // POSIX 권한을 지원하지 않는 파일시스템에서는 best-effort로 둔다.
  }
}

function rmBestEffort(targetPath: string): void {
  try {
    rmSync(targetPath, { force: true, recursive: true });
  } catch {
    // 세션 정리는 파일이 이미 사라진 경우에도 전체 shutdown을 막지 않는다.
  }
}

function buildAgentCliArgs(
  builderId: "claude-gateway",
  context: AgentCliInjectionContext,
): string[] {
  return buildClaudeGatewayArgs(context);
}

function mergeAgentCliArgs(
  profile: AgentCliProfile,
  _builderId: "claude-gateway",
  _context: AgentCliInjectionContext,
  injectedArgs: readonly string[],
): string[] {
  // 위치 인자는 모든 플래그 뒤에 와야 한다 — `--mcp-config`가 가변 인자라 앞에 두면 삼켜진다.
  return [...profile.args, ...injectedArgs, ...(profile.promptArgs ?? [])];
}

function createOnceCleanup(cleanup: () => void): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
}
