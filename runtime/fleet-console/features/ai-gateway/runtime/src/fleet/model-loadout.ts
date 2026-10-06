import { buildGatewayModelConstraints } from "../models.js";
import { toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";
import { exposedEffortLadder } from "./gateway-agents.js";
import type { GatewayAssignmentExposure } from "./routing-assignment.js";
import { normalizeRoutingQuota, type RoutingQuota } from "./routing-quota.js";
import { gatewayModelContextWindow } from "../settings/index.js";

/** AI 모델과 Jev에 전달하는 공통 gateway_models 응답. 원시 쿼터·카탈로그 사본은 싣지 않는다. */
export function buildGatewayLoadout(exposure: GatewayAssignmentExposure, now = Date.now()) {
  const quotaPools: Record<string, RoutingQuota> = {};
  const preference = [...new Set(exposure.providerPriority ?? [])];
  const models = exposure.delegationModels
    .filter(model => exposure.quota?.[model.provider]?.status !== "signed_out")
    .map(model => {
      const constraints = buildGatewayModelConstraints(model);
      const efforts = exposedEffortLadder(model.id, constraints.effortLadder, exposure.effortExposure);
      const pool = `${model.provider}:${constraints.quotaScope ?? "shared"}`;
      quotaPools[pool] ??= normalizeRoutingQuota(exposure.quota?.[model.provider], constraints.quotaScope, now);
      const rank = preference.indexOf(model.provider);
      // Claude 200k 항목은 카탈로그에 창이 없다 — 다른 모델과 같은 정보를 싣도록 Claude Code 기본 좌표로 채운다.
      const contextWindow = gatewayModelContextWindow(model);
      return {
        modelId: toClaudeGatewayModelId(model), provider: model.provider, quotaPool: pool, efforts,
        ...(rank < 0 ? {} : { preferenceRank: rank + 1 }),
        ...(contextWindow === null ? {} : { contextWindow }),
        ...(constraints.capabilityClass === undefined ? {} : { capabilityClass: constraints.capabilityClass }),
      };
    });
  return { quotaPools, models,
    ...(exposure.distribution ? { recentAssignments: exposure.distribution.snapshot(exposure) } : {}),
  };
}
