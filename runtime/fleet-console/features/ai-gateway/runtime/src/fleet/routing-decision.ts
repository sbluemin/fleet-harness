import { fallbackGatewayRoutingAssignment } from "./routing-fallback.js";
import type {
  GatewayAssignmentDecision,
  GatewayAssignmentExposure,
  GatewayAssignmentRequest,
} from "./routing-assignment.js";

/**
 * 하위 에이전트·Workflow 단계의 코드 규칙 배정. AI 판단 모델을 호출하지 않는다.
 */
export function decideGatewayRoutingAssignment(
  request: GatewayAssignmentRequest,
  exposure: GatewayAssignmentExposure,
): GatewayAssignmentDecision {
  return fallbackGatewayRoutingAssignment(request, exposure);
}
