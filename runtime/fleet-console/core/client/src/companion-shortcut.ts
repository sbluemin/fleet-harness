import type { CompanionPanelDescriptor } from "@fleet-console/sdk/plugin";

export interface CompanionVisibilityChange {
  readonly id: string;
  readonly visible: boolean;
}

export interface CompanionShortcutToggle {
  readonly openLayer: boolean;
  readonly closeLayer: boolean;
  readonly visibilityChanges: readonly CompanionVisibilityChange[];
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

  const clusterIds = input.clusterIds ?? [input.targetId];
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
