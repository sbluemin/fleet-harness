import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCarrierModelDefaults,
  buildClaudeSubagentDefinitions,
  createCarrierRuntime,
  getCarrierConfig,
  getEnabledCarrierSubagentIds,
  getRegisteredOrder,
  readCarrierAgentModeSnapshot,
  resolveAgentCliType,
  type CarrierConfig,
  type CarrierModelDefaults,
  type CarrierRegistry,
  type ClaudeSubagentDefinition,
} from "@dotobokuri/fleet-carriers";

interface SubagentSectionEntry {
  readonly carrierId: string;
  readonly displayName?: string;
  readonly nativeName: string;
}

interface ClaudeNativeSubagentPlan {
  readonly carrierConfigs: CarrierConfig[];
  readonly definitions: ClaudeSubagentDefinition[];
}

const FLEET_PLUGIN_NAME = "fleet";

export function runSubagentsContextHook(env: NodeJS.ProcessEnv): string {
  const fleetRoot = env.FLEET_ROOT ?? path.join(env.HOME ?? os.homedir(), ".fleet");
  if (!canReadCarrierState(path.join(fleetRoot, "carriers.json"))) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" } });
  }
  const carrierRuntime = createCarrierRuntime();
  carrierRuntime.store.initStore(fleetRoot);
  carrierRuntime.registerCarrierDefaults();
  const { carrierConfigs, definitions } = buildClaudeNativeSubagentPlan(carrierRuntime.registry);
  const configsById = new Map(carrierConfigs.map((config) => [config.id, config]));
  const additionalContext = buildSubagentsSection(definitions.map((definition) => ({
    carrierId: definition.carrierId,
    displayName: configsById.get(definition.carrierId)?.displayName,
    // Claude Code는 plugin 에이전트를 `<pluginName>:<name>`으로 등록하므로 호출명에 plugin 네임스페이스를 부착한다.
    nativeName: `${FLEET_PLUGIN_NAME}:${definition.name}`,
  }))) ?? "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
}

function buildClaudeNativeSubagentPlan(registry: CarrierRegistry): ClaudeNativeSubagentPlan {
  const carrierIds = getRegisteredOrder(registry);
  const carrierConfigs = carrierIds
    .map((carrierId) => getCarrierConfig(registry, carrierId))
    .filter((config): config is NonNullable<typeof config> => config !== undefined);
  const defaultsByCarrier = Object.fromEntries(
    carrierConfigs.map((config) => [config.id, buildHostCarrierModelDefaults(config)]),
  );
  const enabledCarrierIds = getEnabledCarrierSubagentIds(
    readCarrierAgentModeSnapshot(defaultsByCarrier),
    carrierIds,
  );
  return {
    carrierConfigs,
    definitions: buildClaudeSubagentDefinitions({ carrierConfigs, enabledCarrierIds }),
  };
}

function buildHostCarrierModelDefaults(config: CarrierConfig): CarrierModelDefaults {
  const cliType = resolveAgentCliType(config.id, config.defaultCliType);
  const cliDefaults = buildCarrierModelDefaults(config, cliType);
  return {
    cliType,
    ...(config.defaultAgentMode ? { defaultAgentMode: config.defaultAgentMode } : {}),
    ...(cliDefaults.defaultEffort ? { defaultEffort: cliDefaults.defaultEffort } : {}),
    ...(cliDefaults.defaultModel ? { defaultModel: cliDefaults.defaultModel } : {}),
  };
}

function buildSubagentsSection(entries: readonly SubagentSectionEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const lines = entries
    .map((entry) => {
      const label = entry.displayName ? `${entry.displayName} (${entry.carrierId})` : entry.carrierId;
      return `- ${label}: invoke as Claude native subagent \`${entry.nativeName}\`.`;
    })
    .join("\n");
  return `<fleet section="subagents">\n# Claude Native Subagents\n\nThe following Fleet carriers are exposed as Claude native subagents for this session:\n\n${lines}\n\nNative subagent calls return inline and do not emit \`[carrier:result]\`. Do not wait for a carrier job completion push after native invocation.\n\n\`carrier_dispatch\` remains available as a separate Fleet delegation path for carriers that are not invoked through the native subagent interface.\n</fleet>`;
}

function canReadCarrierState(filePath: string): boolean {
  try {
    return isReadableCarrierStateRoot(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return false;
  }
}

function isReadableCarrierStateRoot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const carriers = value.carriers;
  return carriers === undefined || isRecord(carriers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
