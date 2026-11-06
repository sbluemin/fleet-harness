import { fallbackGatewayRoutingAssignment } from "./routing-fallback.js";
import type {
  GatewayAssignmentDecision,
  GatewayAssignmentExposure,
  GatewayAssignmentRequest,
} from "./routing-assignment.js";

export interface GatewayRoutingBatchItem {
  readonly key: string;
  readonly prompt: string;
}

export interface GatewayRoutingBatchDecision {
  readonly key: string;
  readonly model?: string;
  readonly effort?: string;
  readonly label: string;
  readonly because: string;
  readonly fallback: boolean;
}

export interface GatewayRoutingDecisionOptions {
  readonly signal?: AbortSignal;
  readonly refreshExposure?: () => GatewayAssignmentExposure;
}

export interface GatewayRoutingBatchOptions {
  readonly signal?: AbortSignal;
  readonly refreshExposure?: () => GatewayAssignmentExposure;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" && reason !== "" ? reason : "Aborted");
  error.name = "AbortError";
  return error;
}

/**
 * 하위 에이전트·Workflow 단계의 코드 규칙 배정. Jev·AI 판단 모델을 호출하지 않는다.
 */
export function decideGatewayRoutingAssignment(
  request: GatewayAssignmentRequest,
  exposure: GatewayAssignmentExposure,
  options?: GatewayRoutingDecisionOptions,
): GatewayAssignmentDecision {
  if (options?.signal?.aborted) throw abortError(options.signal);
  const current = options?.refreshExposure?.() ?? exposure;
  return fallbackGatewayRoutingAssignment(request, current);
}

export function decideGatewayRoutingBatch(
  items: readonly GatewayRoutingBatchItem[],
  exposure: GatewayAssignmentExposure,
  options?: GatewayRoutingBatchOptions,
): readonly GatewayRoutingBatchDecision[] {
  if (items.length === 0) return [];
  if (options?.signal?.aborted) throw abortError(options.signal);
  const current = options?.refreshExposure?.() ?? exposure;
  return items.map((item) => {
    const decision = fallbackGatewayRoutingAssignment(
      { surface: "agent", prompt: item.prompt, providerPlugin: "engine" },
      current,
    );
    return {
      key: item.key,
      ...(decision.model === undefined ? {} : { model: decision.model }),
      ...(decision.effort === undefined ? {} : { effort: decision.effort }),
      label: decision.label,
      because: decision.because,
      fallback: decision.model === undefined,
    };
  });
}
