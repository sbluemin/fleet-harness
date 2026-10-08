import { useEffect, useRef, useState } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { Toast } from "../../../../core/client/src/chrome/components/toast.js";
import { resolveOperationMarkVisual } from "../../../execution/client/operation-activity.js";
import { OperationNameMark } from "../../../execution/client/components/operation-name-mark.js";
import { useTriageActive } from "../canvas/triage-store.js";
import { DecisionRequestMark, hasDecisionRequest } from "../decision-request-mark.js";
import { useClusterIndex } from "../operation-clusters.js";
import { ClusterRowMark } from "../sidebar/side-bar-cluster-row.js";
import { theaterInitials } from "../sidebar/theater-initials.js";
import { TheaterMonogram } from "../sidebar/theater-monogram.js";
import { useAttentionQueue } from "./use-attention-queue.js";
import "./attention-section.css";

export function AttentionSection({ onFocus, onOpenOperationMenu }: {
  readonly onFocus: (operationId: string) => void;
  readonly onOpenOperationMenu: (operationId: string, anchor: DOMRect, returnFocus: HTMLElement) => void;
}) {
  const t = useT();
  const { state, queue, next, stagedId, arrivals, minimizedIds, counts } = useAttentionQueue();
  const warRoom = useTriageActive();
  const clusters = useClusterIndex();
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const entries = queue.map(({ operation }) => operation);
  const staged = warRoom ? state.operations.find((operation) => operation.id === stagedId) : null;
  // 600ms 처리 유예의 실제 무대도 남긴다. 고정 행은 순서를 바꾸지 않고 여섯 칸 안에 유지한다.
  if (staged && !entries.some((operation) => operation.id === stagedId)) entries.unshift(staged);
  const visibleIds = new Set(warRoom ? [next?.id, stagedId].filter((id): id is string => !!id) : []);
  for (const operation of entries) {
    if (!expanded && visibleIds.size >= 6) break;
    visibleIds.add(operation.id);
  }
  const shown = expanded ? entries : entries.filter((operation) => visibleIds.has(operation.id));
  const remaining = entries.length - shown.length;
  if (!warRoom && entries.length === 0 && !notice) return null;
  return <li className={`side-bar-attention${warRoom ? " is-war-room" : ""}`}>
    <section aria-label={t("zen.attention.count", { count: queue.length })}>
      <div className="side-bar-attention-head">
        <span>{t("zen.attention.count", { count: queue.length })}</span>
        {warRoom ? <span className="side-bar-attention-summary">{t("zen.attention.summary", { running: counts.running, idle: counts.idle })}</span> : null}
      </div>
      <div ref={rowsRef} className="side-bar-attention-rows" onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const buttons = [...rowsRef.current!.querySelectorAll<HTMLButtonElement>(".side-bar-attention-row")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}>
        {shown.map((operation) => {
          const entry = queue.find((entry) => entry.operation.id === operation.id);
          const visual = resolveOperationMarkVisual({ activity: entry?.activity ?? "idle", operationId: operation.id, idleArrivalIds: arrivals });
          const theater = state.theaters.find((theater) => theater.id === operation.theaterId)?.label ?? operation.theaterId;
          const decision = hasDecisionRequest(clusters, operation.id);
          // 줄만 선 묶음(구성원·결정 요청 없는 목표)은 rootOf 에 없으므로 줄 색인에서 읽되, 그 줄의 뿌리일 때만 표식을 단다.
          const rowLayout = clusters.rowOf.get(operation.id);
          // 누르는 표식(맡김 스위치)은 사이드바 줄의 손잡이다 — 이 목록은 줄 전체가 버튼이라 켠 표식만 장식으로 단다.
          const rowMark = rowLayout?.cluster.root === operation.id ? rowLayout.cluster.row?.mark : undefined;
          const mark = rowMark && (!rowMark.toggle || rowMark.toggle.pressed) ? rowMark : undefined;
          const active = warRoom ? operation.id === stagedId : operation.id === state.activeOperationId;
          return <button key={operation.id} type="button" className={`side-bar-attention-row${active ? " is-active" : ""}${minimizedIds.has(operation.id) ? " is-minimized" : ""}`} data-attention-operation={operation.id}
            data-keep-operation-active="" aria-current={active ? "true" : undefined} title={`${operation.title} · ${theater}`}
            onClick={() => {
              if (!warRoom && operation.theaterId !== state.activeTheaterId) setNotice(t("zen.attention.theaterChanged", { theater }));
              onFocus(operation.id);
            }}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onOpenOperationMenu(operation.id, new DOMRect(event.clientX, event.clientY, 0, 0), event.currentTarget); }}
            onKeyDown={(event) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault(); event.stopPropagation(); onOpenOperationMenu(operation.id, event.currentTarget.getBoundingClientRect(), event.currentTarget);
              }
            }}>
            {warRoom && operation.id === next?.id ? <span className="side-bar-attention-next">{t("canvas.triage.next")} ▸</span> : null}
            <OperationNameMark operation={operation} status={visual} decorative className="side-bar-attention-mark" />
            <span className="side-bar-attention-title">{operation.title}</span>
            {decision ? <DecisionRequestMark /> : null}
            {mark ? <ClusterRowMark mark={mark} decorative={false} /> : null}
            <TheaterMonogram>{theaterInitials(theater)}</TheaterMonogram>
          </button>;
        })}
        {entries.length === 0 ? <p className="side-bar-attention-empty">{t("canvas.triage.queueEmpty")}</p> : null}
      </div>
      {remaining > 0 || expanded && entries.length > 6 ? <button type="button" className="side-bar-attention-more" aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}>{t(expanded ? "zen.attention.less" : "zen.attention.more", { count: remaining })}</button> : null}
    </section>
    {notice ? <Toast open tone="info" title={notice} onDismiss={() => setNotice(null)} /> : null}
  </li>;
}
