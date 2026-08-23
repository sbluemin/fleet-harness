import type { OperationCatalogPlugin, OperationLaunchKind, OperationNode } from "@fleet-console/sdk/operations";

export type SideBarOperationAction =
  | "rename"
  | "assign-group"
  | "set-accent"
  | "minimize";

export type SideBarOperationMenuAction = Extract<SideBarOperationAction, "assign-group" | "set-accent">;

interface PendingOperationAction {
  readonly operationId: string;
  readonly action: SideBarOperationAction;
}

type OperationActionListener = (request: PendingOperationAction) => boolean;

let pendingRequest: PendingOperationAction | null = null;
const listeners = new Set<OperationActionListener>();

export function requestSideBarOperationAction(operationId: string, action: SideBarOperationAction): void {
  pendingRequest = { operationId, action };
  notifyListeners();
}

// 소비 리스너(OperationsSideBar)가 언마운트된 동안 들어온 요청을 폐기한다 — 리스너 없이
// 잔류한 요청은 리마운트 시 subscribe의 즉시 재생으로 뒤늦게 실행된다.
export function clearSideBarOperationAction(): void {
  pendingRequest = null;
}

export function subscribeSideBarOperationAction(listener: OperationActionListener): () => void {
  listeners.add(listener);
  notifyListener(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(): void {
  for (const listener of listeners) {
    if (notifyListener(listener)) return;
  }
}

function notifyListener(listener: OperationActionListener): boolean {
  if (pendingRequest === null || !listener(pendingRequest)) return false;
  pendingRequest = null;
  return true;
}

type LaunchKindOperation = Pick<OperationNode, "pluginId" | "type" | "payload">;

export function resolveOperationLaunchKind(catalog: readonly OperationCatalogPlugin[], operation: LaunchKindOperation): OperationLaunchKind | null {
  const candidates = catalog
    .find((plugin) => plugin.id === operation.pluginId)
    ?.kinds.filter((kind) => kind.type === operation.type) ?? [];
  return candidates.length === 1 ? candidates[0]! : null;
}
