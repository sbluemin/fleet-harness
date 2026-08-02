import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import type { OperationNode } from "@fleet-console/sdk/operations";

export const CARRIER_STREAMS_COMPANION_ID = "carrier-streams";
export const ANALYST_CHAT_COMPANION_ID = "session-analyst-chat";
export const ANALYST_ARTIFACTS_COMPANION_ID = "session-analyst-artifacts";
export const ANALYST_COMPANION_IDS = [ANALYST_CHAT_COMPANION_ID, ANALYST_ARTIFACTS_COMPANION_ID] as const;

const AGENT_COMPANION_IDS = [CARRIER_STREAMS_COMPANION_ID, ...ANALYST_COMPANION_IDS] as const;

// 이 두 Agent CLI id는 gateway/native doctrine 세션으로, 세션 토큰 발급 시점에 carrier 작업 도구가
// 거부된다 — carrier job/track이 귀속될 수 없어 이 패널은 그곳에서 영구히 비어 있다.
// 알 수 없거나 없는 cliId는 지원으로 간주해, 백필되지 않은 payload가 패널을 조용히 잃지 않게 한다.
const CARRIER_STREAMS_UNSUPPORTED_CLI_IDS: readonly string[] = ["claude-native", "claude-gateway"];

export function operationSupportsCarrierStreams(operation: OperationNode): boolean {
  const cliId = operation.payload.cliId;
  return typeof cliId !== "string" || !CARRIER_STREAMS_UNSUPPORTED_CLI_IDS.includes(cliId);
}

export function isCompanionPanelVisible(context: OperationRenderContext, companionId: string): boolean {
  return Boolean(context.companionsOpen) && !(context.hiddenCompanionPanelIds ?? []).includes(companionId);
}

export function countRemainingVisibleCompanionPanels(
  context: OperationRenderContext,
  hiddenIds: readonly string[],
): number {
  return AGENT_COMPANION_IDS
    .filter((id) => !hiddenIds.includes(id) && isCompanionPanelVisible(context, id))
    .length;
}

export function closeAnalystCompanionPanels(context: OperationRenderContext): void {
  if (!context.companionsOpen || !context.onSetCompanionPanelVisible) return;
  for (const id of ANALYST_COMPANION_IDS) {
    if (isCompanionPanelVisible(context, id)) context.onSetCompanionPanelVisible(id, false);
  }
  if (countRemainingVisibleCompanionPanels(context, ANALYST_COMPANION_IDS) === 0) {
    context.onRequestCompanions?.(false);
  }
}
