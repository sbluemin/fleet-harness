import crypto from "node:crypto";

import type { ExecutorSessionManager } from "@dotobokuri/fleet-mcp-server";
import {
  buildClaudeSubagentDefinitions,
  getCarrierConfig,
  getEnabledCarrierSubagentIds,
  getRegisteredOrder,
  readCarrierAgentModeSnapshot,
  resolveAgentCliType,
  type CarrierConfig,
  type CarrierModelDefaults,
  type CarrierRuntime,
  type ClaudeSubagentDefinition,
} from "@dotobokuri/fleet-carriers";

import { buildClaudeNativeArgs } from "./builders/claude.js";
import { buildCodexNativeArgs } from "./builders/codex.js";
import { getAgentCliInjectionCapability } from "./capabilities.js";
import { createAgentCliSessionPlugin, ensureCodexPluginRegistered } from "./session-plugin/index.js";
import type { CodexCommandResult, CodexPluginRegistrationCommand, SessionPluginMcpServerInput } from "./session-plugin/types.js";
import type { AgentCliInjectionContext, AgentCliProfile } from "./types.js";

export interface InjectAgentCliProfileOptions {
  readonly buildSystemPrompt: (injectTone: boolean) => string;
  readonly carrierRuntime: CarrierRuntime;
  readonly dedicatedMcpSession: ExecutorSessionManager;
  readonly replaceSystemPrompt?: boolean;
  readonly enableMetaphor?: boolean;
  readonly codexCommandRunner?: (command: CodexPluginRegistrationCommand) => CodexCommandResult;
  readonly onCleanup?: (cleanup: () => void) => void;
  readonly sessionPluginRootDir?: string;
}

type StartupNativeDefinitions =
  | { readonly host: "claude"; readonly definitions: ClaudeSubagentDefinition[] }
  | { readonly host: "none"; readonly definitions: [] };

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
  const startupDefinitions = buildStartupNativeDefinitions(profile.id, options.carrierRuntime);
  const tokenLabel = `agent:${profile.id}:${crypto.randomUUID()}`;
  const tokens = options.dedicatedMcpSession.issueSessionToken({ cwd: profile.cwd, label: tokenLabel });
  const mcpServers = buildAgentCliMcpServerConfigs(endpoint.servers, tokens);
  try {
    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: startupDefinitions.host === "claude" ? startupDefinitions.definitions : [],
      cliId: profile.id,
      cwd: profile.cwd,
      doctrine: options.buildSystemPrompt(injectTone),
      mcpServers,
      rootDir: options.sessionPluginRootDir,
    });
    const launchWarnings: string[] = [];
    if (plugin.codexRegistration !== undefined) {
      const registrationWarning = ensureCodexPluginRegistered(plugin.codexRegistration, {
        args: [],
        bin: profile.bin,
        cwd: profile.cwd,
        env: { ...profile.env, ...plugin.env },
      }, options.codexCommandRunner);
      if (registrationWarning !== undefined) {
        launchWarnings.push(`Fleet Codex plugin registration failed: ${registrationWarning}`);
      }
    }
    const cleanup = createOnceCleanup(() => {
      plugin.cleanup();
      options.dedicatedMcpSession.releaseSessionToken(tokenLabel);
    });
    options.onCleanup?.(cleanup);
    const context: AgentCliInjectionContext = {
      cliId: profile.id,
      pluginRoot: plugin.codexRegistration?.pluginRoot ?? plugin.pluginRoot,
    };
    const injectedArgs = buildAgentCliArgs(capability.builderId, context);
    return {
      ...profile,
      args: [...profile.args, ...injectedArgs],
      cleanup,
      env: { ...profile.env, ...plugin.env },
      launchWarnings: [...(profile.launchWarnings ?? []), ...launchWarnings],
    };
  } catch (error) {
    options.dedicatedMcpSession.releaseSessionToken(tokenLabel);
    throw error;
  }
}

function buildStartupNativeDefinitions(
  cliId: AgentCliProfile["id"],
  carrierRuntime: CarrierRuntime,
): StartupNativeDefinitions {
  const host = getNativeSubagentHost(cliId);
  if (host === "none") return { host, definitions: [] };
  const carrierIds = getRegisteredOrder(carrierRuntime.registry);
  const carrierConfigs = carrierIds
    .map((carrierId) => getCarrierConfig(carrierRuntime.registry, carrierId))
    .filter((config): config is NonNullable<typeof config> => config !== undefined);
  const defaultsByCarrier = Object.fromEntries(
    carrierConfigs.map((config) => [config.id, buildCarrierModelDefaults(config)]),
  );
  const enabledCarrierIds = getEnabledCarrierSubagentIds(
    readCarrierAgentModeSnapshot(defaultsByCarrier),
    carrierIds,
  );
  if (enabledCarrierIds.length === 0) return { host, definitions: [] } as StartupNativeDefinitions;
  if (host === "claude") {
    return { host, definitions: buildClaudeSubagentDefinitions({ carrierConfigs, enabledCarrierIds }) };
  }
  return { host, definitions: [] };
}

function getNativeSubagentHost(cliId: AgentCliProfile["id"]): StartupNativeDefinitions["host"] {
  if (cliId === "claude" || cliId === "claude-kimi") return "claude";
  return "none";
}

function buildAgentCliMcpServerConfigs(
  endpoints: readonly { readonly name: string; readonly url: string }[],
  tokens: readonly { readonly name: string; readonly token: string }[],
): SessionPluginMcpServerInput[] {
  return endpoints.map((endpoint) => {
    const token = tokens.find((entry) => entry.name === endpoint.name)?.token;
    if (!token) {
      throw new Error(`Dedicated MCP token missing for ${endpoint.name}`);
    }
    return {
      name: endpoint.name,
      endpointUrl: endpoint.url,
      token,
    };
  });
}

function buildCarrierModelDefaults(config: CarrierConfig): CarrierModelDefaults {
  const cliType = resolveAgentCliType(config.id, config.defaultCliType);
  const cliDefaults = resolvePersonaCliDefaults(config, cliType);
  return {
    cliType,
    ...(config.defaultAgentMode ? { defaultAgentMode: config.defaultAgentMode } : {}),
    ...(cliDefaults.defaultEffort ? { defaultEffort: cliDefaults.defaultEffort } : {}),
    ...(cliDefaults.defaultModel ? { defaultModel: cliDefaults.defaultModel } : {}),
  };
}

function resolvePersonaCliDefaults(
  config: CarrierConfig,
  cliType: ReturnType<typeof resolveAgentCliType>,
): { readonly defaultEffort?: string; readonly defaultModel?: string } {
  if (cliType === "claude") {
    return config.subagent?.byHost?.claude ?? {
      ...(config.defaultEffort ? { defaultEffort: config.defaultEffort } : {}),
      ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    };
  }
  return {};
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

function createOnceCleanup(cleanup: () => void): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
}
