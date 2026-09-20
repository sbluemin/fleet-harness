import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import type { OperationNode } from "@fleet-console/sdk/operations";

/* 아티팩트는 더 이상 별도 컴패니언이 아니다 — 드로어 안의 모드다. Analyst 컴패니언은 하나뿐이다. */
export const ANALYST_CHAT_COMPANION_ID = "session-analyst-chat";
export const ANALYST_COMPANION_IDS = [ANALYST_CHAT_COMPANION_ID] as const;

export function isCompanionPanelVisible(context: OperationRenderContext, companionId: string): boolean {
  return Boolean(context.companionsOpen) && !(context.hiddenCompanionPanelIds ?? []).includes(companionId);
}

export function closeAnalystCompanionPanels(context: OperationRenderContext): void {
  if (!context.companionsOpen || !context.onSetCompanionPanelVisible) return;
  // Analyst만 걷는다. 함께 열어 둔 브라우저까지 내리는 것은 이 함수의 약속이 아니고,
  // 마지막 패널이었다면 호스트가 companion 배치를 알아서 벗어난다.
  for (const id of ANALYST_COMPANION_IDS) {
    if (isCompanionPanelVisible(context, id)) context.onSetCompanionPanelVisible(id, false);
  }
}
