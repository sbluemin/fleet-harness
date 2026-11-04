import { isProviderCatalogVisible } from "./model-family.js";
import { GATEWAY_MODELS, type GatewayModel, type GatewayProvider } from "./models.js";
import type { ProviderStatus } from "./quota/types.js";

export { isProviderCatalogVisible };

/** 공급자 → 마지막으로 안 로그인 상태. 맵 자체가 없으면 전체를 모르는 것이다. */
export type ProviderStatusMap = Readonly<Partial<Record<GatewayProvider, ProviderStatus | undefined>>>;

/**
 * 로그인된 공급자의 카탈로그. `statuses` 부재는 미상 — 카탈로그 전체.
 * 맵은 있는데 그 공급자 키가 없으면 그 공급자도 미상으로 본다.
 */
export function visibleGatewayModels(statuses: ProviderStatusMap | undefined): readonly GatewayModel[] {
  if (statuses === undefined) return GATEWAY_MODELS;
  return GATEWAY_MODELS.filter((model) => isProviderCatalogVisible(statuses[model.provider], model.provider));
}
