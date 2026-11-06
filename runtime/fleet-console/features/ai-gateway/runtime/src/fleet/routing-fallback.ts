/** 하위 에이전트(Agent 도구)와 Workflow 단계에 사용하는 코드 규칙 배정. 추론 호출을 하지 않는다. */
import { FLEET_EXECUTION_AGENT_TYPE } from "@fleet-console/agent-runtime/fleet";

import type { GatewayReasoningEffort } from "../models.js";
import { toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";
import { compareModelAllowance, evaluateModelAllowance } from "./routing-allowance.js";
import {
  buildGatewayRoutingTable,
  routingTableIsEmpty,
  TIER_EFFORT,
  toRoutingLabel,
  type GatewayRoutingCandidate,
  type GatewayRoutingTier,
} from "./routing-table.js";
import {
  delegationCandidateModels,
  visibleDelegationModels,
  type GatewayAssignmentDecision,
  type GatewayAssignmentExposure,
  type GatewayAssignmentRequest,
} from "./routing-assignment.js";

/** 게이트웨이 모델 id의 접두사. 이 표식이 붙은 모델만 Fleet이 중계한다. */
const GATEWAY_PREFIX = "claude-gateway--";

/** 내장 agent를 제공하는 주체. 이 이름이 아니면 다른 플러그인의 정의다. */
const ENGINE_PLUGIN = "engine";

function isDelegable(modelId: string, exposure: GatewayAssignmentExposure, now: number): boolean {
  return delegationCandidateModels(exposure, now).some((model) => toClaudeGatewayModelId(model) === modelId);
}

/** 아무것도 바꾸지 않는 답. 세션 모델을 그대로 탄다. */
function inherit(because: string): GatewayAssignmentDecision {
  return { label: "session model", because };
}

function tierOf(request: GatewayAssignmentRequest): GatewayRoutingTier {
  if (request.surface === "stage") return "work";
  const alias = (request.requestedModel ?? "").toLowerCase();
  if (alias.includes("haiku")) return "scan";
  if (alias.includes("opus") || alias.includes("fable")) return "deep";
  if (alias.includes("sonnet")) return "work";
  if (request.subagentType === "Explore") return "scan";
  return "work";
}

export function requestTierEffort(request: GatewayAssignmentRequest): GatewayReasoningEffort {
  return TIER_EFFORT[tierOf(request)];
}

function describeAsk(request: GatewayAssignmentRequest): string {
  if (request.surface === "stage") return "not from the Agent tool";
  if (request.requestedModel !== undefined) return request.requestedModel;
  return request.subagentType === "Explore" ? "Explore" : "no model named";
}

export function fallbackGatewayRoutingAssignment(
  request: GatewayAssignmentRequest,
  exposure: GatewayAssignmentExposure,
  now = Date.now(),
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
  if (
    request.surface === "agent"
    && request.requestedModel !== undefined
    && request.requestedModel.startsWith(GATEWAY_PREFIX)
    && isDelegable(request.requestedModel, exposure, now)
  ) {
    return {
      model: request.requestedModel,
      ...(request.requestedEffort === undefined ? {} : { effort: request.requestedEffort }),
      label: toRoutingLabel(request.requestedModel),
      because: "already carried a gateway model",
    };
  }
  const visible = visibleDelegationModels(exposure);
  if (visible.length === 0) {
    return inherit("no gateway model is exposed for delegation");
  }
  const candidates = delegationCandidateModels(exposure, now);
  if (candidates.length === 0) {
    return inherit("every candidate allowance is critical");
  }
  const table = buildGatewayRoutingTable(candidates, {
    ...(exposure.effortExposure === undefined ? {} : { effortExposure: exposure.effortExposure }),
  });
  if (routingTableIsEmpty(table)) {
    return inherit("no gateway model is exposed for delegation");
  }
  const tier = tierOf(request);
  const blocked = new Set(request.unreachable ?? []);
  const reachable = table.tiers[tier].filter((candidate) => !blocked.has(candidate.model));
  if (reachable.length === 0) {
    return inherit("every candidate is unreachable this session");
  }
  const seat = pickSeat(reachable, exposure, now);
  if (!seat) {
    return inherit("every candidate allowance is critical");
  }
  if (exposure.providerLoad !== undefined) {
    exposure.providerLoad.set(seat.model.provider, (exposure.providerLoad.get(seat.model.provider) ?? 0) + 1);
  }
  if (exposure.distribution !== undefined) {
    exposure.distribution.record(seat.model.provider, exposure);
  }
  return {
    model: seat.model.model,
    ...(seat.model.effort === undefined ? {} : { effort: seat.model.effort }),
    label: seat.model.label,
    because: `${describeAsk(request)} → ${tier}${seat.suffix}`,
  };
}

/** 고른 좌석과, 원장에 덧붙일 한 마디. */
export interface Seat {
  readonly model: GatewayRoutingCandidate;
  readonly suffix: string;
}

/**
 * 코드 규칙으로 좌석을 고른다.
 *
 * - `critical`인 공급자는 제외하며, 전부가 `critical`이어도 `critical`로 폴백하지 않는다(`undefined`).
 * - 측정된 후보(`ok`, `elevated`)는 여유 순으로 앞선다.
 * - 쿼터 미상(`unknown`)은 측정된 후보 뒤에 놓이며 미상끼리는 여유 순위를 매기지 않는다.
 * - 같은 여유 순위(또는 `unknown`끼리)에서는 공급자 누적 배정(`providerLoad`)이 적은 쪽을 먼저 고르고, 같으면 목록 순서를 따른다.
 */
export function pickSeat(
  reachable: readonly GatewayRoutingCandidate[],
  exposure: GatewayAssignmentExposure,
  now = Date.now(),
): Seat | undefined {
  const usable = reachable
    .map((candidate, index) => ({
      candidate,
      index,
      allowance: evaluateModelAllowance(exposure.quota?.[candidate.provider], candidate, now),
    }))
    .filter((entry) => entry.allowance.pressure !== "critical");
  if (usable.length === 0) return undefined;
  const load = (provider: string) => exposure.providerLoad?.get(provider) ?? 0;
  usable.sort(
    (left, right) =>
      compareModelAllowance(left.allowance, right.allowance)
      || (load(left.candidate.provider) - load(right.candidate.provider))
      || (left.index - right.index),
  );
  return { model: usable[0]!.candidate, suffix: "" };
}
