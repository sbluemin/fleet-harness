import { buildCarrierSystemPrompt } from "../dispatch/tool-spec.js";
import type { CarrierConfig } from "../dispatch/types.js";
import type { BuildCodexSubagentDefinitionsOptions, CodexSubagentRoleDefinition } from "./types.js";

const ROLE_KEY_ALLOWED_PATTERN = /[^a-zA-Z0-9_]+/g;
const LEGACY_ROLE_KEY_PREFIX = "fleet_";
const RESERVED_CODEX_ROLE_KEYS = new Set(["awaiter", "default", "explorer", "worker"]);

export function buildCodexSubagentDefinitions(
  options: BuildCodexSubagentDefinitionsOptions,
): CodexSubagentRoleDefinition[] {
  const enabled = new Set(options.enabledCarrierIds);
  const definitions = options.carrierConfigs
    .filter((config) => enabled.has(config.id))
    .map((config) => buildCodexSubagentDefinition(config, options.perCliSettingsByCarrierId?.[config.id]));
  assertUniqueCodexSubagentRoleKeys(definitions.map((definition) => definition.carrierId));
  return definitions;
}

export function buildCodexSubagentDefinition(
  config: CarrierConfig,
  override?: { readonly effort?: string; readonly model?: string },
): CodexSubagentRoleDefinition {
  const roleKey = buildCodexSubagentRoleKey(config.id);
  const description = buildDescription(config);
  const instructions = buildCarrierSystemPrompt(config.carrierMetadata);
  const model = override?.model ?? config.subagent?.byHost?.codex?.defaultModel;
  const modelReasoningEffort = override?.effort ?? config.subagent?.byHost?.codex?.defaultEffort;

  return {
    carrierId: config.id,
    description,
    instructions,
    roleKey,
    toml: {
      name: roleKey,
      description,
      ...(model ? { model } : {}),
      ...(modelReasoningEffort ? { model_reasoning_effort: modelReasoningEffort } : {}),
    },
  };
}

export function buildCodexSubagentRoleKey(carrierId: string): string {
  const sanitized = carrierId
    .replace(ROLE_KEY_ALLOWED_PATTERN, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase();
  const roleKey = (sanitized.startsWith(LEGACY_ROLE_KEY_PREFIX) ? sanitized.slice(LEGACY_ROLE_KEY_PREFIX.length) : sanitized) || "carrier";
  if (RESERVED_CODEX_ROLE_KEYS.has(roleKey)) {
    throw new Error(`Codex subagent role key is reserved: ${roleKey}`);
  }
  return roleKey;
}

export function assertUniqueCodexSubagentRoleKeys(carrierIds: readonly string[]): void {
  const carrierIdByRoleKey = new Map<string, string>();
  for (const carrierId of carrierIds) {
    const roleKey = buildCodexSubagentRoleKey(carrierId);
    const existingCarrierId = carrierIdByRoleKey.get(roleKey);
    if (existingCarrierId) {
      throw new Error(`Codex subagent role key collision: ${roleKey} (${existingCarrierId}, ${carrierId})`);
    }
    carrierIdByRoleKey.set(roleKey, carrierId);
  }
}

function buildDescription(config: CarrierConfig): string {
  const metadata = config.carrierMetadata;
  const parts = [
    config.displayName,
    metadata?.title,
    metadata?.summary,
    metadata?.whenToUse?.length ? `Use for: ${metadata.whenToUse.join(", ")}.` : undefined,
  ];
  return parts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" - ")
    .replace(/\s+/g, " ")
    .trim();
}
