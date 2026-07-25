import { getSnapshot as getCanvasSnapshot, setState as setCanvasState, setViewport } from "./canvas/canvas-store.js";
import { applyRailPreset, getRailStoreSnapshot } from "./rail/rail-store.js";
import { getSideBarStatusAxis, setSideBarStatusAxis } from "./sidebar/operations-side-bar-store.js";
import type { WorkspacePresetApplyResult, WorkspacePresetLayout } from "./types.js";

export function captureWorkspacePresetLayout(
  canvas: ReturnType<typeof getCanvasSnapshot>,
  operationIds: readonly string[],
): WorkspacePresetLayout {
  const validOperationIds = new Set(operationIds);
  const operationGeometries = Object.fromEntries(
    Object.entries(canvas.operations)
      .filter(([operationId]) => validOperationIds.has(operationId))
      .map(([operationId, geometry]) => [operationId, { ...geometry }]),
  );
  const rail = getRailStoreSnapshot();
  return {
    viewport: { ...canvas.viewport },
    operationGeometries,
    minimizedOperationIds: canvas.minimized.filter((operationId) => validOperationIds.has(operationId)),
    rail: {
      activePanelId: rail.activeRailPanelId,
      chromeExpanded: rail.railChromeExpanded,
      panelWidth: rail.activeRailPanelId === null ? null : rail.currentPanelWidth,
    },
    sidebar: { statusAxis: getSideBarStatusAxis() ? "status" : "group" },
  };
}

export function applyWorkspacePresetClientLayout(
  result: WorkspacePresetApplyResult,
  currentOperationIds: readonly string[],
  installedPanelIds: ReadonlySet<string>,
): string | null {
  const currentIdSet = new Set(currentOperationIds);
  const canvas = getCanvasSnapshot();
  const operations = { ...canvas.operations };
  for (const operationId of result.appliedOperationIds) {
    const geometry = result.preset.layout.operationGeometries[operationId];
    if (geometry) operations[operationId] = { ...geometry };
  }
  setCanvasState({
    operations,
    minimized: result.preset.layout.minimizedOperationIds.filter((operationId) => currentIdSet.has(operationId)),
  });
  setViewport(result.preset.layout.viewport);
  setSideBarStatusAxis(result.preset.layout.sidebar.statusAxis === "status");

  const presetPanelId = result.preset.layout.rail.activePanelId;
  const panelUnavailable = presetPanelId !== null && !installedPanelIds.has(presetPanelId);
  if (!panelUnavailable) applyRailPreset(result.preset.layout.rail);

  const warnings: string[] = [];
  if (panelUnavailable) warnings.push(`Panel “${presetPanelId}” is not installed; the current rail was preserved.`);
  if (result.missingOperationIds.length > 0) warnings.push(`${result.missingOperationIds.length} missing operation${result.missingOperationIds.length === 1 ? "" : "s"} skipped.`);
  return warnings.length > 0 ? warnings.join(" ") : null;
}
