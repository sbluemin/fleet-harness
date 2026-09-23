import type { KeyboardEvent, MouseEvent } from "react";

import type { OperationClusterProgress } from "@fleet-console/sdk/plugin";

import { useT } from "../../../core/client/src/i18n/index.js";
import type { ClusterLayout } from "./operation-clusters.js";

/**
 * 단계 띠 — 묶음을 한 줄로 요약하는 글리프. 뿌리 고리 하나, 깊이 경계마다 눈금, 구성원마다 사각 하나.
 * 사이드바 뿌리 행·캔버스 캡션·War Room 무대 어디서든 같은 크기라 사용자가 한 번 배우면 끝난다.
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
  const done = layout.members.filter((laid) => laid.member.progress === "done").length;
  const label = t("cluster.strip.aria", { title: layout.cluster.title, done, total: layout.members.length });
  const open = onOpen ? (event: MouseEvent, operationId?: string) => { event.stopPropagation(); event.preventDefault(); onOpen(operationId, event); } : undefined;
  let lastDepth = -1;
  return (
    <span
      className={["cluster-strip", open ? "is-interactive" : "", className ?? ""].filter(Boolean).join(" ")}
      role={open ? "button" : "img"}
      tabIndex={open ? 0 : undefined}
      aria-label={label}
      title={layout.cluster.title}
      onClick={open ? (event) => open(event) : undefined}
      onKeyDown={open ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onOpen?.(undefined, event); } } : undefined}
    >
      <i className={`cluster-strip-root is-${rootActivity ?? "unknown"}`} aria-hidden="true" />
      {layout.members.map((laid) => {
        const separator = laid.depth !== lastDepth;
        lastDepth = laid.depth;
        return (
          <span key={laid.member.operationId} className="cluster-strip-cell" aria-hidden="true">
            {separator ? <i className="cluster-strip-tick" /> : null}
            <i className={`cluster-strip-step is-${laid.member.progress}`} title={laid.member.label} />
          </span>
        );
      })}
    </span>
  );
}

export const progressOrder: readonly OperationClusterProgress[] = ["awaiting", "running", "open", "blocked", "done"];
