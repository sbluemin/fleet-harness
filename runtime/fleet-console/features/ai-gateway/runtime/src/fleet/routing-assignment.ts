/** 위임 요청 계약과 실행 소유권 가드. 모델 판단은 routing-decision이 담당한다. */
import { toRoutingLabel } from "./routing-table.js";
import { FLEET_EXECUTION_AGENT_TYPE } from "@fleet-console/agent-runtime/fleet";
import type { GatewayModel, GatewayEffortExposure, GatewayProvider, GatewayReasoningEffort } from "../models.js";
import { toClaudeGatewayModelId } from "../downstream/harness/claude-code/discovery.js";
import type { GatewayQuotaSnapshot } from "./quota-snapshot.js";
export type GatewayAssignmentSurface = "agent" | "stage";
export interface GatewayAssignmentRequest {
  readonly surface: GatewayAssignmentSurface;
  /**
   * 호스트가 이 위임에 발행한 원문. 판단 모델에 전달한다.
   * 훅이 상한을 넘겨 보내지 않으며, 여기서도 저장하지 않는다.
   */
  readonly prompt?: string;
  /** Agent 도구가 붙인 짧은 설명. 원장이 그대로 쓴다. */
  readonly description?: string;
  /** 호스트가 적은 모델. 명시된 Gateway 모델은 존중한다. */
  readonly requestedModel?: string;
  /**
   * 호스트가 적은 추론 강도.
   *
   * `agent` 표면에서는 **항상 없다** — `agent.spawn` 이벤트에 그 필드가 존재하지 않아 호스트가
   * 말할 방법이 없다. `stage`에서는 실려 온다. 계약을 한쪽에 맞춰 지우지 않고 둘 다 담되,
   * 부재를 정직하게 싣는다.
   */
  readonly requestedEffort?: string;
  /** 호스트가 부른 agent 종류. */
  readonly subagentType?: string;
  /** 부모의 문맥과 모델을 그대로 물려받는 실행인가. */
  readonly fork?: boolean;
  /** 이 agent를 누가 제공하는가. 내장은 `engine`. */
  readonly providerPlugin?: string;
  /** 이 세션이 배정했다가 거절당한 모델. 다시 고르지 않는다. */
  readonly unreachable?: readonly string[];
}

/** Console이 돌려주는 답. `model`이 없으면 훅은 아무것도 재작성하지 않는다. */
export interface GatewayAssignmentDecision {
  /** 실어 줄 모델 id. 없으면 세션 모델을 그대로 탄다. */
  readonly model?: string;
  /** 함께 요청할 추론 강도. 강도를 지원하지 않는 모델에는 없다. */
  readonly effort?: string;
  /** 이 실행이 무엇으로 도는지, 사람이 읽는 이름. */
  readonly label: string;
  /** 왜 그것이 됐는지 한 줄. */
  readonly because: string;
}


export type GatewayDelegationRoutingMode = "jev" | "model";
export interface GatewayAssignmentExposure {
  readonly delegationRoutingEnabled: boolean;
  readonly delegationRoutingMode?: GatewayDelegationRoutingMode;
  readonly delegationModels: readonly GatewayModel[];
  readonly effortExposure?: GatewayEffortExposure;
  readonly providerPriority?: readonly GatewayProvider[];
  readonly quota?: GatewayQuotaSnapshot;
  readonly providerLoad?: Map<string, number>;
}
export interface GatewayRoutingCandidate {
  readonly model: string;
  readonly label: string;
  readonly provider: GatewayProvider;
  readonly effort?: GatewayReasoningEffort;
}
export function unassigned(because: string): GatewayAssignmentDecision {
  return { label: "session model", because };
}
export function isDelegableGatewayModel(id: string, exposure: GatewayAssignmentExposure): boolean {
  return exposure.delegationModels.some(model => toClaudeGatewayModelId(model) === id);
}
export function guardGatewayRoutingAssignment(request: GatewayAssignmentRequest, exposure: GatewayAssignmentExposure): GatewayAssignmentDecision | undefined {
  if (request.fork) return unassigned("a fork inherits the parent's context and model");
  if (request.subagentType !== FLEET_EXECUTION_AGENT_TYPE && request.providerPlugin !== undefined && request.providerPlugin !== "engine") {
    return unassigned("this agent's definition chooses its model");
  }
  if (request.surface === "agent" && request.requestedModel?.startsWith("claude-gateway--") && isDelegableGatewayModel(request.requestedModel, exposure)) {
    return { model: request.requestedModel, label: toRoutingLabel(request.requestedModel),
      ...(request.requestedEffort === undefined ? {} : { effort: request.requestedEffort }),
      because: "already carried a gateway model" };
  }
  return undefined;
}
const MAX_PROMPT_CHARS = 64 * 1024;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 훅이 보낸 본문을 판정이 읽는 사실로 옮긴다. 본문은 신뢰할 수 없는 입력이므로 아는 필드만
 * 꺼내고 모르는 것은 버린다.
 */
export function parseGatewayAssignmentRequest(body: unknown): GatewayAssignmentRequest {
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const prompt = asString(raw.prompt);
  const unreachable = Array.isArray(raw.unreachable)
    ? raw.unreachable.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    surface: raw.surface === "stage" ? "stage" : "agent",
    ...(prompt === undefined ? {} : { prompt: prompt.slice(0, MAX_PROMPT_CHARS) }),
    ...(asString(raw.description) === undefined ? {} : { description: asString(raw.description) as string }),
    ...(asString(raw.requestedModel) === undefined ? {} : { requestedModel: asString(raw.requestedModel) as string }),
    ...(asString(raw.requestedEffort) === undefined ? {} : { requestedEffort: asString(raw.requestedEffort) as string }),
    ...(asString(raw.subagentType) === undefined ? {} : { subagentType: asString(raw.subagentType) as string }),
    ...(raw.fork === true ? { fork: true } : {}),
    ...(asString(raw.providerPlugin) === undefined ? {} : { providerPlugin: asString(raw.providerPlugin) as string }),
    ...(unreachable === undefined ? {} : { unreachable }),
  };
}
