import type { OperationNode } from "../types.js";
import { useT } from "../i18n/index.js";

interface OperationsCanvasEmptyStateProps {
  readonly activeTheaterId: string | null;
  readonly theaterLabel: string;
  readonly operations: readonly OperationNode[];
  readonly canLaunch: boolean;
  readonly onOpenOperation: (operationId: string) => void;
  readonly onNewOperation: () => void;
}

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
  const t = useT();

  if (!activeTheaterId) {
    return (
      <div className="operations-canvas-empty" data-canvas-blocker>
        <span className="operations-canvas-empty-mark" aria-hidden="true" />
        <p>{t("canvas.empty.noTheater")}</p>
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
            {t(operationCount === 1 ? "canvas.empty.standingBy_one" : "canvas.empty.standingBy_other", { count: operationCount })}
          </p>
          <div className="operations-canvas-empty-standby">
            {standbyOperations.map((operation) => (
              <button
                key={operation.id}
                type="button"
                className="operations-canvas-empty-standby-chip"
                aria-label={t("canvas.empty.openOperation", { title: operation.title })}
                onClick={() => onOpenOperation(operation.id)}
              >
                <span className="operations-canvas-empty-standby-title">{operation.title}</span>
                <span className="operations-canvas-empty-standby-open" aria-hidden="true">{t("canvas.empty.open")}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="operations-canvas-empty-headline">{t("canvas.empty.headline")}</p>
      )}
      <button
        type="button"
        className="operations-canvas-empty-new"
        aria-label={t("canvas.empty.newOperationAria", { theater: theaterLabel })}
        disabled={!canLaunch}
        onClick={onNewOperation}
      >
        {t("canvas.empty.newOperation")}
      </button>
      <p className="operations-canvas-empty-hints">
        <kbd>⌘K</kbd> {t("canvas.empty.hintSearch")} <span aria-hidden="true">·</span> <kbd>Alt+F</kbd> {t("canvas.empty.hintFormation")} <span aria-hidden="true">·</span> <kbd>Alt+S</kbd> {t("canvas.empty.hintStatusBoard")}
      </p>
      <p className="operations-canvas-empty-guide">{t("canvas.empty.guide")}</p>
    </div>
  );
}
