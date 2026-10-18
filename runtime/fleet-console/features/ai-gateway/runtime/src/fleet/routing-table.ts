/**
 * routing-table — 위임 하나가 어느 게이트웨이 모델로 갈지 결정하는 표.
 *
 * 한때는 모델×강도마다 Agent 정체성을 하나씩 등록하고, 호스트가 그 이름을 골랐다.
 * 그 방식은 세 가지를 동시에 요구했다: 호스트가 로스터를 읽을 것, 이름을 정확히 적을 것,
 * 그리고 등록이 세션 시작에 고정되므로 세션이 시작된 뒤에는 노출이 바뀌어도 반영되지 않을 것.
 * 앞의 둘은 호스트의 협조에 기대는 것이고 — 협조하지 않으면 조용히 세션 모델을 상속한다 —
 * 마지막은 설정 변경이 재시작 전까지 먹지 않는다는 뜻이었다.
 *
 * 지금은 호스트가 이름을 대지 않는다. Agent 도구가 말할 수 있는 모델은 Claude 별칭뿐이고,
 * 그것을 **목적지가 아니라 추론 강도 신호로** 읽는다. `haiku`는 낮은 강도, `sonnet`은 중간 강도,
 * `opus`와 `fable`은 높은 강도를 요청한다. 모델은 그 신호와 별개로 노출 목록과 쿼터를 따라 정한다.
 *
 * 모든 등급은 같은 후보를 공급자 우선순위와 카탈로그 순서로 읽는다. 등급은 모델의 크기를
 * 분류하지 않고, 그 실행에 요청할 추론 강도만 정한다.
 */

import { buildGatewayModelConstraints, type GatewayModelConstraints, type GatewayEffortExposure, type GatewayModel, type GatewayProvider, type GatewayReasoningEffort } from "../models.js";
import { exposedEffortLadder } from "./gateway-agents.js";
import { toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";

/**
 * 위임의 등급. 호스트가 Agent 도구에 적은 모델 별칭과 agent 종류에서 읽어 낸다.
 *
 * 이름은 작업의 성격을 말하지 모델의 크기를 말하지 않는다 — 같은 등급이 로스터에 따라
 * 전혀 다른 모델로 해석되기 때문이다.
 */
export type GatewayRoutingTier = "scan" | "work" | "deep";

export const GATEWAY_ROUTING_TIERS: readonly GatewayRoutingTier[] = ["scan", "work", "deep"];

/** 한 등급의 후보 하나. 앞에 있을수록 먼저 시도한다. */
export interface GatewayRoutingCandidate {
  /** Claude Code가 보내는 철자 그대로의 모델 id. */
  readonly model: string;
  /**
   * 이 등급이 이 모델에 요청할 추론 강도. 강도를 지원하지 않는 모델에는 없다.
   *
   * 모델 id에 싣지 않고 따로 두는 이유: 강도는 요청 본문의 필드이고 `turn.step`이 그 필드를
   * 재작성해 준다(측정: `effort=medium`이 실려 오고 재작성이 받아들여진다). 한때는 게이트웨이
   * id에 `--effort-high` 접미를 붙여 나르려 했는데, 그러면 디스커버리가 광고하지 않는 철자를
   * 모델 해석 경로가 받아 주는지에 배정이 걸린다 — `[1m]` 표식이 활성 검사에서 떨어져 403을
   * 냈던 것과 같은 자리다. 필드로 나르면 그 위험이 통째로 없다.
   */
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
 * `exposed`는 반드시 **위임 모델**이어야 한다 — 사용자가 호스트 전용으로 표시한 모델은
 * `/model` 피커에는 남지만 위임 후보가 아니다. 그 선별은 `resolveAiGatewaySelection`이
 * 소유하고 여기서는 받은 목록을 그대로 믿는다.
 *
 * 등급 안의 순서는 `providerPriority`가 정한다. 사용자가 공급자 소진 순서를 정해 뒀는데
 * 여기서 자기 순서로 덮으면 그 설정이 무의미해진다. 지정이 없는 공급자는 카탈로그 순서로
 * 뒤에 붙는다.
 */
export function buildGatewayRoutingTable(
  exposed: readonly GatewayModel[],
  options?: {
    readonly effortExposure?: GatewayEffortExposure;
    readonly providerPriority?: readonly GatewayProvider[];
  },
): GatewayRoutingTable {
  if (exposed.length === 0) return EMPTY_GATEWAY_ROUTING_TABLE;
  const ordered = sortByProviderPriority(exposed, options?.providerPriority);
  const tiers = Object.fromEntries(GATEWAY_ROUTING_TIERS.map((tier) => {
    // 후보 순서는 모든 등급이 공유하고, 요청 강도만 등급에 맞춰 사다리에 매핑한다.
    const seen = new Set<string>();
    const list: GatewayRoutingCandidate[] = [];
    for (const model of ordered) {
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
  // 같은 거리면 낮은 쪽을 쓴다. 요청하지 않은 비용을 올리는 쪽으로 기울지 않는다.
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

function sortByProviderPriority(
  models: readonly GatewayModel[],
  priority: readonly GatewayProvider[] | undefined,
): readonly GatewayModel[] {
  if (priority === undefined || priority.length === 0) return models;
  const rank = new Map(priority.map((provider, index) => [provider, index]));
  // 지정되지 않은 공급자는 지정된 것들 뒤로. 같은 순위 안에서는 받은 순서를 지킨다.
  return [...models]
    .map((model, index) => ({ model, index, rank: rank.get(model.provider) ?? priority.length }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map((entry) => entry.model);
}

/** 이 표가 모델을 하나라도 싣고 있는가. */
export function routingTableIsEmpty(table: GatewayRoutingTable): boolean {
  return GATEWAY_ROUTING_TIERS.every((tier) => table.tiers[tier].length === 0);
}
