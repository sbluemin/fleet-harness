import { useSyncExternalStore } from "react";

import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { useT } from "../i18n/index.js";
import { operationActivityLabel, operationActivityVisual, resolveOperationActivity } from "../operation-activity.js";
import type { OperationNode } from "../types.js";
import { theaterInitials } from "./operations-side-bar.js";
import type { TriageDeckTheater } from "../canvas/triage-watch-deck.js";
import { getTriagePick, getTriageSnapshot, resolveTriageQueue, subscribeTriage, type TriageQueueEntry } from "../canvas/triage-store.js";

export interface TriageSideBarSections {
  readonly waiting: readonly OperationNode[];
  readonly watching: readonly OperationNode[];
  readonly idle: readonly OperationNode[];
}

// 선별 처리 사이드바는 Theater 트리가 아니라 처리 순서의 단일 전역 목록이다 —
// 대기(큐 순서, 번호) → 주시(실행 중·백그라운드) → 유휴. 휴면 Operation은 어디에도 올리지 않는다.
export function resolveTriageSideBarSections(
  operations: readonly OperationNode[],
  operationStatus: Readonly<Record<string, OperationActivity>>,
  queue: readonly TriageQueueEntry[],
  theaters: readonly TriageDeckTheater[],
): TriageSideBarSections {
  const queueIds = new Set(queue.map((entry) => entry.operation.id));
  const live = operations.filter((operation) =>
    resolveOperationActivity(operation, operationStatus) !== "dormant");
  const theaterOrder = new Map(theaters.map((theater, index) => [theater.id, index]));
  const nonQueued = live
    .filter((operation) => !queueIds.has(operation.id))
    .sort((left, right) =>
      (theaterOrder.get(left.theaterId) ?? theaters.length) - (theaterOrder.get(right.theaterId) ?? theaters.length)
      || left.ts.createdAt - right.ts.createdAt);
  return {
    waiting: queue.map((entry) => entry.operation),
    watching: nonQueued.filter((operation) => {
      const activity = resolveOperationActivity(operation, operationStatus);
      return activity === "running" || activity === "background";
    }),
    idle: nonQueued.filter((operation) => resolveOperationActivity(operation, operationStatus) === "idle"),
  };
}

interface TriageSideBarProps {
  readonly theaters: readonly TriageDeckTheater[];
  readonly operations: readonly OperationNode[];
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  readonly onPick: (operationId: string) => void;
}

export function TriageSideBar({
  theaters,
  operations,
  operationStatus,
  onPick,
}: TriageSideBarProps) {
  const t = useT();
  // 지목·미룸·치워둠은 콘솔 상태를 바꾸지 않는 store 단독 변화다 — 캔버스와 같은 리비전 구독으로
  // 사이드바도 함께 리렌더한다. 큐/지목을 부모 render 시점 prop으로 받으면 이 변화에 침묵한다.
  useSyncExternalStore(subscribeTriage, getTriageSnapshot, getTriageSnapshot);
  const queue = resolveTriageQueue(operations, operationStatus);
  const activeOperationId = getTriagePick() ?? queue[0]?.operation.id ?? null;
  const theaterLabelById = new Map(theaters.map((theater) => [theater.id, theater.label]));
  const sections = resolveTriageSideBarSections(operations, operationStatus, queue, theaters);
  const totalRows = sections.waiting.length + sections.watching.length + sections.idle.length;
  return (
    <aside className="triage-side-bar" data-canvas-blocker aria-label={t("triageSidebar.aria")}>
      <div className="triage-side-bar-caption">
        {t("triageSidebar.caption", { waiting: sections.waiting.length })}
      </div>
      {totalRows === 0 ? (
        <p className="triage-side-bar-empty">{t("triageSidebar.empty")}</p>
      ) : (
        <>
          {sections.waiting.length > 0 ? (
            <ol className="triage-side-bar-section">
              {sections.waiting.map((operation, index) => (
                <li key={operation.id}>
                  <TriageSideBarRow
                    operation={operation}
                    operationStatus={operationStatus}
                    theaterLabel={theaterLabelById.get(operation.theaterId) ?? operation.theaterId}
                    ordinal={index + 1}
                    current={operation.id === activeOperationId}
                    onPick={onPick}
                  />
                </li>
              ))}
            </ol>
          ) : null}
          {sections.watching.length > 0 ? (
            <section className="triage-side-bar-section">
              <div className="triage-side-bar-section-label">{t("triageSidebar.watching")}</div>
              {sections.watching.map((operation) => (
                <TriageSideBarRow
                  key={operation.id}
                  operation={operation}
                  operationStatus={operationStatus}
                  theaterLabel={theaterLabelById.get(operation.theaterId) ?? operation.theaterId}
                  current={operation.id === activeOperationId}
                  onPick={onPick}
                />
              ))}
            </section>
          ) : null}
          {sections.idle.length > 0 ? (
            <section className="triage-side-bar-section">
              <div className="triage-side-bar-section-label">{t("triageSidebar.idle")}</div>
              {sections.idle.map((operation) => (
                <TriageSideBarRow
                  key={operation.id}
                  operation={operation}
                  operationStatus={operationStatus}
                  theaterLabel={theaterLabelById.get(operation.theaterId) ?? operation.theaterId}
                  current={operation.id === activeOperationId}
                  onPick={onPick}
                />
              ))}
            </section>
          ) : null}
        </>
      )}
    </aside>
  );
}

function TriageSideBarRow({
  operation,
  operationStatus,
  theaterLabel,
  ordinal,
  current,
  onPick,
}: {
  readonly operation: OperationNode;
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  readonly theaterLabel: string;
  readonly ordinal?: number;
  readonly current: boolean;
  readonly onPick: (operationId: string) => void;
}) {
  const activity = resolveOperationActivity(operation, operationStatus);
  const visual = operationActivityVisual(activity);
  return (
    <button
      type="button"
      className={`triage-side-bar-row ${current ? "is-current" : ""}`}
      aria-current={current ? "true" : undefined}
      title={`${operation.title} · ${operationActivityLabel(activity)}`}
      onClick={() => onPick(operation.id)}
    >
      {ordinal !== undefined ? (
        <span className="triage-side-bar-ordinal" aria-hidden="true">{String(ordinal).padStart(2, "0")}</span>
      ) : null}
      <span className={`triage-side-bar-dot is-${visual}`} aria-hidden="true" />
      <span className="triage-side-bar-title">{operation.title}</span>
      <span className="triage-side-bar-chip" aria-hidden="true">{theaterInitials(theaterLabel)}</span>
    </button>
  );
}
