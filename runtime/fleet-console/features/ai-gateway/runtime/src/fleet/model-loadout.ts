import { buildGatewayModelQuota } from "../models.js";
import { toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";
import { exposedEffortLadder } from "./gateway-agents.js";
import type { GatewayAssignmentExposure } from "./routing-assignment.js";
import { evaluateGatewayCandidateModels } from "./routing-allowance.js";
import { normalizeRoutingQuota, type RoutingQuota } from "./routing-quota.js";
import { gatewayModelContextWindow } from "../settings/index.js";

/** 코드 규칙(critical 제외, 여유 순, 미상 끝 무순위)을 통과한 후보 목록. */
export function buildGatewayLoadout(exposure: GatewayAssignmentExposure, now = Date.now()) {
  const quotaPools: Record<string, RoutingQuota> = {};
  const models = evaluateGatewayCandidateModels(exposure, now)
    .map(({ model, constraints, allowance }) => {
      const efforts = exposedEffortLadder(model.id, constraints.effortLadder, exposure.effortExposure);
      const { quotaPool: pool } = buildGatewayModelQuota(model);
      quotaPools[pool] ??= normalizeRoutingQuota(exposure.quota?.[model.provider], constraints.quotaScope, now);
      const contextWindow = gatewayModelContextWindow(model);
      return {
        modelId: toClaudeGatewayModelId(model),
        provider: model.provider,
        quotaPool: pool,
        efforts,
        pressure: allowance.pressure,
        ...(allowance.resetsInSeconds === undefined ? {} : { resetsInSeconds: allowance.resetsInSeconds }),
        ...(contextWindow === null ? {} : { contextWindow }),
      };
    });
  return {
    quotaPools,
    models,
    ...(exposure.distribution ? { recentAssignments: exposure.distribution.snapshot(exposure) } : {}),
  };
}
