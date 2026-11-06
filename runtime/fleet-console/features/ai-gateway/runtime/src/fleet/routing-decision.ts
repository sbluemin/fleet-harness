import { fallbackGatewayRoutingAssignment } from "./routing-fallback.js";
import type {
  GatewayAssignmentDecision,
  GatewayAssignmentExposure,
  GatewayAssignmentRequest,
} from "./routing-assignment.js";

export interface GatewayRoutingBatchItem {
  readonly key: string;
}

/** 항목 하나의 배정. `model`이 없으면 자리를 주지 못한 것이다. */
export interface GatewayRoutingBatchDecision {
  readonly key: string;
  readonly model?: string;
  readonly effort?: string;
  readonly label: string;
  readonly because: string;
}

/**
 * 하위 에이전트·Workflow 단계의 코드 규칙 배정. AI 판단 모델을 호출하지 않는다.
 */
export function decideGatewayRoutingAssignment(
  request: GatewayAssignmentRequest,
  exposure: GatewayAssignmentExposure,
): GatewayAssignmentDecision {
  return fallbackGatewayRoutingAssignment(request, exposure);
}

/** 여러 항목을 같은 코드 규칙으로 차례로 배정한다. 공급자 누적 배정은 항목마다 쌓인다. */
export function decideGatewayRoutingBatch(
  items: readonly GatewayRoutingBatchItem[],
  exposure: GatewayAssignmentExposure,
): readonly GatewayRoutingBatchDecision[] {
  return items.map((item) => {
    const decision = fallbackGatewayRoutingAssignment({ surface: "agent", providerPlugin: "engine" }, exposure);
    return { key: item.key, ...decision };
  });
}
