import type { OperationNode } from "@fleet-console/sdk/operations";
import type { CompanionPanelDescriptor } from "@fleet-console/sdk/plugin";

// core가 플러그인보다 먼저 소비하는 키는 선언을 허용하면 도움말과 실제 디스패치가 어긋난다.
export const RESERVED_SHORTCUT_CODES: readonly string[] = [
  "KeyF", "KeyS", "KeyT", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape",
];

export interface CompanionVisibilityChange {
  readonly id: string;
  readonly visible: boolean;
}

export interface CompanionShortcutToggle {
  readonly openLayer: boolean;
  readonly closeLayer: boolean;
  readonly visibilityChanges: readonly CompanionVisibilityChange[];
}

export function availableCompanionPanels(
  companions: readonly CompanionPanelDescriptor[],
  operation: OperationNode,
): readonly CompanionPanelDescriptor[] {
  return companions.filter((companion) => companion.available?.(operation) ?? true);
}

export function usableCompanionShortcuts(
  companions: readonly CompanionPanelDescriptor[],
): readonly CompanionPanelDescriptor[] {
  const seenCodes = new Set<string>();
  return companions.filter((companion) => {
    const code = companion.shortcut?.code;
    if (!code || RESERVED_SHORTCUT_CODES.includes(code) || seenCodes.has(code)) return false;
    seenCodes.add(code);
    return true;
  });
}

export function resolveCompanionShortcutToggle(input: {
  readonly companions: readonly CompanionPanelDescriptor[];
  readonly targetId: string;
  readonly clusterIds?: readonly string[];
  readonly companionsOpen: boolean;
  readonly visibilityOverrides: Readonly<Record<string, boolean>>;
}): CompanionShortcutToggle {
  const target = input.companions.find((companion) => companion.id === input.targetId);
  const currentlyVisible = target
    ? companionVisible(target, input.companionsOpen, input.visibilityOverrides)
    : false;
  if (!currentlyVisible) {
    return {
      openLayer: !input.companionsOpen,
      closeLayer: false,
      visibilityChanges: [{ id: input.targetId, visible: true }],
    };
  }

  const clusterIds = [...new Set([input.targetId, ...(input.clusterIds ?? [])])];
  const clusterIdSet = new Set(clusterIds);
  const remainingVisible = input.companions.some((companion) =>
    !clusterIdSet.has(companion.id)
    && companionVisible(companion, input.companionsOpen, input.visibilityOverrides));
  return {
    openLayer: false,
    closeLayer: !remainingVisible,
    visibilityChanges: clusterIds.map((id) => ({ id, visible: false })),
  };
}

function companionVisible(
  companion: CompanionPanelDescriptor,
  companionsOpen: boolean,
  visibilityOverrides: Readonly<Record<string, boolean>>,
): boolean {
  return companionsOpen && (visibilityOverrides[companion.id] ?? companion.defaultHidden !== true);
}
