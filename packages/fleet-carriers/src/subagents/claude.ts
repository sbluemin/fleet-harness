import { buildCarrierSystemPrompt } from "../dispatch/tool-spec.js";
import type { CarrierConfig } from "../dispatch/types.js";
import type {
  BuildClaudeSubagentDefinitionsOptions,
  ClaudeSubagentColor,
  ClaudeSubagentDefinition,
} from "./types.js";

const NAME_SEGMENT_SPLIT_PATTERN = /[^a-zA-Z0-9]+/;
const CLAUDE_MAX_EFFORT = "xhigh";
export const CLAUDE_SUBAGENT_COLORS: Readonly<Record<string, ClaudeSubagentColor>> = {
  nimitz: "blue",
  vanguard: "cyan",
  chronicle: "green",
  genesis: "orange",
  kirov: "purple",
  ohio: "yellow",
  sentinel: "red",
  tempest: "pink",
};

export function buildClaudeSubagentDefinitions(
  options: BuildClaudeSubagentDefinitionsOptions,
): ClaudeSubagentDefinition[] {
  const enabled = new Set(options.enabledCarrierIds);
  return options.carrierConfigs
    .filter((config) => enabled.has(config.id))
    .map((config) => buildClaudeSubagentDefinition(config));
}

export function buildClaudeSubagentDefinition(config: CarrierConfig): ClaudeSubagentDefinition {
  const color = CLAUDE_SUBAGENT_COLORS[config.id];
  const effort = getClaudeEffort(config);
  const model = getClaudeModel(config);
  const definition: ClaudeSubagentDefinition = {
    carrierId: config.id,
    ...(color ? { color } : {}),
    description: buildDescription(config),
    ...(effort ? { effort } : {}),
    ...(model ? { model } : {}),
    name: buildClaudeSubagentName(config.id),
    prompt: buildCarrierSystemPrompt(config.carrierMetadata),
  };
  return definition;
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

function getClaudeEffort(config: CarrierConfig): string | undefined {
  const effort = config.subagent?.byHost?.claude?.defaultEffort ?? config.subagent?.defaultEffort;
  return clampClaudeEffort(effort);
}

function getClaudeModel(config: CarrierConfig): string | undefined {
  return config.subagent?.byHost?.claude?.defaultModel ?? config.subagent?.defaultModel;
}

function clampClaudeEffort(effort: string | undefined): string | undefined {
  return effort === "max" ? CLAUDE_MAX_EFFORT : effort;
}
