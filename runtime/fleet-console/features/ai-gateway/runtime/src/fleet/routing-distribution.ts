import type { GatewayAssignmentExposure } from "./routing-assignment.js";
import type { GatewayProvider } from "../models.js";

/** 쿼터 관측 이후 확정된 배정을 보완한다. 병렬 판단은 같은 스냅샷을 읽을 수 있다. */
export class GatewayRoutingDistribution {
  private readonly providers = new Map<GatewayProvider, { observedAt?: number; assignments: number }>();

  snapshot(exposure: GatewayAssignmentExposure) {
    const providers: Partial<Record<GatewayProvider, { observedAt?: number; assignments: number }>> = {};
    for (const provider of new Set(exposure.delegationModels.map(model => model.provider))) {
      const observedAt = exposure.quota?.[provider]?.fetchedAt;
      const previous = this.providers.get(provider);
      // 캐시 재조회나 stale 반환이 아니라 더 새로운 관측이 들어온 경우에만 집계를 초기화한다.
      if (!previous || (observedAt !== undefined && (previous.observedAt === undefined || observedAt > previous.observedAt))) {
        this.providers.set(provider, { observedAt, assignments: 0 });
      }
      providers[provider] = { ...this.providers.get(provider)! };
    }
    return { providers };
  }

  record(provider: GatewayProvider, exposure: GatewayAssignmentExposure) {
    this.snapshot(exposure);
    const entry = this.providers.get(provider);
    if (entry) entry.assignments += 1;
  }
}
