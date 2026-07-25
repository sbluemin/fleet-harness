import type { OperationNode } from "../types.js";

interface OperationsCanvasEmptyStateProps {
  readonly activeTheaterId: string | null;
  readonly theaterLabel: string;
  readonly operations: readonly OperationNode[];
  readonly canLaunch: boolean;
  readonly onOpenOperation: (operationId: string) => void;
  readonly onNewOperation: () => void;
}

const EMPTY_GUIDE = "Shift-drag to create a Shell. Right-click for actions. Drag to pan; scroll to zoom.";

export function hasVisibleCanvasContent(operations: readonly OperationNode[], minimizedOperationIds: ReadonlySet<string>): boolean {
  return operations.some((operation) => !minimizedOperationIds.has(operation.id));
}

export function OperationsCanvasEmptyState({
  activeTheaterId,
  theaterLabel,
  operations,
  canLaunch,
  onOpenOperation,
  onNewOperation,
}: OperationsCanvasEmptyStateProps) {
  if (!activeTheaterId) {
    return (
      <div className="operations-canvas-empty" data-canvas-blocker>
        <span className="operations-canvas-empty-mark" aria-hidden="true" />
        <p>Add a Theater from the sidebar to start operations.</p>
      </div>
    );
  }

  const standbyOperations = [...operations]
    .sort((left, right) => right.ts.updatedAt - left.ts.updatedAt)
    .slice(0, 2);
  const operationCount = operations.length;

  return (
    <div className="operations-canvas-empty" data-canvas-blocker>
      {operationCount > 0 ? (
        <>
          <p className="operations-canvas-empty-ghost">
            {operationCount} {operationCount === 1 ? "operation" : "operations"} standing by
          </p>
          <div className="operations-canvas-empty-standby">
            {standbyOperations.map((operation) => (
              <button
                key={operation.id}
                type="button"
                className="operations-canvas-empty-standby-chip"
                aria-label={`Open operation ${operation.title}`}
                onClick={() => onOpenOperation(operation.id)}
              >
                <span className="operations-canvas-empty-standby-title">{operation.title}</span>
                <span className="operations-canvas-empty-standby-open" aria-hidden="true">OPEN</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="operations-canvas-empty-headline">Launch your first operation</p>
      )}
      <button
        type="button"
        className="operations-canvas-empty-new"
        aria-label={`New Operation in ${theaterLabel}`}
        disabled={!canLaunch}
        onClick={onNewOperation}
      >
        + New Operation
      </button>
      <p className="operations-canvas-empty-hints">
        <kbd>⌘K</kbd> Search <span aria-hidden="true">·</span> <kbd>Alt+F</kbd> Formation <span aria-hidden="true">·</span> <kbd>Alt+S</kbd> Status board
      </p>
      <p className="operations-canvas-empty-guide">{EMPTY_GUIDE}</p>
    </div>
  );
}
