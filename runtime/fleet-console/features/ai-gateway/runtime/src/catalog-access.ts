import { GATEWAY_MODELS, type GatewayModel, type GatewayProvider } from "./models.js";
import type { ProviderStatus } from "./quota/types.js";

/**
 * 메뉴·`/model`·수동 실행에 이 공급자 카탈로그를 보일지.
 *
 * `signed_out`·`not_connected`만 숨긴다. 상태를 아직 모르면(부재) 보인다 — 라우터의
 * fail-open과 같다. `expired`·`no_subscription`·`stale`·`error`·`ok`도 보인다.
 * 조회가 실패하거나 자격이 잠시 끊긴 것만으로 카탈로그를 비우면, 방금까지 고르던 모델을
 * 메뉴에서 잃는다. 실제로 호출이 거절되는 것은 업스트림의 몫이다.
 */
export function isProviderCatalogVisible(status: ProviderStatus | undefined): boolean {
  return status !== "signed_out" && status !== "not_connected";
}

/** 공급자 → 마지막으로 안 로그인 상태. 맵 자체가 없으면 전체를 모르는 것이다. */
export type ProviderStatusMap = Readonly<Partial<Record<GatewayProvider, ProviderStatus | undefined>>>;

/**
 * 로그인된 공급자의 카탈로그. `statuses` 부재는 미상 — 카탈로그 전체.
 * 맵은 있는데 그 공급자 키가 없으면 그 공급자도 미상으로 본다.
 */
export function visibleGatewayModels(statuses: ProviderStatusMap | undefined): readonly GatewayModel[] {
  if (statuses === undefined) return GATEWAY_MODELS;
  return GATEWAY_MODELS.filter((model) => isProviderCatalogVisible(statuses[model.provider]));
}
