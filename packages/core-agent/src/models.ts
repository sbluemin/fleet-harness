/**
 * agent/models — provider/model ID codec 및 조회 유틸리티.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import {
  getEffort,
  getProviderModels,
  type CliType,
} from "@dotobokuri/core-unified-agent";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export type SelectableThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

export const SELECTABLE_THINKING_LEVELS = new Set<SelectableThinkingLevel>(["low", "medium", "high", "xhigh", "max"]);

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** CLI 타입에 속한 모델 목록 반환 */
export function getCliModels(cli: CliType): readonly { id: string; name: string }[] {
  const provider = getProviderModels(cli);
  return provider.models.map((m) => ({ id: m.modelId, name: m.name }));
}

/** CLI/model 기준 effort 레벨 목록 반환 (미지원 시 null) */
export function getCliEffortLevels(cli: CliType, modelId?: string): readonly string[] | null {
  const provider = getProviderModels(cli);
  const resolvedModel = modelId ?? provider.defaultModel;
  const modelEffort = getEffort(cli, resolvedModel);
  return modelEffort.supported ? modelEffort.levels : null;
}
