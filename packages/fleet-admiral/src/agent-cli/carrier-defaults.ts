import {
  buildCarrierModelDefaults,
  resolveAgentCliType,
  type CarrierConfig,
  type CarrierModelDefaults,
} from "@dotobokuri/fleet-carriers";

/**
 * 캐리어 페르소나 CLI 기본값 해석 — cliType을 해석한 뒤 fleet-carriers의
 * buildCarrierModelDefaults(SSoT)에 위임하고 호스트 측 CarrierModelDefaults로 조립한다.
 */
export function buildHostCarrierModelDefaults(config: CarrierConfig): CarrierModelDefaults {
  const cliType = resolveAgentCliType(config.id, config.defaultCliType);
  const cliDefaults = buildCarrierModelDefaults(config, cliType);
  return {
    cliType,
    ...(cliDefaults.defaultEffort ? { defaultEffort: cliDefaults.defaultEffort } : {}),
    ...(cliDefaults.defaultModel ? { defaultModel: cliDefaults.defaultModel } : {}),
  };
}
