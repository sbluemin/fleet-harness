import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { useT } from "../../../core/client/src/i18n/index.js";
import type { ClusterLaidMember, ClusterLayout } from "./operation-clusters.js";

export type StripMode = "full" | "dense" | "count";

export function requiredWidth(members: readonly ClusterLaidMember[], mode: StripMode): number {
  if (mode === "count") return 48;
  let separators = 0;
  let lastDepth = -1;
  for (const laid of members) {
    if (laid.depth !== lastDepth) {
      separators++;
      lastDepth = laid.depth;
    }
  }
  const n = members.length;
  if (mode === "dense") return 13 + n * 4 + separators * 4;
  return 13 + n * 9 + separators * 6;
}

/** 배치 전·숨은 칩에서는 측정값이 없다. */
function computeBudget(element: HTMLElement | null): number | null {
  if (!element) return null;
  const container = element.closest<HTMLElement>(".side-bar-chip-text") ?? element.parentElement;
  return container && container.clientWidth > 0 ? container.clientWidth : null;
}

/** 캡션은 칸마다 임무로 이동하고, 사이드바에서는 줄 클릭을 방해하지 않는 장식이다. */
export function ClusterStrip({ layout, rootActivity, className, onOpen, missionNavigation = false, decorative = false }: {
  readonly layout: ClusterLayout;
  readonly rootActivity?: "idle" | "running" | "awaiting" | "background" | "ended" | null;
  readonly className?: string;
  readonly onOpen?: (operationId?: string) => void;
  readonly missionNavigation?: boolean;
  readonly decorative?: boolean;
}) {
  const t = useT();
  const stripRef = useRef<HTMLSpanElement | null>(null);
  const [mode, setMode] = useState<StripMode>("full");
  // 한 번의 Tab 정지만 유지한다. 사라진 임무를 가리키던 기억은 지휘관 고리로 돌아간다.
  const [focusedMemberId, setFocusedMemberId] = useState<string | null>(null);
  const activeMemberId = layout.members.some(({ member }) => member.operationId === focusedMemberId) ? focusedMemberId : null;
  useLayoutEffect(() => {
    if (focusedMemberId !== null && activeMemberId === null) setFocusedMemberId(null);
  }, [focusedMemberId, activeMemberId]);
  const membersRef = useRef(layout.members);
  membersRef.current = layout.members;
  const membersKey = useMemo(
    () => layout.members.map((m) => `${m.member.operationId}:${m.member.progress}:${m.depth}`).join("|"),
    [layout.members],
  );

  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const target = el.closest<HTMLElement>(".side-bar-chip-text") ?? el.parentElement;
    if (!target) return;
    const update = () => {
      const budget = computeBudget(el);
      if (budget === null) return;
      const currentMembers = membersRef.current;
      const fullW = requiredWidth(currentMembers, "full");
      const denseW = requiredWidth(currentMembers, "dense");
      const nextMode: StripMode = fullW <= budget ? "full" : denseW <= budget ? "dense" : "count";
      setMode((prev) => (prev !== nextMode ? nextMode : prev));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, [membersKey, missionNavigation]);

  const missions = layout.members.filter(({ member }) => member.missionNumber !== undefined);
  const done = missions.filter(({ member }) => member.progress === "done").length;
  const total = missions.length;
  const label = t("cluster.strip.aria", { title: layout.cluster.title, done, total });
  const open = onOpen ? (event: MouseEvent | KeyboardEvent, operationId?: string) => {
    event.stopPropagation();
    event.preventDefault();
    onOpen(operationId);
  } : undefined;
  const onCellKeyDown = (event: KeyboardEvent<HTMLElement>, operationId?: string) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      const cells = Array.from(stripRef.current?.querySelectorAll<HTMLElement>("[data-cluster-cell]") ?? []);
      const index = cells.indexOf(event.currentTarget);
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? cells.length - 1
        : index + (event.key === "ArrowRight" ? 1 : -1);
      cells[nextIndex]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      open?.(event, operationId);
    }
  };
  const isAwaiting = rootActivity === "awaiting" || layout.members.some((laid) => laid.member.progress === "awaiting");
  const rootClass = `cluster-strip-root is-${isAwaiting ? "awaiting" : rootActivity ?? "unknown"}`;
  const allDone = done === total && total > 0;
  const stripClassName = [
    "cluster-strip", mode === "dense" ? "is-dense" : mode === "count" ? "is-count" : "",
    missionNavigation && open ? "is-mission-navigation" : open ? "is-interactive" : "", className ?? "",
  ].filter(Boolean).join(" ");

  if (mode === "count") {
    return (
      <span ref={stripRef} className={stripClassName} role={decorative ? undefined : open ? "button" : "img"} tabIndex={open ? 0 : undefined}
        aria-label={decorative ? undefined : label} aria-hidden={decorative ? "true" : undefined}
        title={decorative ? undefined : layout.cluster.title} data-mode={mode}
        onClick={open ? (event) => open(event) : undefined}
        onKeyDown={open ? (event) => { if (event.key === "Enter" || event.key === " ") open(event); } : undefined}>
        <i className={rootClass} aria-hidden="true" />
        <span className={`cluster-strip-count${allDone ? " is-done" : ""}`}>{done}/{total}</span>
      </span>
    );
  }

  let lastDepth = -1;
  return (
    <span ref={stripRef} className={stripClassName} role={decorative ? undefined : missionNavigation ? "group" : open ? "button" : "img"}
      tabIndex={!missionNavigation && open ? 0 : undefined} aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? "true" : undefined}
      title={missionNavigation || decorative ? undefined : layout.cluster.title} data-mode={mode}
      onClick={open ? (event) => { if (!missionNavigation || event.target === event.currentTarget) open(event); } : undefined}
      onKeyDown={!missionNavigation && open ? (event) => { if (event.key === "Enter" || event.key === " ") open(event); } : undefined}>
      <span className={missionNavigation && open ? "cluster-strip-cell is-navigation" : "cluster-strip-cell"}
        role={missionNavigation && open ? "button" : undefined} tabIndex={missionNavigation && open ? activeMemberId === null ? 0 : -1 : undefined}
        data-cluster-cell={missionNavigation && open ? "" : undefined}
        aria-label={missionNavigation && open ? t("cluster.picker.coordinator") : undefined}
        title={missionNavigation ? t("cluster.picker.coordinator") : undefined}
        onFocus={missionNavigation && open ? () => setFocusedMemberId(null) : undefined}
        onClick={missionNavigation && open ? (event) => { setFocusedMemberId(null); open(event); } : undefined}
        onKeyDown={missionNavigation && open ? (event) => onCellKeyDown(event) : undefined}>
        <i className={rootClass} aria-hidden="true" />
      </span>
      {layout.members.map((laid) => {
        const separator = laid.depth !== lastDepth;
        lastDepth = laid.depth;
        const member = laid.member;
        const number = member.missionNumber;
        const title = number === undefined ? member.label : member.label.replace(/^\d+\.\s*/, "");
        const state = member.progress === "blocked"
          ? t("cluster.strip.blocked")
          : member.progress === "done" ? t("cluster.nodes.state.done") : t(`cluster.picker.state.${member.progress}`);
        const tip = number === undefined
          ? t("cluster.strip.memberTip", { title, state })
          : t("cluster.strip.missionTip", { n: number, title, state });
        return (
          <span key={member.operationId} className={`cluster-strip-cell${missionNavigation && open ? " is-navigation" : ""}`}
            role={missionNavigation && open ? "button" : undefined} tabIndex={missionNavigation && open ? activeMemberId === member.operationId ? 0 : -1 : undefined}
            data-cluster-cell={missionNavigation && open ? "" : undefined}
            aria-label={missionNavigation && open ? tip : undefined}
            aria-hidden={missionNavigation ? undefined : "true"}
            title={missionNavigation ? tip : undefined}
            onFocus={missionNavigation && open ? () => setFocusedMemberId(member.operationId) : undefined}
            onClick={open ? (event) => { if (missionNavigation) setFocusedMemberId(member.operationId); open(event, member.operationId); } : undefined}
            onKeyDown={missionNavigation && open ? (event) => onCellKeyDown(event, member.operationId) : undefined}>
            {separator ? <i className="cluster-strip-tick" aria-hidden="true" /> : null}
            <i className={`cluster-strip-step is-${member.progress}`} title={missionNavigation ? undefined : member.label} aria-hidden="true" />
          </span>
        );
      })}
    </span>
  );
}
