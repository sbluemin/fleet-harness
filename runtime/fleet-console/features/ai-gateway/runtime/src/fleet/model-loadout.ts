import { buildGatewayModelConstraints, buildGatewayModelQuota, gatewayModelSummary, type GatewayModel, type GatewayReasoningEffort } from "../models.js";
import { delegationCandidateModels, visibleDelegationModels } from "./routing-assignment.js";
import { normalizeRoutingQuota, type RoutingQuota } from "./routing-quota.js";
import { gatewayModelContextWindow } from "../settings/index.js";
import { toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";
import { exposedEffortLadder } from "./gateway-agents.js";
import type { GatewayAssignmentExposure } from "./routing-assignment.js";
import { evaluateGatewayCandidateModels, type GatewayCandidatePressure } from "./routing-allowance.js";

export interface GatewayCandidate {
  readonly model: string;
  readonly fast: boolean;
  readonly efforts: readonly GatewayReasoningEffort[];
  readonly summary: string;
  readonly pressure: GatewayCandidatePressure;
}

export interface GatewayCandidatesResponse {
  readonly candidates: readonly GatewayCandidate[];
}

/** 선택 입력에 그대로 쓰는 정준 모델 ID. Claude는 별칭(`opus[1m]`), 나머지는 scoped ID(`codex--gpt-6.1-terra`). */
export function canonicalGatewayCandidateId(model: GatewayModel): string {
  return model.provider === "claude" ? toClaudeGatewayModelId(model) : model.id;
}

/**
 * 설정 화면에 기계적 규칙의 순서를 보여 주는 `candidates` 응답.
 *
 * 행은 `model`·`fast`·`efforts`·`summary`·`pressure` 다섯 필드뿐이다. 제외 모델·원시 쿼터 창·리셋 시각·최근 배정·선호 근거·순위는
 * 싣지 않으며, 배열 순서 자체가 여유 순서다.
 * 쿼터 미상은 `ok`가 아닌 `"unknown"`으로 끝에 둔다.
 */
export function buildGatewayCandidates(
  exposure: Pick<GatewayAssignmentExposure, "delegationModels" | "effortExposure" | "quota">,
  now = Date.now(),
): GatewayCandidatesResponse {
  const candidates: GatewayCandidate[] = evaluateGatewayCandidateModels(exposure, now).map(
    ({ model, constraints, allowance }) => ({
      model: canonicalGatewayCandidateId(model),
      fast: model.fast === true,
      efforts: exposedEffortLadder(model.id, constraints.effortLadder, exposure.effortExposure),
      summary: gatewayModelSummary(model),
      pressure: allowance.pressure,
    }),
  );
  return { candidates };
}

/** AI 판단 모델에 전달하는 공통 gateway_models 응답. 원시 쿼터·카탈로그 사본은 싣지 않는다. */
export function buildGatewayLoadout(exposure: GatewayAssignmentExposure, now = Date.now()) {
  const quotaPools: Record<string, RoutingQuota> = {};
  const preference = [...new Set(exposure.providerPriority ?? [])];
  const models = delegationCandidateModels(exposure, now)
    .map(model => {
      const constraints = buildGatewayModelConstraints(model);
      const efforts = exposedEffortLadder(model.id, constraints.effortLadder, exposure.effortExposure);
      const { quotaPool: pool } = buildGatewayModelQuota(model);
      quotaPools[pool] ??= normalizeRoutingQuota(exposure.quota?.[model.provider], constraints.quotaScope, now);
      const rank = preference.indexOf(model.provider);
      // 카탈로그 창을 그대로 싣는다 — Claude 가족 항목은 모두 1M이다.
      const contextWindow = gatewayModelContextWindow(model);
      return {
        modelId: canonicalGatewayCandidateId(model), provider: model.provider, quotaPool: pool, efforts,
        ...(rank < 0 ? {} : { preferenceRank: rank + 1 }),
        ...(contextWindow === null ? {} : { contextWindow }),
      };
    });
  return { quotaPools, models,
    ...(exposure.distribution ? { recentAssignments: exposure.distribution.snapshot(exposure) } : {}),
  };
}

/** 켠 모델을 설정 순서대로 공개한다. 쿼터 압박과 그 순서는 이 응답에 싣지 않는다. */
export function buildGatewayEnabledModels(exposure: Pick<GatewayAssignmentExposure, "delegationModels" | "effortExposure" | "quota">) {
  return { models: visibleDelegationModels(exposure).map(model => ({
    model: canonicalGatewayCandidateId(model), fast: model.fast === true,
    efforts: exposedEffortLadder(model.id, buildGatewayModelConstraints(model).effortLadder, exposure.effortExposure),
    summary: gatewayModelSummary(model),
  })) };
}
export type GatewayEnabledModelsResponse = ReturnType<typeof buildGatewayEnabledModels>;
