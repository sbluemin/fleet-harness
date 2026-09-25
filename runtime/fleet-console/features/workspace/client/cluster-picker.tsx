import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import type { OperationClusterMember } from "@fleet-console/sdk/plugin";

import { useT } from "../../../core/client/src/i18n/index.js";
import type { ClusterLayout } from "./operation-clusters.js";

const ChevRight = () => (
  <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
    <path d="M3.5 2l3 3-3 3" />
  </svg>
);

/**
 * 묶음 피커 — 지휘관 캡션의 단계 띠를 누르면 뜬다.
 * 목록을 「지금」(실행·대기) → 「다음」 → 「완료 N」(기본으로 접힘) 순서로 묶는다.
 * 띠의 칸을 누르면 그 임무가 든 묶음을 펴고 그 행으로 스크롤해 brass로 강조한다.
 * 위치: 폭은 min(420px, 패널 폭 − 16px), 높이는 제 패널 아래 끝에서 8px 위까지로 아래 패널을 덮지 않는다.
 * 자리가 240px보다 좁으면 위로 연다.
 */
export function ClusterPicker({
  layout,
  anchor,
  panelRect,
  canvasTop,
  targetOperationId,
  current,
  rootActivity,
  onPick,
  onOpenItem,
  onClose,
}: {
  readonly layout: ClusterLayout;
  readonly anchor: DOMRect;
  readonly panelRect?: { readonly left: number; readonly top: number; readonly width: number; readonly height: number; readonly bottom: number };
  readonly canvasTop?: number;
  readonly targetOperationId?: string | null;
  /** 지금 지휘관 패널이 보이는 Operation(본문 교체) — 지휘관 자신이면 null. */
  readonly current: string | null;
  readonly rootActivity: "idle" | "running" | "awaiting" | "background" | "ended" | null;
  readonly onPick: (operationId: string) => void;
  /** 목표 표면으로 — 자리표시 단계의 id 가 오면 그 단계를 집는다. */
  readonly onOpenItem?: (operationId?: string) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);

  const doneMembers = layout.cluster.members.filter((m) => m.progress === "done");
  const nowMembers = layout.cluster.members.filter((m) => m.progress === "running" || m.progress === "awaiting");
  const nextMembers = layout.cluster.members.filter((m) => m.progress === "open" || m.progress === "blocked");

  const isTargetInDone = Boolean(targetOperationId && doneMembers.some((m) => m.operationId === targetOperationId));
  const [doneExpanded, setDoneExpanded] = useState(isTargetInDone);
  const [nowExpanded, setNowExpanded] = useState(true);
  const [nextExpanded, setNextExpanded] = useState(true);

  // 대상이 완료 묶음에 있으면 완료 묶음 펼치기
  useEffect(() => {
    if (isTargetInDone) {
      setDoneExpanded(true);
    }
  }, [isTargetInDone]);

  // 대상 임무 행으로 스크롤
  useEffect(() => {
    if (!targetOperationId) return;
    const timer = setTimeout(() => {
      const targetEl = cardRef.current?.querySelector<HTMLElement>(".cluster-picker-row.is-target");
      if (targetEl) {
        targetEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }, 40);
    return () => clearTimeout(timer);
  }, [targetOperationId, doneExpanded]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    const panelW = panelRect?.width ?? window.innerWidth;
    const panelBottom = panelRect?.bottom ?? (anchor.bottom + 400);
    const panelTop = panelRect?.top ?? (anchor.top - 400);

    const width = Math.max(220, Math.min(420, panelW - 16));
    const maxLeft = panelRect
      ? Math.min(window.innerWidth - width - 8, panelRect.left + panelRect.width - width - 8)
      : window.innerWidth - width - 8;
    const minLeft = panelRect ? Math.max(8, panelRect.left + 8) : 8;
    const left = Math.max(minLeft, Math.min(anchor.left, maxLeft));

    // N2 위치 보정:
    // 1) 팝오버는 앵커(띠)와 앱 상단 바를 덮지 않는다.
    //    앱 상단 바 경계: canvasTop(캔버스 영역의 top) 또는 36px.
    const appTopBound = Math.max(8, canvasTop ?? 36);
    const belowTop = anchor.bottom + 6;
    const viewportBottom = window.innerHeight - 8;

    // 2) 위쪽 가용 공간: 앱 상단 바 아래 ~ 앵커 위
    const spaceAbove = Math.max(0, anchor.top - 6 - appTopBound);

    // 3) 아래쪽 가용 공간:
    //    제 패널 아래 끝까지를 우선하되, 그 높이가 240px 미만이면 뷰포트 아래 −8까지 확장
    const spaceBelowInPanel = Math.max(0, panelBottom - 8 - belowTop);
    const spaceBelow = spaceBelowInPanel >= 240
      ? spaceBelowInPanel
      : Math.max(0, viewportBottom - belowTop);

    // 4) 아래와 위 중 더 넓은 쪽으로 연다
    const openDownward = spaceBelow >= spaceAbove;

    let top: number;
    let maxHeight: number;

    if (openDownward) {
      top = belowTop;
      maxHeight = Math.min(spaceBelow, 520);
    } else {
      maxHeight = Math.min(spaceAbove, 520);
      top = Math.max(appTopBound, anchor.top - 6 - maxHeight);
    }

    setPlaced((prev) => {
      if (prev && prev.left === left && prev.top === top && prev.width === width && prev.maxHeight === maxHeight) {
        return prev;
      }
      return { left, top, width, maxHeight };
    });
  }, [anchor, panelRect, canvasTop]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const onDown = (event: PointerEvent) => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("wheel", onWheel, { passive: true, capture: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [onClose]);

  useEffect(() => {
    cardRef.current?.querySelector<HTMLButtonElement>("button[aria-checked='true']")?.focus();
  }, []);

  const total = layout.cluster.members.length;
  const done = doneMembers.length;
  const numberOf = new Map(layout.cluster.members.map((member, index) => [member.operationId, index + 1]));

  const stateOf = (member: OperationClusterMember): string | null => {
    if (member.progress === "running") return t("cluster.picker.state.running");
    if (member.progress === "awaiting") return t("cluster.picker.state.awaiting");
    if (member.progress === "open") return t("cluster.picker.state.open");
    if (member.progress === "blocked") {
      const waiting = member.after
        .map((id) => layout.cluster.members.find((candidate) => candidate.operationId === id))
        .find((prior) => prior && prior.progress !== "done");
      return waiting ? t("cluster.picker.state.blocked", { n: numberOf.get(waiting.operationId) ?? 0 }) : null;
    }
    return null;
  };

  const selected = current ?? layout.cluster.root;
  const chefLabel = t("cluster.picker.coordinator");

  const renderMemberRow = (member: OperationClusterMember) => {
    const pending = member.pending === true;
    const isTarget = member.operationId === targetOperationId;
    const isCurrent = member.operationId === selected;
    const state = stateOf(member);
    const pick = pending
      ? onOpenItem
        ? () => {
            onOpenItem(member.operationId);
            onClose();
          }
        : undefined
      : () => {
          onPick(member.operationId);
          onClose();
        };

    const rowClasses = [
      "cluster-picker-row",
      isCurrent ? "is-current" : "",
      isTarget ? "is-target" : "",
      pending ? "is-pending" : "",
      member.progress === "done" ? "is-done" : "",
    ].filter(Boolean).join(" ");

    return (
      <div key={member.operationId} className="cluster-picker-step">
        <button
          type="button"
          role={pending ? "menuitem" : "menuitemradio"}
          aria-checked={pending ? undefined : isCurrent}
          className={rowClasses}
          title={member.label}
          disabled={!pick}
          onClick={pick}
        >
          <i className={`cluster-picker-dot is-${member.progress}`} aria-hidden="true" />
          <span className="cluster-picker-label">{member.label}</span>
          {state ? <span className={`cluster-picker-state is-${member.progress}`}>{state}</span> : null}
        </button>
        {member.progress === "done" && member.result ? (
          <div className="cluster-picker-result" title={member.result}>
            {member.result}
          </div>
        ) : null}
      </div>
    );
  };

  const renderSection = (
    title: string,
    items: readonly OperationClusterMember[],
    expanded: boolean,
    onToggle: () => void,
  ) => {
    if (items.length === 0) return null;
    return (
      <div className="cluster-picker-group">
        <button
          type="button"
          className="cluster-picker-sec"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className={`cluster-picker-sec-arrow${expanded ? " is-open" : ""}`} aria-hidden="true">
            <ChevRight />
          </span>
          <span className="cluster-picker-sec-title">{title}</span>
          <span className="cluster-picker-sec-count">{items.length}</span>
        </button>
        {expanded ? items.map((member) => renderMemberRow(member)) : null}
      </div>
    );
  };

  const style: CSSProperties = {
    left: placed?.left ?? anchor.left,
    top: placed?.top ?? anchor.bottom + 6,
    width: placed?.width ?? Math.max(220, Math.min(420, (panelRect?.width ?? 400) - 16)),
    maxHeight: placed?.maxHeight ?? 480,
    visibility: placed ? "visible" : "hidden",
  };

  return createPortal(
    <div
      ref={cardRef}
      className="cluster-picker"
      role="menu"
      aria-label={t("cluster.picker.aria", { title: layout.cluster.title })}
      style={style}
      data-canvas-blocker
    >
      <div className="cluster-picker-head">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={layout.cluster.root === selected}
          className={`cluster-picker-head-btn${layout.cluster.root === selected ? " is-current" : ""}`}
          onClick={() => {
            onPick(layout.cluster.root);
            onClose();
          }}
        >
          <i className={`cluster-picker-dot is-${rootActivity ?? "unknown"}`} aria-hidden="true" />
          <span className="cluster-picker-head-label">
            <span className="cluster-picker-head-role">{chefLabel}</span>
            {rootActivity ? <span className="cluster-picker-head-sep"> · </span> : null}
            {rootActivity ? (
              <span className={`cluster-picker-head-state is-${rootActivity}`}>
                {t(`cluster.picker.activity.${rootActivity}`)}
              </span>
            ) : null}
          </span>
        </button>
        <span className="cluster-picker-count" aria-label={t("cluster.picker.count.aria", { done, total })}>
          {t("cluster.picker.group.done")} {done}/{total}
        </span>
        <button
          type="button"
          className="cluster-picker-close"
          aria-label={t("cluster.picker.close")}
          title={t("cluster.picker.close")}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div ref={listRef} className="cluster-picker-list">
        {renderSection(t("cluster.picker.group.now"), nowMembers, nowExpanded, () => setNowExpanded((prev) => !prev))}
        {renderSection(t("cluster.picker.group.next"), nextMembers, nextExpanded, () => setNextExpanded((prev) => !prev))}
        {renderSection(t("cluster.picker.group.done"), doneMembers, doneExpanded, () => setDoneExpanded((prev) => !prev))}
      </div>
      {onOpenItem ? (
        <button
          type="button"
          role="menuitem"
          className="cluster-picker-row is-link"
          onClick={() => {
            onOpenItem();
            onClose();
          }}
        >
          <span className="cluster-picker-label">{t("cluster.picker.open")}</span>
          <span aria-hidden="true">↗</span>
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
