import { gatewayModelSummary, type GatewayModel, type GatewayReasoningEffort } from "../models.js";
import { toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";
import { exposedEffortLadder } from "./gateway-agents.js";
import type { GatewayAssignmentExposure } from "./routing-assignment.js";
import { evaluateGatewayCandidateModels, evaluateVisibleDelegationModels, type GatewayCandidatePressure } from "./routing-allowance.js";

export interface GatewayCandidate {
  readonly model: string;
  readonly fast: boolean;
  readonly efforts: readonly GatewayReasoningEffort[];
  readonly summary: string;
  readonly pressure: GatewayCandidatePressure;
}

/** `fallbackModels` 행. 후보 행에 `critical`과 남은 쿼터(%)가 더해진다 — 속도만 critical인 모델과 소진된 모델을 가른다. */
export interface GatewayFallbackModel extends Omit<GatewayCandidate, "pressure"> {
  readonly pressure: GatewayCandidatePressure | "critical";
  readonly remainingPercent?: number;
}

export interface GatewayCandidatesResponse {
  readonly candidates: readonly GatewayCandidate[];
  /**
   * `candidates`가 비었을 때만 싣는다(빈 배열은 보내지 않는다): 숨기지 않은 모든 위임 모델(`critical` 포함).
   * 지휘관 시작 확인만 읽고, 구성원 배정은 `candidates`만 본다.
   */
  readonly fallbackModels?: readonly GatewayFallbackModel[];
}

/** 선택 입력에 그대로 쓰는 정준 모델 ID. Claude는 별칭(`opus[1m]`), 나머지는 scoped ID(`codex--gpt-6.1-terra`). */
export function canonicalGatewayCandidateId(model: GatewayModel): string {
  return model.provider === "claude" ? toClaudeGatewayModelId(model) : model.id;
}

/**
 * 사령관·지휘관과 설정 화면이 공유하는 `candidates` 응답.
 *
 * `candidates` 행은 `model`·`fast`·`efforts`·`summary`·`pressure` 다섯 필드뿐이다(`fallbackModels`만 예외로 `remainingPercent`를 더한다). 제외 모델·원시 쿼터 창·리셋 시각·최근 배정·선호 근거·순위는
 * 싣지 않으며, 배열 순서 자체가 여유 순서다.
 * 쿼터 미상은 `ok`가 아닌 `"unknown"`으로 끝에 둔다.
 */
export function buildGatewayCandidates(
  exposure: Pick<GatewayAssignmentExposure, "delegationModels" | "effortExposure" | "quota">,
  now = Date.now(),
): GatewayCandidatesResponse {
  const row = ({ model, constraints }: ReturnType<typeof evaluateVisibleDelegationModels>[number]) => ({
    model: canonicalGatewayCandidateId(model),
    fast: model.fast === true,
    efforts: exposedEffortLadder(model.id, constraints.effortLadder, exposure.effortExposure),
    summary: gatewayModelSummary(model),
  });
  const candidates: GatewayCandidate[] = evaluateGatewayCandidateModels(exposure, now).map((entry) => ({
    ...row(entry),
    pressure: entry.allowance.pressure,
  }));
  if (candidates.length > 0) return { candidates };
  const fallbackModels: GatewayFallbackModel[] = evaluateVisibleDelegationModels(exposure, now).map((entry) => ({
    ...row(entry),
    pressure: entry.allowance.pressure,
    ...(entry.allowance.remainingPercent === undefined ? {} : { remainingPercent: entry.allowance.remainingPercent }),
  }));
  return fallbackModels.length > 0 ? { candidates, fallbackModels } : { candidates };
}
