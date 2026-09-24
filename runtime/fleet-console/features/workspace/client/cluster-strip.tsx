import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import type { OperationClusterProgress } from "@fleet-console/sdk/plugin";

import { useT } from "../../../core/client/src/i18n/index.js";
import type { ClusterLaidMember, ClusterLayout } from "./operation-clusters.js";

export type StripMode = "full" | "dense" | "count";

const HEADER_FIXED_PX = 251;

export function requiredWidth(members: readonly ClusterLaidMember[], mode: StripMode): number {
  if (mode === "count") return 48;
  let separators = 0;
  let lastDepth = -1;
  for (const laid of members) {
    if (laid.depth !== lastDepth) {
      if (lastDepth !== -1) separators++;
      lastDepth = laid.depth;
    }
  }
  const n = members.length;
  if (mode === "dense") {
    return 13 + n * 4 + separators * 4;
  }
  return 13 + n * 9 + separators * 6;
}

function computeBudget(element: HTMLElement | null): number {
  if (!element) return 0;
  const titlebar = element.closest<HTMLElement>(".canvas-operation-titlebar");
  if (titlebar) {
    const titlebarWidth = titlebar.clientWidth;
    if (titlebarWidth <= 0) return 0;
    let otherWidth = 0;
    for (const child of Array.from(titlebar.children)) {
      if (
        child.classList.contains("canvas-operation-identity-name") ||
        child.classList.contains("canvas-operation-identity-input") ||
        child.classList.contains("canvas-operation-identity-subject") ||
        child.classList.contains("canvas-operation-cluster-strip") ||
        child === element
      ) {
        continue;
      }
      otherWidth += (child as HTMLElement).offsetWidth || 0;
    }
    const fixed = Math.max(HEADER_FIXED_PX, otherWidth + 24);
    const free = Math.max(0, titlebarWidth - fixed);
    const titleMin = Math.min(160, Math.round(free * 0.6));
    return Math.max(0, free - titleMin);
  }
  const sideBarText = element.closest<HTMLElement>(".side-bar-chip-text") ?? element.parentElement;
  if (sideBarText) {
    return sideBarText.clientWidth;
  }
  return 0;
}

/**
 * 단계 띠 — 묶음을 한 줄로 요약하는 글리프.
 * 폭에 맞춰 가장 자세한 모드를 고른다: full(기본) → dense(촘촘한 칸) → count(고리 + 셈).
 * 뿌리 고리 하나, 깊이 경계마다 눈금, 구성원마다 사각 하나.
 * 색은 진행(구조 안의 자리)이지 세션 활동이 아니다 — 활동은 비콘이 진다.
 */
export function ClusterStrip({ layout, rootActivity, className, onOpen }: {
  readonly layout: ClusterLayout;
  /** 뿌리(조율자) 세션의 활동 — 고리 색. */
  readonly rootActivity?: "idle" | "running" | "awaiting" | "background" | "ended" | null;
  readonly className?: string;
  readonly onOpen?: (operationId: string | undefined, event?: MouseEvent | KeyboardEvent) => void;
}) {
  const t = useT();
  const stripRef = useRef<HTMLSpanElement | null>(null);
  const [mode, setMode] = useState<StripMode>("full");

  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const target =
      el.closest<HTMLElement>(".canvas-operation-titlebar") ??
      el.closest<HTMLElement>(".side-bar-chip-text") ??
      el.parentElement;
    if (!target) return;

    const update = () => {
      const budget = computeBudget(el);
      if (budget <= 0) return;
      const fullW = requiredWidth(layout.members, "full");
      const denseW = requiredWidth(layout.members, "dense");
      const nextMode: StripMode = fullW <= budget ? "full" : denseW <= budget ? "dense" : "count";
      setMode((prev) => (prev !== nextMode ? nextMode : prev));
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, [layout.members]);

  const done = layout.members.filter((laid) => laid.member.progress === "done").length;
  const label = t("cluster.strip.aria", { title: layout.cluster.title, done, total: layout.members.length });
  const open = onOpen ? (event: MouseEvent | KeyboardEvent, operationId?: string) => {
    event.stopPropagation();
    event.preventDefault();
    onOpen(operationId, event);
  } : undefined;

  const isAwaiting = rootActivity === "awaiting" || layout.members.some((laid) => laid.member.progress === "awaiting");
  const rootClass = `cluster-strip-root is-${isAwaiting ? "awaiting" : rootActivity ?? "unknown"}`;
  const allDone = done === layout.members.length && layout.members.length > 0;

  const stripClassName = [
    "cluster-strip",
    mode === "dense" ? "is-dense" : mode === "count" ? "is-count" : "",
    open ? "is-interactive" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  if (mode === "count") {
    return (
      <span
        ref={stripRef}
        className={stripClassName}
        role={open ? "button" : "img"}
        tabIndex={open ? 0 : undefined}
        aria-label={label}
        title={layout.cluster.title}
        data-mode={mode}
        onClick={open ? (event) => open(event) : undefined}
        onKeyDown={open ? (event) => { if (event.key === "Enter" || event.key === " ") { open(event); } } : undefined}
      >
        <i className={rootClass} aria-hidden="true" />
        <span className={`cluster-strip-count${allDone ? " is-done" : ""}`}>
          {done}/{layout.members.length}
        </span>
      </span>
    );
  }

  let lastDepth = -1;
  return (
    <span
      ref={stripRef}
      className={stripClassName}
      role={open ? "button" : "img"}
      tabIndex={open ? 0 : undefined}
      aria-label={label}
      title={layout.cluster.title}
      data-mode={mode}
      onClick={open ? (event) => open(event) : undefined}
      onKeyDown={open ? (event) => { if (event.key === "Enter" || event.key === " ") { open(event); } } : undefined}
    >
      <i className={rootClass} aria-hidden="true" />
      {layout.members.map((laid) => {
        const separator = laid.depth !== lastDepth;
        lastDepth = laid.depth;
        return (
          <span
            key={laid.member.operationId}
            className="cluster-strip-cell"
            aria-hidden="true"
            onClick={open ? (event) => open(event, laid.member.operationId) : undefined}
          >
            {separator ? <i className="cluster-strip-tick" /> : null}
            <i className={`cluster-strip-step is-${laid.member.progress}`} title={laid.member.label} />
          </span>
        );
      })}
    </span>
  );
}

export const progressOrder: readonly OperationClusterProgress[] = ["awaiting", "running", "open", "blocked", "done"];
