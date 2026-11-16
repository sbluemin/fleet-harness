import type { GatewayRoutingTier } from "./routing-table.js";

/**
 * 게이트웨이가 실제 모델을 고르는 가상 모델 id.
 *
 * 위임 실행 하나하나에 모델 id를 나눠 주던 자리를 대신한다. 자식의 `AgentDefinition.model`이
 * 이 값을 들고, 요청은 `body.model`로 그것을 그대로 보낸다(0.3.322 실측). 실제 배정은 요청
 * 시점의 노출을 읽어 게이트웨이가 정하므로, 노출·쿼터가 세션 중에 바뀌어도 재기동이 필요 없다.
 *
 * 도구 입력의 `model`로는 이 값을 실을 수 없다 — `Agent` 도구는 그 필드를
 * `sonnet|opus|haiku|fable`로 검증한다(0.3.322 실측: `updatedInput`도 같은 검증을 받는다).
 * 정의의 `model`은 자유 문자열이라 이 자리가 유일하게 열려 있다.
 */
export const FLEET_EXECUTION_VIRTUAL_MODEL = "claude-gateway--fleet--execute";

/** 자식이 실어 오는 표기. 컨텍스트 창 표식(`[1m]`)이 붙은 변형도 같은 모델로 본다. */
export function isExecutionVirtualModel(modelId: string): boolean {
  return modelId === FLEET_EXECUTION_VIRTUAL_MODEL || modelId === `${FLEET_EXECUTION_VIRTUAL_MODEL}[1m]`;
}

/** 자식 요청 헤더가 실행의 정체성을 싣는 자리. 부재·불일치는 배정 실패로 다룬다. */
export const CLAUDE_CODE_SESSION_ID_HEADER = "x-claude-code-session-id";
export const CLAUDE_CODE_AGENT_ID_HEADER = "x-claude-code-agent-id";

export interface ExecutionModelResolution {
  readonly modelId: string;
  readonly label?: string;
  readonly because?: string;
}

export interface ExecutionModelFailure {
  readonly error: string;
}

/** 배정에 필요한 사실. 게이트웨이는 이 밖의 것을 호스트에 묻지 않는다. */
export interface ExecutionModelRequest {
  readonly sessionId: string;
  readonly agentId: string;
}

export type GatewayRoutingTierName = GatewayRoutingTier;
