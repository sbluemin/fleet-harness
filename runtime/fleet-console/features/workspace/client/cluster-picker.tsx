import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useT } from "../../../core/client/src/i18n/index.js";
import type { ClusterLayout } from "./operation-clusters.js";

/**
 * 묶음 피커 — 조율자 캡션의 단계 띠를 누르면 뜬다. 조율자와 단계를 한 줄씩 늘어놓고, 고르면 호출자가 정한 대로
 * 그 Operation 의 본문이 조율자 패널에 서거나(단계가 숨은 모드) 그 패널로 초점이 간다(펼쳐진 Cruise).
 * 마지막 줄은 할 일 표면으로 가는 문. 색은 진행 사각(신호 토큰)뿐, 고른 줄은 brass 워시.
 */
export function ClusterPicker({ layout, anchor, current, rootActivity, onPick, onOpenItem, onClose }: {
  readonly layout: ClusterLayout;
  readonly anchor: DOMRect;
  /** 지금 조율자 패널이 보이는 Operation(본문 교체) — 펼쳐진 Cruise 에서는 null. */
  readonly current: string | null;
  readonly rootActivity: "idle" | "running" | "awaiting" | "background" | "ended" | null;
  readonly onPick: (operationId: string) => void;
  readonly onOpenItem?: () => void;
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
  const rows: { id: string; label: string; progress: string }[] = [
    { id: layout.cluster.root, label: t("cluster.picker.coordinator"), progress: rootActivity ?? "unknown" },
    ...layout.members.map((laid) => ({ id: laid.member.operationId, label: laid.member.label, progress: laid.member.progress })),
  ];
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
      <div className="cluster-picker-title">{layout.cluster.title}</div>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          role="menuitemradio"
          aria-checked={row.id === selected}
          className={`cluster-picker-row${row.id === selected ? " is-current" : ""}`}
          onClick={() => { onPick(row.id); onClose(); }}
        >
          <i className={`cluster-picker-dot is-${row.progress}`} aria-hidden="true" />
          <span className="cluster-picker-label">{row.label}</span>
        </button>
      ))}
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
