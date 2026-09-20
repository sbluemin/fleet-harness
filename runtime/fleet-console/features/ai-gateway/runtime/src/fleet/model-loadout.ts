import { createHash } from "node:crypto";
import { GATEWAY_BENCHMARKS_STAMP, GATEWAY_MODELS_UPDATED_AT, buildGatewayModelConstraints, type GatewayModel } from "../models.js";
import { deriveQuotaWindowRisk } from "../quota/pressure.js";
import { toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";
import { exposedEffortLadder } from "./gateway-agents.js";
import type { GatewayAssignmentExposure } from "./routing-assignment.js";

/** 이전 gateway_models 응답의 모델·벤치마크·쿼터 계약. 선택 정책은 적용하지 않는다. */
export function buildGatewayLoadout(exposure: GatewayAssignmentExposure) {
  const placed = exposure.delegationModels.map((model: GatewayModel) => {
    const { provider, ...catalog } = buildGatewayModelConstraints(model);
    const effortLadder = exposedEffortLadder(model.id, catalog.effortLadder, exposure.effortExposure);
    const { benchmark, ...constraints } = catalog;
    return {
      provider,
      entry: {
        modelId: toClaudeGatewayModelId(model),
        constraints: {
          ...constraints,
          effortLadder,
          ...(benchmark && effortLadder.includes(benchmark.effort) ? { benchmark } : {}),
        },
      },
    };
  });
  const providers = Object.fromEntries([...new Set(placed.map(row => row.provider))]
    .filter(provider => exposure.quota?.[provider]?.status !== "signed_out")
    .map(provider => {
      const quota = exposure.quota?.[provider];
      const at = quota?.fetchedAt ?? Date.now();
      return [provider, {
        quota: quota ? {
          ...quota,
          ...(quota.windows ? { windows: quota.windows.map(window => ({
            ...window, ...deriveQuotaWindowRisk(window, at),
          })) } : {}),
        } : { status: "unsupported" },
        models: placed.filter(row => row.provider === provider).map(row => row.entry),
      }];
    }));
  const priority = [...new Set(exposure.providerPriority ?? [])]
    .filter(provider => Object.hasOwn(providers, provider))
    .map((provider, index) => ({ provider, rank: index + 1 }));
  const material = [GATEWAY_MODELS_UPDATED_AT, GATEWAY_BENCHMARKS_STAMP,
    JSON.stringify(placed), JSON.stringify(priority)].join("\n");
  return {
    revision: createHash("sha256").update(material).digest("hex").slice(0, 12),
    catalogUpdatedAt: GATEWAY_MODELS_UPDATED_AT,
    providers,
    ...(priority.length ? { quotaConsumptionPriority: {
      source: "user_settings", rankMeaning: "1_consumes_first",
      withinQualityBand: true, overridesQuotaPressure: true,
      fallback: "observed_failure_after_retry", providers: priority,
    } } : {}),
  };
}
