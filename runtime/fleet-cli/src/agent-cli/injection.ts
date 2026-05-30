import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExecutorSessionManager } from "@dotobokuri/fleet-mcp-server";
import {
  buildClaudeSubagentDefinitions,
  getCarrierConfig,
  getEnabledCarrierSubagentIds,
  getRegisteredOrder,
  readCarrierSubagentModeSnapshot,
  type CarrierRuntime,
  type ClaudeSubagentDefinition,
} from "@dotobokuri/fleet-carriers";

import { buildClaudeNativeArgs } from "./builders/claude.js";
import { buildCodexNativeArgs } from "./builders/codex.js";
import { getAgentCliInjectionCapability } from "./capabilities.js";
import type { AgentCliInjectionContext, AgentCliProfile } from "./types.js";

export interface InjectAgentCliProfileOptions {
  readonly buildSystemPrompt: (injectTone: boolean, claudeSubagents?: readonly ClaudeSubagentDefinition[]) => string;
  readonly carrierRuntime: CarrierRuntime;
  readonly dedicatedMcpSession: ExecutorSessionManager;
  readonly replaceSystemPrompt?: boolean;
  readonly enableMetaphor?: boolean;
}

export async function injectAgentCliProfile(
  profile: AgentCliProfile,
  options: InjectAgentCliProfileOptions,
): Promise<AgentCliProfile> {
  const capability = getAgentCliInjectionCapability(profile.id);
  if (!capability.enabled) {
    return profile;
  }

  const injectTone = options.enableMetaphor ?? false;
  const endpoint = await options.dedicatedMcpSession.getEndpoint();
  const tokens = options.dedicatedMcpSession.issueSessionToken({
    cwd: profile.cwd,
    label: `agent:${profile.id}`,
  });
  const claudeSubagents = buildStartupClaudeSubagents(profile.id, options.carrierRuntime);
  const systemPromptFile = writeSystemPromptFile(profile.id, options.buildSystemPrompt(injectTone, claudeSubagents));
  const context: AgentCliInjectionContext = {
    claudeSubagents,
    cliId: profile.id,
    mcpServers: buildAgentCliMcpServerConfigs(endpoint.servers, tokens),
    replaceSystemPrompt: options.replaceSystemPrompt ?? true,
    systemPromptFile,
  };
  const injectedArgs = buildAgentCliArgs(capability.builderId, context);
  return {
    ...profile,
    args: [...profile.args, ...injectedArgs],
    env: { ...profile.env },
  };
}

function buildStartupClaudeSubagents(
  cliId: AgentCliProfile["id"],
  carrierRuntime: CarrierRuntime,
): ClaudeSubagentDefinition[] {
  if (!isClaudeFamilyCli(cliId)) return [];
  const carrierIds = getRegisteredOrder(carrierRuntime.registry);
  const enabledCarrierIds = getEnabledCarrierSubagentIds(readCarrierSubagentModeSnapshot(), carrierIds);
  if (enabledCarrierIds.length === 0) return [];
  const carrierConfigs = carrierIds
    .map((carrierId) => getCarrierConfig(carrierRuntime.registry, carrierId))
    .filter((config): config is NonNullable<typeof config> => config !== undefined);
  return buildClaudeSubagentDefinitions({ carrierConfigs, enabledCarrierIds });
}

function isClaudeFamilyCli(cliId: AgentCliProfile["id"]): boolean {
  return cliId === "claude" || cliId === "claude-zai" || cliId === "claude-kimi";
}

function buildAgentCliMcpServerConfigs(
  endpoints: readonly { readonly name: string; readonly url: string }[],
  tokens: readonly { readonly name: string; readonly token: string }[],
): AgentCliInjectionContext["mcpServers"] {
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

function writeSystemPromptFile(cliId: string, systemPrompt: string): string {
  const filePath = path.join(os.tmpdir(), `fleet-${cliId}-system-prompt.md`);
  writeFileSync(filePath, systemPrompt, "utf8");
  return filePath;
}

function buildAgentCliArgs(
  builderId: "claude-native" | "codex-native",
  context: AgentCliInjectionContext,
): string[] {
  switch (builderId) {
    case "claude-native":
      return buildClaudeNativeArgs(context);
    case "codex-native":
      return buildCodexNativeArgs(context);
  }
}
