import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import type { OperationClusterMember } from "@fleet-console/sdk/plugin";

import { useT } from "../../../core/client/src/i18n/index.js";
import type { ClusterLayout } from "./operation-clusters.js";

/**
 * 묶음 피커 — 지휘관 캡션의 단계 띠를 누르면 뜬다. 머리는 지휘관 행 하나(활동 낱말 + 완료 셈) — 제목은 바로 위
 * 캡션이 이미 말하므로 되풀이하지 않는다. 그 아래 편성 순서의 단계 전부: Operation 이 있는 단계를 고르면 호출자가
 * 정한 대로 그 본문이 지휘관 패널에 선다(단계는 어느 모드에서도 패널로 서지 않는다). 아직 Operation 이
 * 없는 단계는 흐린 글자로 자리를 지키고, 누르면 목표 표면의 그 단계로 간다. 오른쪽 낱말은 진행(실행 중·결정 대기·
 * 준비됨·n 뒤), 끝난 단계 아래엔 남긴 산출 한 줄. 마지막 줄은 목표 표면으로 가는 문. 색은 진행 사각(신호 토큰)뿐,
 * 고른 줄은 brass 워시.
 */
export function ClusterPicker({ layout, anchor, current, rootActivity, onPick, onOpenItem, onClose }: {
  readonly layout: ClusterLayout;
  readonly anchor: DOMRect;
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
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8));
    const below = anchor.bottom + 6;
    const top = below + rect.height > window.innerHeight - 8 ? Math.max(8, anchor.top - rect.height - 6) : below;
    setPlaced({ left, top });
  }, [anchor]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    const onDown = (event: PointerEvent) => { if (cardRef.current && !cardRef.current.contains(event.target as Node)) onClose(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onDown, true); };
  }, [onClose]);
  useEffect(() => { cardRef.current?.querySelector<HTMLButtonElement>("button[aria-checked='true']")?.focus(); }, []);
  const total = layout.cluster.members.length;
  const done = layout.cluster.members.filter((member) => member.progress === "done").length;
  const numberOf = new Map(layout.cluster.members.map((member, index) => [member.operationId, index + 1]));
  const stateOf = (member: OperationClusterMember): string | null => {
    if (member.progress === "running") return t("cluster.picker.state.running");
    if (member.progress === "awaiting") return t("cluster.picker.state.awaiting");
    if (member.progress === "open") return t("cluster.picker.state.open");
    if (member.progress === "blocked") {
      const waiting = member.after.map((id) => layout.cluster.members.find((candidate) => candidate.operationId === id)).find((prior) => prior && prior.progress !== "done");
      return waiting ? t("cluster.picker.state.blocked", { n: numberOf.get(waiting.operationId) ?? 0 }) : null;
    }
    return null;
  };
  const selected = current ?? layout.cluster.root;
  return createPortal(
    <div
      ref={cardRef}
      className="cluster-picker"
      role="menu"
      aria-label={t("cluster.picker.aria", { title: layout.cluster.title })}
      style={{ left: placed?.left ?? anchor.left, top: placed?.top ?? anchor.bottom + 6, visibility: placed ? "visible" : "hidden" } as CSSProperties}
      data-canvas-blocker
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={layout.cluster.root === selected}
        className={`cluster-picker-row is-head${layout.cluster.root === selected ? " is-current" : ""}`}
        onClick={() => { onPick(layout.cluster.root); onClose(); }}
      >
        <i className={`cluster-picker-dot is-${rootActivity ?? "unknown"}`} aria-hidden="true" />
        <span className="cluster-picker-label">{t("cluster.picker.coordinator")}</span>
        {rootActivity ? <span className={`cluster-picker-state is-${rootActivity}`}>{t(`cluster.picker.activity.${rootActivity}`)}</span> : null}
        <span className="cluster-picker-count" aria-label={t("cluster.picker.count.aria", { done, total })}>{done}/{total}</span>
      </button>
      <div className="cluster-picker-list">
        {layout.cluster.members.map((member) => {
          const pending = member.pending === true;
          const state = stateOf(member);
          const pick = pending ? (onOpenItem ? () => { onOpenItem(member.operationId); onClose(); } : undefined) : () => { onPick(member.operationId); onClose(); };
          return (
            <div key={member.operationId} className="cluster-picker-step">
              <button
                type="button"
                role={pending ? "menuitem" : "menuitemradio"}
                aria-checked={pending ? undefined : member.operationId === selected}
                className={`cluster-picker-row${member.operationId === selected ? " is-current" : ""}${pending ? " is-pending" : ""}${member.progress === "done" ? " is-done" : ""}`}
                disabled={!pick}
                onClick={pick}
              >
                <i className={`cluster-picker-dot is-${member.progress}`} aria-hidden="true" />
                <span className="cluster-picker-label">{member.label}</span>
                {state ? <span className={`cluster-picker-state is-${member.progress}`}>{state}</span> : null}
              </button>
              {member.progress === "done" && member.result ? <div className="cluster-picker-result" title={member.result}>{member.result}</div> : null}
            </div>
          );
        })}
      </div>
      {onOpenItem ? (
        <button type="button" role="menuitem" className="cluster-picker-row is-link" onClick={() => { onOpenItem(); onClose(); }}>
          <span className="cluster-picker-label">{t("cluster.picker.open")}</span>
          <span aria-hidden="true">↗</span>
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
