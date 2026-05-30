import { buildCarrierSystemPrompt } from "../dispatch/tool-spec.js";
import type { CarrierConfig } from "../dispatch/types.js";
import type { BuildClaudeSubagentDefinitionsOptions, ClaudeSubagentDefinition } from "./types.js";

const NAME_SEGMENT_SPLIT_PATTERN = /[^a-zA-Z0-9]+/;

export function buildClaudeSubagentDefinitions(
  options: BuildClaudeSubagentDefinitionsOptions,
): ClaudeSubagentDefinition[] {
  const enabled = new Set(options.enabledCarrierIds);
  return options.carrierConfigs
    .filter((config) => enabled.has(config.id))
    .map((config) => buildClaudeSubagentDefinition(config));
}

export function buildClaudeSubagentDefinition(config: CarrierConfig): ClaudeSubagentDefinition {
  const definition: ClaudeSubagentDefinition = {
    carrierId: config.id,
    description: buildDescription(config),
    name: buildClaudeSubagentName(config.id),
    prompt: buildCarrierSystemPrompt(config.carrierMetadata),
  };
  return config.defaultModel
    ? { ...definition, model: config.defaultModel }
    : definition;
}

// 캐리어 ID를 Claude 서브에이전트 주입 이름(prefix 없는 Upper Camel Case)으로 변환한다.
export function buildClaudeSubagentName(carrierId: string): string {
  const pascalCaseName = carrierId
    .split(NAME_SEGMENT_SPLIT_PATTERN)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join("");
  return pascalCaseName || "Carrier";
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
