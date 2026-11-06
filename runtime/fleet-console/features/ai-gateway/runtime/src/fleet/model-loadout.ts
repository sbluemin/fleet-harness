import { gatewayModelSummary, type GatewayModel, type GatewayReasoningEffort } from "../models.js";
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
 * 사령관·지휘관과 설정 화면이 공유하는 `candidates` 응답.
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
