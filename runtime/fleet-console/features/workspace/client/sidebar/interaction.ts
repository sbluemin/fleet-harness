import type { ObjectiveCatalogPlugin, ObjectiveLaunchKind, ObjectiveRecord } from "../../../objectives/shared/records/types.js";

export type SideBarObjectiveAction =
  | "rename"
  | "assign-group"
  | "set-accent";

export type SideBarObjectiveMenuAction = Extract<SideBarObjectiveAction, "assign-group" | "set-accent">;

interface PendingObjectiveAction {
  readonly objectiveId: string;
  readonly action: SideBarObjectiveAction;
}

type ObjectiveActionListener = (request: PendingObjectiveAction) => boolean;

let pendingRequest: PendingObjectiveAction | null = null;
const listeners = new Set<ObjectiveActionListener>();

export function requestSideBarObjectiveAction(objectiveId: string, action: SideBarObjectiveAction): void {
  pendingRequest = { objectiveId, action };
  notifyListeners();
}

// 소비 리스너(ObjectiveRecordsSideBar)가 언마운트된 동안 들어온 요청을 폐기한다 — 리스너 없이
// 잔류한 요청은 리마운트 시 subscribe의 즉시 재생으로 뒤늦게 실행된다.
export function clearSideBarObjectiveAction(): void {
  pendingRequest = null;
}

export function subscribeSideBarObjectiveAction(listener: ObjectiveActionListener): () => void {
  listeners.add(listener);
  notifyListener(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(): void {
  for (const listener of listeners) {
    if (notifyListener(listener)) return;
  }
}

function notifyListener(listener: ObjectiveActionListener): boolean {
  if (pendingRequest === null || !listener(pendingRequest)) return false;
  pendingRequest = null;
  return true;
}

type LaunchKindObjective = Pick<ObjectiveRecord, "pluginId" | "type" | "payload">;

export function resolveObjectiveLaunchKind(catalog: readonly ObjectiveCatalogPlugin[], objectiveRecord: LaunchKindObjective): ObjectiveLaunchKind | null {
  const candidates = catalog
    .find((plugin) => plugin.id === objectiveRecord.pluginId)
    ?.kinds.filter((kind) => kind.type === objectiveRecord.type) ?? [];
  return candidates.length === 1 ? candidates[0]! : null;
}
