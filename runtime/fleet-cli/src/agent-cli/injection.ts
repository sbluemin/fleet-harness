import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExecutorSessionManager } from "@dotobokuri/fleet-mcp-server";
import {
  buildClaudeSubagentDefinitions,
  buildCodexSubagentDefinitions,
  ensureCodexSubagentRoleFile,
  getCarrierConfig,
  getEnabledCarrierSubagentIds,
  getAgentCliSelection,
  getRegisteredOrder,
  readCarrierAgentModeSnapshot,
  readCarriersSnapshot,
  resolveAgentCliType,
  type CarrierConfig,
  type CarrierModelDefaults,
  type CarrierRuntime,
  type ClaudeSubagentDefinition,
  type CodexSubagentRoleDefinition,
  type AgentCliSelection,
} from "@dotobokuri/fleet-carriers";

import { buildClaudeNativeArgs } from "./builders/claude.js";
import { buildCodexNativeArgs } from "./builders/codex.js";
import { getAgentCliInjectionCapability } from "./capabilities.js";
import type { AgentCliInjectionContext, AgentCliProfile } from "./types.js";

export interface InjectAgentCliProfileOptions {
  readonly buildSystemPrompt: (injectTone: boolean, nativeSubagents?: readonly ClaudeSubagentDefinition[] | readonly CodexSubagentRoleDefinition[]) => string;
  readonly carrierRuntime: CarrierRuntime;
  readonly dedicatedMcpSession: ExecutorSessionManager;
  readonly replaceSystemPrompt?: boolean;
  readonly enableMetaphor?: boolean;
  readonly onCleanup?: (cleanup: () => void) => void;
}

type StartupNativeSubagents =
  | { readonly host: "claude"; readonly definitions: ClaudeSubagentDefinition[] }
  | { readonly host: "codex"; readonly definitions: CodexSubagentRoleDefinition[] }
  | { readonly host: "none"; readonly definitions: [] };

const SYSTEM_PROMPT_FILE_MODE = 0o600;

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
  const startupSubagents = buildStartupNativeSubagents(profile.id, options.carrierRuntime);
  const codexSubagents = startupSubagents.host === "codex"
    ? startupSubagents.definitions.map((definition) => ensureCodexSubagentRoleFile(definition)).filter((role): role is NonNullable<typeof role> => role !== undefined)
    : [];
  const systemPromptFile = writeSystemPromptFile(
    profile.id,
    options.buildSystemPrompt(injectTone, startupSubagents.definitions),
    options.onCleanup,
  );
  const context: AgentCliInjectionContext = {
    claudeSubagents: startupSubagents.host === "claude" ? startupSubagents.definitions : [],
    cliId: profile.id,
    codexSubagents,
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

function buildStartupNativeSubagents(
  cliId: AgentCliProfile["id"],
  carrierRuntime: CarrierRuntime,
): StartupNativeSubagents {
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
  if (enabledCarrierIds.length === 0) return { host, definitions: [] } as StartupNativeSubagents;
  if (host === "claude") {
    return { host, definitions: buildClaudeSubagentDefinitions({ carrierConfigs, enabledCarrierIds }) };
  }
  const codexSettings = buildEffectiveCodexSettingsByCarrierId(carrierConfigs, enabledCarrierIds);
  return {
    host,
    definitions: buildCodexSubagentDefinitions({
      carrierConfigs,
      enabledCarrierIds,
      agentCliByCarrierId: codexSettings,
    }),
  };
}

function getNativeSubagentHost(cliId: AgentCliProfile["id"]): StartupNativeSubagents["host"] {
  if (cliId === "claude" || cliId === "claude-kimi") return "claude";
  if (cliId === "codex") return "codex";
  return "none";
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

function writeSystemPromptFile(
  cliId: string,
  systemPrompt: string,
  onCleanup: InjectAgentCliProfileOptions["onCleanup"],
): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), `fleet-${cliId}-`));
  const filePath = path.join(tempDir, "system-prompt.md");
  writeFileSync(filePath, systemPrompt, { encoding: "utf8", flag: "wx", mode: SYSTEM_PROMPT_FILE_MODE });
  chmodBestEffort(filePath, SYSTEM_PROMPT_FILE_MODE);
  onCleanup?.(() => rmBestEffort(tempDir));
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

function buildEffectiveCodexSettingsByCarrierId(
  carrierConfigs: readonly CarrierConfig[],
  enabledCarrierIds: readonly string[],
): Record<string, AgentCliSelection | undefined> {
  const enabled = new Set(enabledCarrierIds);
  const codexCliTypesByCarrier = Object.fromEntries(
    carrierConfigs
      .filter((config) => enabled.has(config.id))
      .map((config) => [config.id, buildCarrierModelDefaults(config)]),
  );
  const snapshot = readCarriersSnapshot(codexCliTypesByCarrier);
  return Object.fromEntries(
    carrierConfigs
      .filter((config) => enabled.has(config.id))
      .map((config) => {
        const cliType = resolveAgentCliType(config.id, config.defaultCliType);
        const selection = snapshot.carriers[config.id]?.agentCli.codex;
        const settings = cliType === "codex" && selection
          ? toAgentCliSelection(selection)
          : getAgentCliSelection(config.id, "codex", snapshot);
        return [config.id, settings];
      }),
  );
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
  if (cliType === "codex") return config.subagent?.byHost?.codex ?? {};
  if (cliType === "claude") {
    return config.subagent?.byHost?.claude ?? {
      ...(config.defaultEffort ? { defaultEffort: config.defaultEffort } : {}),
      ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    };
  }
  return {};
}

function toAgentCliSelection(selection: { readonly effort?: string; readonly model: string }): AgentCliSelection {
  return {
    model: selection.model,
    ...(selection.effort ? { effort: selection.effort } : {}),
  };
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
