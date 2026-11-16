import { clampReasoningEffort, type ReasoningEffort } from "../canonical/index.js";
import {
  GATEWAY_MODELS,
  findGatewayModel,
  upstreamModelId,
  type GatewayModel,
  type GatewayReasoningEffort,
} from "../models.js";
import type { AcpThoughtLevel } from "./contract.js";

/**
 * 고른 카탈로그 모델과 강도가 agy에서 어떻게 열려야 하는지.
 *
 * agy 1.5.9 실측(2026-11-16): `session/new`의 `availableModels`는 강도가 새겨진 id(`gemini-4-argon-medium`,
 * `claude-opus-5-5-high`)로 오지만 `configOptions.model`의 값은 기본 id(`gemini-4-argon`, `claude-opus-5-5`)이고
 * 강도는 별도 `thought_level`(low/medium/high)이다. 그래서 모델은 기본 id로 고르고, 계정에 그 모델이 있는지는
 * 기본 id 접두 일치로 판정한다. Gemini와 Claude가 같은 규칙을 쓴다.
 */
export interface AcpModelSelection {
  /** 카탈로그 id(`antigravity--gemini-4-argon`). 실패 메시지에 쓴다. */
  readonly catalogId: string;
  /** `configOptions.model`에 줄 기본 id(`gemini-4-argon`). */
  readonly baseId: string;
  /** `thought_level`에 줄 값. 사다리 위쪽(`xhigh`)은 `high`로 내려 맞춘다. */
  readonly thoughtLevel: AcpThoughtLevel;
}

const RUNG_SUFFIX = /-(?:low|medium|high|xhigh)$/;

function thoughtLevel(effort: ReasoningEffort): AcpThoughtLevel {
  if (effort === "low" || effort === "minimal") return "low";
  if (effort === "medium") return "medium";
  return "high";
}

export function resolveAcpModelSelection(
  modelId: string,
  requestedEffort?: AcpThoughtLevel | GatewayReasoningEffort,
  catalog: readonly GatewayModel[] = GATEWAY_MODELS,
): AcpModelSelection {
  const model = findGatewayModel(modelId, catalog)
    ?? catalog.find((candidate) => candidate.provider === "antigravity" && upstreamModelId(candidate) === modelId);
  if (!model || model.provider !== "antigravity") {
    throw new Error(`Not an Antigravity catalog model: ${modelId}`);
  }
  const wireId = upstreamModelId(model);
  const baseId = wireId.replace(RUNG_SUFFIX, "");
  if (!model.effort.supported) {
    return { catalogId: model.id, baseId, thoughtLevel: "medium" };
  }
  // 강도를 말하지 않으면 세션 기본(high)을 사다리 안으로 내려 맞춘다.
  const effort = clampReasoningEffort(requestedEffort ?? "high", model.effort.levels, wireId) as GatewayReasoningEffort;
  return { catalogId: model.id, baseId, thoughtLevel: thoughtLevel(effort) };
}

/** 계정이 이 기본 id의 모델을 주는가. 기본 id 자체이거나 그 강도 id(`<base>-<rung>`)면 있다. 닮은 모델로 바꾸지 않는다. */
export function isAcpModelAvailable(baseId: string, availableModelIds: readonly string[]): boolean {
  return availableModelIds.some((id) => id === baseId || (id.startsWith(`${baseId}-`) && RUNG_SUFFIX.test(id) && id.replace(RUNG_SUFFIX, "") === baseId));
}
