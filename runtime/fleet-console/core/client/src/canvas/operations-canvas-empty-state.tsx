import { useEffect, useRef, useState } from "react";
import type { OperationNode } from "../types.js";
import { formatRelativeTime, useConsoleLocale, useT } from "../i18n/index.js";

interface OperationsCanvasEmptyStateProps {
  readonly activeTheaterId: string | null;
  readonly theaterLabel: string;
  readonly operations: readonly OperationNode[];
  readonly canLaunch: boolean;
  readonly onOpenOperation: (operationId: string) => void;
  readonly onOpenAll: (operationIds: readonly string[]) => void;
  readonly onNewOperation: () => void;
}

/** 이 수를 넘는 일괄 열기는 PTY 동시 스폰 비용이 커 한 번 더 확인한다. */
const OPEN_ALL_CONFIRM_THRESHOLD = 8;
/** 사이드바 칩 닫기와 같은 암(arm) 문법 — 같은 지속시간을 쓴다(CLOSE_ARM_DURATION_MS와 동일). */
const OPEN_ALL_ARM_DURATION_MS = 1500;
/** 이 수까지는 목록이 스크롤 없이 전부 보인다. 넘으면 캡이 걸리고 다음 행이 살짝 보여 스크롤을 암시한다. */
const STANDBY_LIST_UNCAPPED = 4;

export function hasVisibleCanvasContent(operations: readonly OperationNode[], minimizedOperationIds: ReadonlySet<string>): boolean {
  return operations.some((operation) => !minimizedOperationIds.has(operation.id));
}

export function OperationsCanvasEmptyState({
  activeTheaterId,
  theaterLabel,
  operations,
  canLaunch,
  onOpenOperation,
  onOpenAll,
  onNewOperation,
}: OperationsCanvasEmptyStateProps) {
  const t = useT();
  const locale = useConsoleLocale();
  const [openAllArmed, setOpenAllArmed] = useState(false);
  const openAllArmTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (openAllArmTimerRef.current !== null) window.clearTimeout(openAllArmTimerRef.current);
  }, []);

  // 목록 정체성(Theater·대기 집합)이 바뀌면 암을 해제한다 — 확인은 그것을 본 집합에만 유효하다.
  // 컴포넌트는 Theater 전환에도 언마운트되지 않으므로 useState가 다음 목록으로 새어 나갈 수 있다.
  const standbySetKey = (activeTheaterId ?? "") + "|" + operations.map((operation) => operation.id).sort().join(",");
  useEffect(() => {
    if (openAllArmTimerRef.current !== null) {
      window.clearTimeout(openAllArmTimerRef.current);
      openAllArmTimerRef.current = null;
    }
    setOpenAllArmed(false);
  }, [standbySetKey]);

  if (!activeTheaterId) {
    return (
      <div className="operations-canvas-empty" data-canvas-blocker>
        <span className="operations-canvas-empty-mark" aria-hidden="true" />
        <p>{t("canvas.empty.noTheater")}</p>
      </div>
    );
  }

  // 전부 나열한다 — 예전에는 최근 2건으로 잘라 카운트와 도달 가능 집합이 어긋났다.
  const standbyOperations = [...operations]
    .sort((left, right) => right.ts.updatedAt - left.ts.updatedAt);
  const operationCount = operations.length;

  const handleOpenAll = () => {
    if (openAllArmTimerRef.current !== null) {
      window.clearTimeout(openAllArmTimerRef.current);
      openAllArmTimerRef.current = null;
    }
    if (operationCount > OPEN_ALL_CONFIRM_THRESHOLD && !openAllArmed) {
      setOpenAllArmed(true);
      openAllArmTimerRef.current = window.setTimeout(() => {
        openAllArmTimerRef.current = null;
        setOpenAllArmed(false);
      }, OPEN_ALL_ARM_DURATION_MS);
      return;
    }
    setOpenAllArmed(false);
    onOpenAll(standbyOperations.map((operation) => operation.id));
  };

  return (
    <div className="operations-canvas-empty" data-canvas-blocker>
      {operationCount > 0 ? (
        <>
          <p className="operations-canvas-empty-ghost">
            {t(operationCount === 1 ? "canvas.empty.standingBy_one" : "canvas.empty.standingBy_other", { count: operationCount })}
          </p>
          <div
            className={operationCount > STANDBY_LIST_UNCAPPED
              ? "operations-canvas-empty-standby operations-canvas-empty-standby--scroll"
              : "operations-canvas-empty-standby"}
          >
            {standbyOperations.map((operation) => (
              <button
                key={operation.id}
                type="button"
                className="operations-canvas-empty-standby-chip"
                aria-label={t("canvas.empty.openOperation", { title: operation.title })}
                onClick={() => onOpenOperation(operation.id)}
              >
                <span className="operations-canvas-empty-standby-title">{operation.title}</span>
                <span className="operations-canvas-empty-standby-meta" aria-hidden="true">
                  <span className="operations-canvas-empty-standby-time">{formatRelativeTime(operation.ts.updatedAt, locale)}</span>
                  <span className="operations-canvas-empty-standby-open">{t("canvas.empty.open")}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="operations-canvas-empty-headline">{t("canvas.empty.headline")}</p>
      )}
      <div className="operations-canvas-empty-actions">
        <button
          type="button"
          className="operations-canvas-empty-new"
          aria-label={t("canvas.empty.newOperationAria", { theater: theaterLabel })}
          disabled={!canLaunch}
          onClick={onNewOperation}
        >
          {t("canvas.empty.newOperation")}
        </button>
        {operationCount >= 2 ? (
          <button
            type="button"
            className={openAllArmed
              ? "operations-canvas-empty-open-all is-armed"
              : "operations-canvas-empty-open-all"}
            aria-label={openAllArmed
              ? t("canvas.empty.openAllArmedAria", { count: operationCount })
              : t("canvas.empty.openAllAria", { count: operationCount })}
            onClick={handleOpenAll}
          >
            {openAllArmed ? t("canvas.empty.openAllArmed", { count: operationCount }) : t("canvas.empty.openAll")}
          </button>
        ) : null}
      </div>
      <p className="operations-canvas-empty-hints">
        <kbd>⌘K</kbd> {t("canvas.empty.hintSearch")} <span aria-hidden="true">·</span> <kbd>Alt+F</kbd> {t("canvas.empty.hintFormation")} <span aria-hidden="true">·</span> <kbd>Alt+S</kbd> {t("canvas.empty.hintStatusBoard")} <span aria-hidden="true">·</span> <kbd>Alt+T</kbd> {t("canvas.empty.hintTriage")}
      </p>
      <p className="operations-canvas-empty-guide">{t("canvas.empty.guide")}</p>
    </div>
  );
}
