import {
  buildCarrierModelDefaults,
  buildClaudeSubagentDefinitions,
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

export interface ClaudeNativeSubagentPlan {
  readonly carrierConfigs: CarrierConfig[];
  readonly definitions: ClaudeSubagentDefinition[];
  readonly enabledCarrierIds: string[];
}

/**
 * 캐리어 페르소나 CLI 기본값 해석 — cliType을 해석한 뒤 fleet-carriers의
 * buildCarrierModelDefaults(SSoT)에 위임하고 호스트 측 CarrierModelDefaults로 조립한다.
 */
export function buildHostCarrierModelDefaults(config: CarrierConfig): CarrierModelDefaults {
  const cliType = resolveAgentCliType(config.id, config.defaultCliType);
  const cliDefaults = buildCarrierModelDefaults(config, cliType);
  return {
    cliType,
    ...(config.defaultAgentMode ? { defaultAgentMode: config.defaultAgentMode } : {}),
    ...(cliDefaults.defaultEffort ? { defaultEffort: cliDefaults.defaultEffort } : {}),
    ...(cliDefaults.defaultModel ? { defaultModel: cliDefaults.defaultModel } : {}),
  };
}

/**
 * registry 등록 순서 기준으로 carrierConfigs → defaultsByCarrier → enabledCarrierIds →
 * definitions 파이프라인을 한 번에 계산한다 (Claude native subagent 구성 공용 경로).
 */
export function buildClaudeNativeSubagentPlan(registry: CarrierRegistry): ClaudeNativeSubagentPlan {
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
    enabledCarrierIds,
  };
}
