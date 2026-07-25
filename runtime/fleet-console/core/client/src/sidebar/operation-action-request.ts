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
