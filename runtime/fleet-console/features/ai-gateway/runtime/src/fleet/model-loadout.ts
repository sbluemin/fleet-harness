import { gatewayModelSummary, type GatewayModel, type GatewayReasoningEffort } from "../models.js";
import { toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";
import { exposedEffortLadder } from "./gateway-agents.js";
import type { GatewayAssignmentExposure } from "./routing-assignment.js";
import { evaluateGatewayCandidateModels, type GatewayCandidatePressure } from "./routing-allowance.js";

/**
 * 프롬프트 자문 초안 자리(임계값·선정 알고리즘 미기재).
 */
export const GATEWAY_CANDIDATES_TOOL_DESCRIPTION_DRAFT =
  "Current eligible models and allowed efforts, ordered by quota headroom (most first). Unknown pressure is unmeasured, not low pressure.";

export interface GatewayCandidate {
  readonly model: string;
  readonly efforts: readonly GatewayReasoningEffort[];
  readonly summary: string;
  readonly pressure: GatewayCandidatePressure;
  readonly resetsInSeconds?: number;
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
 * 제외 모델·원시 쿼터 창·최근 배정·선호 근거는 싣지 않으며, 배열 순서 자체가 여유 순서다.
 * 쿼터 미상은 `ok`가 아닌 `"unknown"`으로 끝에 둔다.
 */
export function buildGatewayCandidates(
  exposure: Pick<GatewayAssignmentExposure, "delegationModels" | "effortExposure" | "quota">,
  now = Date.now(),
): GatewayCandidatesResponse {
  const candidates: GatewayCandidate[] = evaluateGatewayCandidateModels(exposure, now).map(
    ({ model, constraints, allowance }) => ({
      model: canonicalGatewayCandidateId(model),
      efforts: exposedEffortLadder(model.id, constraints.effortLadder, exposure.effortExposure),
      summary: gatewayModelSummary(model),
      pressure: allowance.pressure,
      ...(allowance.resetsInSeconds === undefined ? {} : { resetsInSeconds: allowance.resetsInSeconds }),
    }),
  );
  return { candidates };
}

export const buildGatewayLoadout = buildGatewayCandidates;
