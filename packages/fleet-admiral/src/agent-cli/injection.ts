import crypto from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GatewayModel } from "@dotobokuri/core-ai-gateway";

import { buildClaudeNativeArgs } from "./builders/claude.js";
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
  readonly resumeSessionId?: string;
  readonly withMarketplaceLock: AgentCliPluginMarketplaceLock;
  /**
   * claude-gateway 전용: AI Gateway에 노출된 모델로 `--agents` JSON을 조립한다.
   * 파일 영속화 없이 런치 인자로만 주입한다.
   */
  readonly gatewayExposedModels?: readonly GatewayModel[];
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
  if (!capability.enabled) {
    return profile;
  }

  const doctrine = resolveDoctrineFromCliId(profile.id);
  const endpoint = await options.dedicatedMcpSession.getEndpoint();
  const tokenLabel = options.mcpSessionLabel ?? `agent:${profile.id}:${crypto.randomUUID()}`;
  const tokens = await options.dedicatedMcpSession.issueSessionToken({
    cwd: profile.cwd,
    // native는 위키 MCP만 남긴다.
    includeTool: (toolId) => isHostSessionToolAllowed(toolId, doctrine),
    label: tokenLabel,
  });
  const mcpServers = buildAgentCliMcpServerConfigs(endpoint.servers, tokens);
  // native는 Admiral 시스템 프롬프트를 붙이지 않는다.
  const systemPrompt = doctrine === "native"
    ? undefined
    : options.buildSystemPrompt();
  const tempCleanups: Array<() => void> = [];
  try {
    const systemPromptFile = systemPrompt !== undefined && isClaudeFamilyProfile(profile)
      ? writeSystemPromptFile(profile.id, systemPrompt, (cleanup) => tempCleanups.push(cleanup))
      : undefined;
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
    const gatewayAgents = profile.id === "claude-gateway"
      ? {
        customAgents: buildGatewayCustomAgents(
          options.gatewayExposedModels ?? [],
          options.gatewayEffortExposure,
        ),
        skillOverrides: buildDisabledSkillOverrides(GATEWAY_DISABLED_CLAUDE_SKILLS),
      }
      : {};
    const context: AgentCliInjectionContext = {
      cliId: profile.id,
      mcpServers,
      pluginRoot: plugin.pluginRoot,
      pluginRoots: plugin.pluginRoots,
      resumeSessionId: options.resumeSessionId,
      systemPromptFile,
      ...gatewayAgents,
    };
    const injectedArgs = buildAgentCliArgs(capability.builderId, context);
    return {
      ...profile,
      args: mergeAgentCliArgs(profile, capability.builderId, context, injectedArgs),
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

function isClaudeFamilyProfile(profile: AgentCliProfile): boolean {
  return profile.id === "claude-native" || profile.id === "claude-gateway";
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
  builderId: "claude-native",
  context: AgentCliInjectionContext,
): string[] {
  return buildClaudeNativeArgs(context);
}

function mergeAgentCliArgs(
  profile: AgentCliProfile,
  _builderId: "claude-native",
  _context: AgentCliInjectionContext,
  injectedArgs: readonly string[],
): string[] {
  return [...profile.args, ...injectedArgs];
}

function createOnceCleanup(cleanup: () => void): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
}
