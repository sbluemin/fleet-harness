/** AI 판단 실패·미설정·Workflow stage에 사용하는 로컬 fallback 정책. 사용자 선택 방식이 아니다. */
import { FLEET_EXECUTION_AGENT_TYPE } from "@fleet-console/agent-runtime/fleet";

import type { GatewayModel, GatewayEffortExposure, GatewayProvider } from "../models.js";
import { toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";
import type { GatewayQuotaSnapshot } from "./quota-snapshot.js";
import { modelPressure } from "./routing-allowance.js";
import {
  buildGatewayRoutingTable,
  routingTableIsEmpty,
  toRoutingLabel,
  type GatewayRoutingCandidate,
  type GatewayRoutingTier,
} from "./routing-table.js";

/** 게이트웨이 모델 id의 접두사. 이 표식이 붙은 모델만 Fleet이 중계한다. */
const GATEWAY_PREFIX = "claude-gateway--";

/** 내장 agent를 제공하는 주체. 이 이름이 아니면 다른 플러그인의 정의다. */
const ENGINE_PLUGIN = "engine";

import type { GatewayAssignmentRequest, GatewayAssignmentExposure, GatewayAssignmentDecision } from "./routing-assignment.js";
/** 이 모델을 위임에 줄 수 있는가. 호스트 전용과 노출되지 않은 모델은 줄 수 없다. */
function isDelegable(modelId: string, exposure: GatewayAssignmentExposure): boolean {
  return exposure.delegationModels.some((model) => toClaudeGatewayModelId(model) === modelId);
}

/** 아무것도 바꾸지 않는 답. 세션 모델을 그대로 탄다. */
function inherit(because: string): GatewayAssignmentDecision {
  return { label: "session model", because };
}

/**
 * 호스트가 보낸 것을 등급으로 읽는다.
 *
 * `requestedModel`은 **목적지가 아니라 등급 신호다.** Agent 도구가 말할 수 있는 모델은 Claude
 * 별칭뿐이라 목적지로 읽으면 어차피 전부 세션 계열로 간다. 호스트가 `haiku`라고 적은 것은
 * "Haiku를 써라"가 아니라 "싼 것으로 충분하다"는 판단이고, 그 판단은 유효하다 — 어느 모델이
 * 그 등급인지만 호스트가 모를 뿐이다.
 *
 * 이름을 아예 대지 않은 경우(실측상 대부분)가 곧 상속이고, 없애려는 것이 그것이다.
 */
function tierOf(request: GatewayAssignmentRequest): GatewayRoutingTier {
  // 스테이지는 작업 내용을 말해 주지 않는다. 등급을 추측하지 않고 기본 등급으로 보낸다.
  if (request.surface === "stage") return "work";
  const alias = (request.requestedModel ?? "").toLowerCase();
  if (alias.includes("haiku")) return "scan";
  if (alias.includes("opus") || alias.includes("fable")) return "deep";
  if (alias.includes("sonnet")) return "work";
  // 읽기 전용으로 넓게 훑는 실행. 긴 컨텍스트를 쓰고 추론 깊이는 덜 쓴다고 스스로 말한다.
  if (request.subagentType === "Explore") return "scan";
  return "work";
}

/** 호스트가 실제로 무엇을 말했는지, 판에 적을 만큼 짧게. */
function describeAsk(request: GatewayAssignmentRequest): string {
  if (request.surface === "stage") return "not from the Agent tool";
  if (request.requestedModel !== undefined) return request.requestedModel;
  return request.subagentType === "Explore" ? "Explore" : "no model named";
}

/**
 * 위임 하나를 어느 모델로 보낼지 정한다.
 *
 * 손대지 않는 것들을 먼저 걸러낸다. fork는 부모의 문맥과 모델을 물려받고 요청한 모델이 아예
 * 무시된다. 다른 플러그인이 등록한 agent는 그 정의가 모델을 소유하므로 남의 결정을 덮지
 * 않는다 — 단 Fleet 자신의 실행 정체성은 예외다. 엔진은 그것을 플러그인 소유로 보고하지만
 * 모델을 소유하는 쪽은 이 판정이고, 호스트가 그 이름을 불렀다는 이유로 배정을 건너뛰면
 * 목록에 보이는 이름 하나가 배정을 통째로 끄는 함정이 된다.
 */
export function fallbackGatewayRoutingAssignment(
  request: GatewayAssignmentRequest,
  exposure: GatewayAssignmentExposure,
): GatewayAssignmentDecision {
  if (request.fork === true) {
    return inherit("a fork inherits the parent's context and model");
  }
  const ours = request.subagentType === FLEET_EXECUTION_AGENT_TYPE;
  if (!ours && request.providerPlugin !== undefined && request.providerPlugin !== ENGINE_PLUGIN) {
    return {
      label: `${request.subagentType ?? "agent"} (own definition)`,
      because: "this agent's definition chooses its model",
    };
  }
  // 이미 게이트웨이 모델이 실려 있으면 누군가 이미 정한 것이다 — **스폰에 한해서.**
  //
  // 스테이지가 싣고 오는 모델은 아무도 고른 적이 없다. Workflow는 스폰을 지나지 않아 세션의
  // 모델을 그대로 물려받고, 그것을 결정으로 읽으면 두 가지가 한꺼번에 깨진다: 한 워크플로우의
  // 스테이지 전부가 같은 모델에 몰리고(배분이 아예 돌지 않는다), 사용자가 호스트 전용으로
  // 둔 모델이 위임 실행을 끌게 된다.
  //
  // 그리고 어느 표면이든 **배정 후보가 아닌 모델은 배정하지 않는다.** 호스트 전용은 "위임에
  // 주지 말라"는 뜻이고, 그 약속은 후보 목록을 거르는 것만으로는 지켜지지 않는다 — 실려 온
  // 모델을 그대로 돌려주는 길이 그 옆에 있으면 거기로 샌다.
  if (
    request.surface === "agent"
    && request.requestedModel !== undefined
    && request.requestedModel.startsWith(GATEWAY_PREFIX)
    && isDelegable(request.requestedModel, exposure)
  ) {
    return {
      model: request.requestedModel,
      ...(request.requestedEffort === undefined ? {} : { effort: request.requestedEffort }),
      label: toRoutingLabel(request.requestedModel),
      because: "already carried a gateway model",
    };
  }
  const table = buildGatewayRoutingTable(exposure.delegationModels, {
    ...(exposure.effortExposure === undefined ? {} : { effortExposure: exposure.effortExposure }),
    ...(exposure.providerPriority === undefined ? {} : { providerPriority: exposure.providerPriority }),
  });
  // 후보가 아예 없다는 것은 위임 모델이 노출되지 않았다는 뜻이다. 사용자가 모델을 전부
  // 호스트 전용으로 뒀다면 "위임은 내장 모델로 하라"는 명시적 선택이고, 뒤집지 않는다.
  if (routingTableIsEmpty(table)) {
    return inherit("no gateway model is exposed for delegation");
  }
  const tier = tierOf(request);
  const blocked = new Set(request.unreachable ?? []);
  const reachable = table.tiers[tier].filter((candidate) => !blocked.has(candidate.model));
  if (reachable.length === 0) {
    return inherit("every candidate is unreachable this session");
  }
  const seat = pickSeat(reachable, exposure);
  if (exposure.providerLoad !== undefined) {
    exposure.providerLoad.set(seat.model.provider, (exposure.providerLoad.get(seat.model.provider) ?? 0) + 1);
  }
  return {
    model: seat.model.model,
    ...(seat.model.effort === undefined ? {} : { effort: seat.model.effort }),
    label: seat.model.label,
    because: `${describeAsk(request)} → ${tier}${seat.suffix}`,
  };
}

/** 고른 좌석과, 원장에 덧붙일 한 마디. */
interface Seat {
  readonly model: GatewayRoutingCandidate;
  readonly suffix: string;
}

/**
 * 허용량이 허락하는 후보 중에서 지금 가장 덜 쓴 공급자를 고른다.
 *
 * 사용자가 소진 순서를 정해 뒀으면 그 순서가 이긴다 — 균등 분배를 사용자 의도로 대체하는
 * 것이 그 설정의 뜻이고, 압박 예측도 그 앞에서는 양보한다. 정하지 않았을 때만 회전한다.
 *
 * 회전은 카운터가 아니라 **부하 최솟값**으로 한다. 커서를 돌리면 중간에 한 공급자가 막혔을
 * 때 그 자리를 건너뛴 만큼 균형이 영구히 어긋나지만, 최솟값은 그 다음 배정에서 스스로
 * 되돌아온다. 같은 부하면 목록 순서가 가른다 — 그래야 같은 상태에서 같은 답이 나온다.
 */
export function pickSeat(
  reachable: readonly GatewayRoutingCandidate[],
  exposure: GatewayAssignmentExposure,
): Seat {
  if (exposure.providerPriority !== undefined && exposure.providerPriority.length > 0) {
    // 목록은 이미 그 순서로 정렬돼 있다. 머리가 곧 가장 먼저 쓸 공급자다.
    return { model: reachable[0] as GatewayRoutingCandidate, suffix: " · spend order" };
  }
  if (exposure.providerLoad === undefined) {
    return { model: reachable[0] as GatewayRoutingCandidate, suffix: "" };
  }
  const scored = reachable.map((candidate, index) => {
    const pressure = modelPressure(exposure.quota?.[candidate.provider], candidate);
    return { candidate, index, pressure };
  });
  // `critical`은 모든 대안이 더 나쁠 때만 간다. 전부 critical이면 위임을 죽이는 것보다 낫다.
  const usable = scored.filter((entry) => entry.pressure !== "critical");
  const pool = usable.length > 0 ? usable : scored;
  let best: (typeof pool)[number] | undefined;
  let bestLoad = Number.POSITIVE_INFINITY;
  for (const entry of pool) {
    // `elevated`는 금지가 아니라 가벼운 쪽으로 기울이라는 뜻이고, 읽지 못한 허용량은
    // 여유도 소진도 아니다. 둘 다 한 칸의 핸디캡으로 같게 취급한다 — 배제하지 않되
    // 먼저 집지도 않는다.
    const handicap = entry.pressure === "elevated" || entry.pressure === undefined ? 1 : 0;
    const load = (exposure.providerLoad.get(entry.candidate.provider) ?? 0) + handicap;
    if (load < bestLoad) {
      best = entry;
      bestLoad = load;
    }
  }
  const chosen = best ?? pool[0] as (typeof pool)[number];
  const suffix = usable.length === 0
    ? " · every allowance is critical"
    : chosen.pressure === "critical"
      ? " · critical"
      : "";
  return { model: chosen.candidate, suffix };
}
