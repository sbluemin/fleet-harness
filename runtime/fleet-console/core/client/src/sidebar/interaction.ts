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
  const launchKindId = operation.payload.launchKindId;
  if (typeof launchKindId === "string") {
    const matchingKind = candidates.find((kind) => kind.id === launchKindId);
    if (matchingKind) return matchingKind;
  }
  return candidates.length === 1 ? candidates[0]! : null;
}
