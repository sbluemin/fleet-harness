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
 * 그것을 **목적지가 아니라 등급 신호로** 읽는다. `haiku`는 "Haiku를 써라"가 아니라 "싼 것으로
 * 충분하다"는 판단이고, 그 판단은 유효하다. 어느 모델이 그 등급인지는 호스트가 알 수 없고
 * (쿼터도 카탈로그도 모른다) Fleet이 안다. 그래서 등급은 호스트가, 모델은 여기가 정한다.
 *
 * 후보는 목록이지 모델 하나가 아니다. 앞에서부터 지금 쓸 수 있는 첫 번째를 고르고, 한 등급이
 * 통째로 막히면 아래 등급으로 흘러내린다 — 위임을 죽이는 것보다 낫다.
 */

import { buildGatewayModelConstraints, type GatewayEffortExposure, type GatewayModel, type GatewayProvider, type GatewayReasoningEffort } from "../models.js";
import { exposedEffortLadder } from "./gateway-agents.js";
import { toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";
import { GENERAL_PURPOSE_AGENT_PROMPT } from "./gateway-agents.js";

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
}

export interface GatewayRoutingTable {
  /**
   * 라우팅된 실행이 함께 싣는 실행 계약. 정체성을 등록하던 시절에는 정의의 프롬프트가
   * 날랐는데, 등록이 사라지면 내장 general-purpose의 기본값("search broadly")으로
   * 돌아가 버린다. 그 기본값을 버리는 것이 Fleet 정의의 존재 이유였으므로 표가 대신 나른다.
   */
  readonly prompt: string;
  /** 등급 → 시도 순서대로의 후보. 어느 등급도 비어 있지 않거나, 표 전체가 비어 있다. */
  readonly tiers: Readonly<Record<GatewayRoutingTier, readonly GatewayRoutingCandidate[]>>;
}

/** 위임 후보가 하나도 없는 표. 이 표를 받은 Mod는 아무것도 재작성하지 않는다. */
export const EMPTY_GATEWAY_ROUTING_TABLE: GatewayRoutingTable = {
  prompt: GENERAL_PURPOSE_AGENT_PROMPT,
  tiers: { scan: [], work: [], deep: [] },
};

/**
 * 배정을 끈 세션이 받는 표. 후보가 없는 것에 더해 실행 계약도 비운다 — 계약이 실리면 Mod가
 * 정체성을 올리고 위임이 그 정의로 흐르는데, Off의 뜻은 "하네스가 하던 대로"이지 "모델만
 * 그대로"가 아니다. 둘을 같은 표로 답하면 Off가 절반만 꺼진다.
 */
export const DISABLED_GATEWAY_ROUTING_TABLE: GatewayRoutingTable = {
  prompt: "",
  tiers: { scan: [], work: [], deep: [] },
};

/**
 * capabilityClass가 등급 소속을 정한다. 공급자가 스스로 밝힌 라인업 위치라, Fleet이 모델
 * 이름에서 추측하는 것보다 정확하고 카탈로그가 늘어도 따라온다.
 *
 * 라우팅 별칭(Cursor `auto`)은 class를 싣지 않는다 — 호출마다 다른 것이 답하므로 어떤 값도
 * 거짓이 된다. 그런 모델은 중간 등급으로 둔다: 모르면서 최상위라고 주장하지 않는다.
 */
function tierOf(model: GatewayModel): GatewayRoutingTier {
  switch (model.capabilityClass) {
    case "light": return "scan";
    case "flagship": return "deep";
    default: return "work";
  }
}

/**
 * 자기 등급에 후보가 없을 때 어디서 빌려 오는가.
 *
 * `work`만 위로 먼저 간다. 그 등급은 호스트가 **아무 말도 하지 않은** 경우이고, 침묵을
 * "싼 것으로 충분하다"로 읽으면 요청한 적 없는 품질 저하를 기본값으로 만든다. 로스터에
 * standard 계열이 하나도 없는 구성은 드물지 않으므로(라이트와 플래그십만 노출하는 경우)
 * 이 방향이 실제로 대부분의 위임이 가는 길이다.
 *
 * `scan`은 호스트가 싸도 된다고 명시한 경우라 아래에서 위로, `deep`은 비싼 쪽이 막혔을 때
 * 내려간다 — 위임을 죽이는 것보다 한 단 낮은 모델로 도는 편이 낫다.
 */
const FALLBACK: Readonly<Record<GatewayRoutingTier, readonly GatewayRoutingTier[]>> = {
  scan: ["scan", "work", "deep"],
  work: ["work", "deep", "scan"],
  deep: ["deep", "work", "scan"],
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
  const members = new Map<GatewayRoutingTier, GatewayModel[]>(
    GATEWAY_ROUTING_TIERS.map((tier) => [tier, []]),
  );
  for (const model of ordered) members.get(tierOf(model))?.push(model);
  const tiers = Object.fromEntries(GATEWAY_ROUTING_TIERS.map((tier) => {
    // 자기 등급을 먼저, 그다음 대체 순서. 같은 모델이 두 번 들어가지 않게 걸러낸다.
    //
    // 강도는 **요청한 등급**이 정한다. 모델이 어느 등급에 속하는지와 그 실행에 얼마나
    // 생각하게 할지는 다른 질문이다 — `work`가 빌려 온 flagship에 `deep`의 강도를 요청하면
    // 요청한 적 없는 비용을 쓴다.
    const seen = new Set<string>();
    const list: GatewayRoutingCandidate[] = [];
    for (const source of FALLBACK[tier]) {
      for (const model of members.get(source) ?? []) {
        const candidate = toCandidate(model, tier, options?.effortExposure);
        if (seen.has(candidate.model)) continue;
        seen.add(candidate.model);
        list.push(candidate);
      }
    }
    return [tier, Object.freeze(list)];
  })) as Record<GatewayRoutingTier, readonly GatewayRoutingCandidate[]>;
  return { prompt: GENERAL_PURPOSE_AGENT_PROMPT, tiers: Object.freeze(tiers) };
}

/**
 * 등급이 바라는 강도. 사다리가 이 값을 그대로 갖고 있지 않으면 가장 가까운 단을 쓴다 —
 * 사용자가 노출을 좁혀 두었을 때 요청을 사다리 밖으로 밀지 않기 위해서다.
 */
const TIER_EFFORT: Readonly<Record<GatewayRoutingTier, GatewayReasoningEffort>> = {
  scan: "low",
  work: "medium",
  deep: "high",
};

/** 카탈로그 사다리의 순서. 가까움은 이 축 위의 거리로 잰다. */
const EFFORT_ORDER: readonly GatewayReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

function nearestRung(
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
