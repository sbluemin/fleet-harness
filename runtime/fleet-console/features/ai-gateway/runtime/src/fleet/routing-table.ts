/**
 * routing-table — 위임 하나가 어느 게이트웨이 모델로 갈지 결정하는 표.
 *
 * 호스트가 이름을 대지 않는다. Agent 도구가 말할 수 있는 모델은 Claude 별칭뿐이고,
 * 그것을 **목적지가 아니라 추론 강도 신호로** 읽는다. `haiku`는 낮은 강도, `sonnet`은 중간 강도,
 * `opus`와 `fable`은 높은 강도를 요청한다. 모델은 그 신호와 별개로 노출 목록과 쿼터 여유를 따라 정한다.
 */

import { buildGatewayModelConstraints, type GatewayModelConstraints, type GatewayEffortExposure, type GatewayModel, type GatewayProvider, type GatewayReasoningEffort } from "../models.js";
import { exposedEffortLadder } from "./gateway-agents.js";
import { toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";

/**
 * 위임의 등급. 호스트가 Agent 도구에 적은 모델 별칭과 agent 종류에서 읽어 낸다.
 */
export type GatewayRoutingTier = "scan" | "work" | "deep";

export const GATEWAY_ROUTING_TIERS: readonly GatewayRoutingTier[] = ["scan", "work", "deep"];

/** 한 등급의 후보 하나. 앞에 있을수록 먼저 시도한다. */
export interface GatewayRoutingCandidate {
  /** Claude Code가 보내는 철자 그대로의 모델 id. */
  readonly model: string;
  /** 이 등급이 이 모델에 요청할 추론 강도. 강도를 지원하지 않는 모델에는 없다. */
  readonly effort?: GatewayReasoningEffort;
  /** 사람이 읽는 이름. 판과 알림줄이 그대로 쓴다. */
  readonly label: string;
  /** 이 모델이 비용을 무는 공급자. 배정이 공급자 사이를 고르게 돌릴 때 이 값으로 센다. */
  readonly provider: GatewayProvider;
  /** 공급자가 풀을 나눠 재는 경우 이 모델을 묶는 풀. 허용량을 읽을 창을 이 값이 고른다. */
  readonly quotaScope?: GatewayModelConstraints["quotaScope"];
}

export interface GatewayRoutingTable {
  /** 등급 → 시도 순서대로의 후보. 어느 등급도 비어 있지 않거나, 표 전체가 비어 있다. */
  readonly tiers: Readonly<Record<GatewayRoutingTier, readonly GatewayRoutingCandidate[]>>;
}

/** 위임 후보가 하나도 없는 표. 이 표를 받은 판정은 아무것도 배정하지 않는다. */
export const EMPTY_GATEWAY_ROUTING_TABLE: GatewayRoutingTable = {
  tiers: { scan: [], work: [], deep: [] },
};

/**
 * 이 세션의 라우팅 표를 짓는다.
 *
 * `exposed`는 위임 후보 목록이며, 받은 순서를 유지한 채 등급별 요청 강도만 각 모델의 노출 사다리에 매핑한다.
 */
export function buildGatewayRoutingTable(
  exposed: readonly GatewayModel[],
  options?: {
    readonly effortExposure?: GatewayEffortExposure;
    readonly providerPriority?: readonly GatewayProvider[];
  },
): GatewayRoutingTable {
  if (exposed.length === 0) return EMPTY_GATEWAY_ROUTING_TABLE;
  const tiers = Object.fromEntries(GATEWAY_ROUTING_TIERS.map((tier) => {
    const seen = new Set<string>();
    const list: GatewayRoutingCandidate[] = [];
    for (const model of exposed) {
      const candidate = toCandidate(model, tier, options?.effortExposure);
      if (seen.has(candidate.model)) continue;
      seen.add(candidate.model);
      list.push(candidate);
    }
    return [tier, Object.freeze(list)];
  })) as Record<GatewayRoutingTier, readonly GatewayRoutingCandidate[]>;
  return { tiers: Object.freeze(tiers) };
}

/**
 * 등급이 바라는 강도. 사다리가 이 값을 그대로 갖고 있지 않으면 가장 가까운 단을 쓴다 —
 * 사용자가 노출을 좁혀 두었을 때 요청을 사다리 밖으로 밀지 않기 위해서다.
 */
export const TIER_EFFORT: Readonly<Record<GatewayRoutingTier, GatewayReasoningEffort>> = {
  scan: "low",
  work: "medium",
  deep: "high",
};

/** 카탈로그 사다리의 순서. 가까움은 이 축 위의 거리로 잰다. */
export const EFFORT_ORDER: readonly GatewayReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function nearestRung(
  ladder: readonly GatewayReasoningEffort[],
  target: GatewayReasoningEffort,
): GatewayReasoningEffort | undefined {
  if (ladder.length === 0) return undefined;
  const wanted = EFFORT_ORDER.indexOf(target);
  return [...ladder].sort((a, b) => {
    const da = Math.abs(EFFORT_ORDER.indexOf(a) - wanted);
    const db = Math.abs(EFFORT_ORDER.indexOf(b) - wanted);
    return da - db || EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b);
  })[0];
}

function toCandidate(
  model: GatewayModel,
  tier: GatewayRoutingTier,
  exposure: GatewayEffortExposure | undefined,
): GatewayRoutingCandidate {
  const modelId = toClaudeGatewayModelId(model);
  const constraints = buildGatewayModelConstraints(model);
  const effort = constraints.effortSupported
    ? nearestRung(exposedEffortLadder(model.id, constraints.effortLadder, exposure), TIER_EFFORT[tier])
    : undefined;
  const label = toRoutingLabel(modelId);
  return {
    model: modelId,
    ...(effort === undefined ? {} : { effort }),
    label: effort === undefined ? label : `${label} @${effort}`,
    provider: model.provider,
    ...(constraints.quotaScope === undefined ? {} : { quotaScope: constraints.quotaScope }),
  };
}

/** `claude-gateway--xai--grok-4.6` → `xai/grok-4.6`. 게이트웨이 모델이 아니면 그대로. */
export function toRoutingLabel(modelId: string): string {
  const stripped = modelId.startsWith("claude-gateway--") ? modelId.slice("claude-gateway--".length) : modelId;
  return stripped.replace("--", "/");
}

/** 이 표가 모델을 하나라도 싣고 있는가. */
export function routingTableIsEmpty(table: GatewayRoutingTable): boolean {
  return GATEWAY_ROUTING_TIERS.every((tier) => table.tiers[tier].length === 0);
}
