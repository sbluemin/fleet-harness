import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import type { OperationNode } from "@fleet-console/sdk/operations";

export const ANALYST_CHAT_COMPANION_ID = "session-analyst-chat";
export const ANALYST_ARTIFACTS_COMPANION_ID = "session-analyst-artifacts";
export const ANALYST_COMPANION_IDS = [ANALYST_CHAT_COMPANION_ID, ANALYST_ARTIFACTS_COMPANION_ID] as const;

const AGENT_COMPANION_IDS = ANALYST_COMPANION_IDS;

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
