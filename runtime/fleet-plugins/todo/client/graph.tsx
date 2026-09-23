import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import { coordinatorMode, isLoose, stepDepths, stepReady, unseenRecords, wouldCycle, type TodoItem } from "../server/types.js";
import type { TodoMessageKey } from "./i18n/index.js";

/**
 * 조율 그래프 — 선행 관계를 그리고 편집하는 유일한 자리.
 * 노드에서 다음 노드로 끌면 간선이 이어지고, 선을 누르면 끊긴다. 순환은 잇기 전에 거절한다.
 * 사람이 선행 없이 더한 미분류 단계는 그래프 아래 「미분류」 칸에 따로 선다 — 셰프가 자리를 정하거나, 사람이 여기서 이으면 올라간다.
 */

interface GraphProps {
  readonly item: TodoItem;
  readonly t: Translate<TodoMessageKey>;
  readonly modeLabel: string;
  readonly onToggleEdge: (from: string, to: string) => void;
  readonly onCycle: () => void;
  readonly operationTitle: (operationId: string) => string;
  /** 확대본 — 넓은 폭에 줄이지 않은 제목. 사이드 패널에서는 생략한다. */
  readonly zoom?: boolean;
  readonly vertical?: boolean;
  /** 빈 배경을 누르면 확대본을 연다. 노드·간선 위의 누름과 드래그 끝은 제외. */
  readonly onZoom?: () => void;
  /** 이 단계의 선행을 사람이 바꿀 수 있는가 — 셰프가 일하는 동안은 시작 전 단계만. 없으면 모두. */
  readonly canEdit?: (stepId: string) => boolean;
  /** 짚은 단계 — 단계 목록과 함께 켜진다. 그 단계와 선행, 들어오는 선이 강조된다. */
  readonly focusStepId?: string | null;
  readonly onFocusStep?: (stepId: string | null) => void;
}

export function CoordinationGraph({ item, t, modeLabel, onToggleEdge, onCycle, operationTitle, zoom = false, vertical = false, onZoom, canEdit, focusStepId = null, onFocusStep }: GraphProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ from: string; x0: number; y0: number; x: number; y: number; over: string | null } | null>(null);
  const movedRef = useRef(false);
  // 노드에서 시작한 누름 — 포인터 캡처 탓에 뒤따르는 click 의 target 이 svg 가 되므로, 노드 누름은 여기서 기억해 확대를 막는다.
  const pressedNodeRef = useRef(false);

  const steps = item.steps;
  // 미분류 — 열·행 배치에서 빼고 아래 칸에 줄 세운다.
  const loose = steps.filter(isLoose);
  const placedSteps = steps.filter((step) => !loose.includes(step));
  // 열은 스토어가 단계 순서를 정할 때와 같은 값 — 그래서 번호가 왼쪽에서 오른쪽으로 커진다.
  const depth = stepDepths(steps);
  const byId = new Map(steps.map((step) => [step.id, step]));
  const focused = focusStepId ? byId.get(focusStepId) ?? null : null;
  const columns = placedSteps.length ? Math.max(...placedSteps.map((step) => depth.get(step.id) ?? 0)) + 1 : 0;
  const W = zoom ? 880 : 320;
  // 첫 열의 x — 확대본은 뿌리(셰프)와 첫 단계 사이를 넓혀 긴 제목이 뿌리 라벨을 덮지 않게 한다.
  const left = zoom ? 150 : 88;
  const colW = columns ? Math.min(zoom ? 150 : 92, (W - left + 4) / Math.max(columns, 1)) : 0;
  const rowH = zoom ? 56 : 42;
  const byDepth = new Map<number, string[]>();
  for (const step of placedSteps) { const d = depth.get(step.id) ?? 0; byDepth.set(d, [...(byDepth.get(d) ?? []), step.id]); }
  const rows = Math.max(1, ...[...byDepth.values()].map((ids) => ids.length));
  // 노드 아래 제목은 열 간격에 맞춰 줄인다. 열이 촘촘하면(긴 일렬) 위·아래를 번갈아 써서 이웃과 겹치지 않게 하고,
  // 그래도 서너 글자가 안 들어가면 제목을 숨긴다 — 번호와 툴팁, 그리고 위의 단계 목록이 남는다.
  const CHAR = zoom ? 12.5 : 11;
  const fitIn = (width: number) => Math.min(zoom ? 22 : 8, Math.floor((width - 6) / CHAR));
  // 확대본은 늘 엇갈려 쓴다 — 이웃 두 칸을 라벨 하나가 쓰니 제목이 두 배로 보인다.
  const stagger = columns > 1 && (zoom || fitIn(colW) < 5);
  const fit = stagger ? fitIn(colW * 2) : fitIn(colW);
  const showLabels = fit >= 3;
  const lift = stagger && showLabels ? 12 : 0;
  const body = Math.max(70, rows * rowH + 26) + lift;
  const trayH = loose.length ? (zoom ? 52 : 40) : 0;
  const H = body + trayH;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of byDepth) ids.forEach((id, r) => pos.set(id, { x: left + d * colW, y: 16 + lift + r * rowH + ((rows - ids.length) * rowH) / 2 }));
  const trayGap = Math.min(zoom ? 64 : 30, (W - left - 12) / Math.max(loose.length, 1));
  loose.forEach((step, i) => pos.set(step.id, { x: left + i * trayGap, y: body + trayH / 2 - 2 }));
  const root = { x: zoom ? 30 : 20, y: body / 2 };
  const shorten = (text: string) => (text.length > fit ? `${text.slice(0, Math.max(1, fit - 1))}…` : text);

  const point = (event: ReactPointerEvent | PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = event.clientX; pt.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const local = pt.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  };
  const nodeAt = (clientX: number, clientY: number): string | null => {
    const element = document.elementFromPoint(clientX, clientY);
    const node = element?.closest?.(".todo-node[data-k]") as SVGGElement | null;
    return node?.dataset.k ?? null;
  };

  const onPointerDown = (id: string) => (event: ReactPointerEvent<SVGGElement>) => {
    const p = pos.get(id);
    if (!p) return;
    (event.currentTarget.closest("svg") as SVGSVGElement | null)?.setPointerCapture?.(event.pointerId);
    movedRef.current = false;
    pressedNodeRef.current = true;
    setDrag({ from: id, x0: p.x, y0: p.y, x: p.x, y: p.y, over: null });
    event.preventDefault();
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const local = point(event);
    if (Math.hypot(local.x - drag.x0, local.y - drag.y0) > 3) movedRef.current = true;
    const over = nodeAt(event.clientX, event.clientY);
    setDrag({ ...drag, x: local.x, y: local.y, over: over && over !== drag.from ? over : null });
  };
  const finish = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const target = nodeAt(event.clientX, event.clientY);
    setDrag(null);
    if (!target || target === drag.from) return;
    const to = byId.get(target);
    if (!to) return;
    if (canEdit && !canEdit(target)) return;
    if (!to.after.includes(drag.from) && wouldCycle(steps, drag.from, target)) { onCycle(); return; }
    onToggleEdge(drag.from, target);
  };

  const mode = coordinatorMode(item);
  if (vertical) return (
    <div className="todo-dag-box todo-dag-vertical">
      <div className="todo-dag-row is-root"><span className="todo-dag-dot" aria-hidden="true" /><span>{t("todo.graph.coordinator")}</span></div>
      {steps.map((step, index) => <div
        key={step.id}
        className={`todo-dag-row${focused?.id === step.id ? " is-focus" : focused?.after.includes(step.id) ? " is-pre" : ""}`}
        onPointerEnter={onFocusStep ? () => onFocusStep(step.id) : undefined}
        onPointerLeave={onFocusStep ? () => onFocusStep(null) : undefined}
        title={step.after.length ? t("todo.graph.edgeAria", { from: steps.findIndex((candidate) => candidate.id === step.after[0]) + 1, to: index + 1 }) : undefined}>
        <span className={`todo-dag-dot${step.done ? " is-done" : step.slot ? " is-assigned" : ""}`}>{index + 1}</span><span className="todo-dag-step-name">{step.text}</span>
      </div>)}
      <span hidden>{mode}</span>
    </div>
  );
  return (
    <div className={`todo-dag-box${onZoom ? " can-zoom" : ""}${zoom ? " is-zoom" : ""}`}>
      <svg
        ref={svgRef}
        className={`todo-dag${drag ? " is-dragging" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        role="img"
        aria-label={t("todo.graph.title")}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={() => setDrag(null)}
        onClick={onZoom ? (event) => {
          const fromNode = pressedNodeRef.current || movedRef.current;
          pressedNodeRef.current = false; movedRef.current = false;
          if (fromNode) return;
          if ((event.target as Element).closest(".todo-node[data-k], .todo-edge[data-from]")) return;
          onZoom();
        } : undefined}
      >
        {steps.map((step) => {
          const p = pos.get(step.id)!;
          return (
            <g key={`edges-${step.id}`}>
              {step.after.length === 0 && !loose.includes(step) ? <path className="todo-edge is-root" d={`M${root.x + 9},${root.y} C${root.x + 30},${root.y} ${p.x - 30},${p.y} ${p.x - 9},${p.y}`} /> : null}
              {step.after.map((parentId) => {
                const q = pos.get(parentId);
                if (!q) return null;
                const from = steps.findIndex((candidate) => candidate.id === parentId) + 1;
                const to = steps.indexOf(step) + 1;
                const why = step.why?.[parentId];
                return (
                  <path
                    key={`${parentId}-${step.id}`}
                    className={`todo-edge${byId.get(parentId)?.done ? " is-met" : ""}${focused?.id === step.id ? " is-hot" : ""}`}
                    data-from={parentId}
                    data-to={step.id}
                    d={`M${q.x + 9},${q.y} C${q.x + 28},${q.y} ${p.x - 28},${p.y} ${p.x - 9},${p.y}`}
                    role="button"
                    tabIndex={0}
                    aria-label={t("todo.graph.edgeAria", { from, to })}
                    onClick={() => { if (!canEdit || canEdit(step.id)) onToggleEdge(parentId, step.id); }}
                    onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && (!canEdit || canEdit(step.id))) { event.preventDefault(); onToggleEdge(parentId, step.id); } }}
                  >
                    <title>{`${from} → ${to}${why && why !== "human" ? ` · ${why}` : ""}`}</title>
                  </path>
                );
              })}
            </g>
          );
        })}
        {loose.length ? (
          <g className="todo-dag-tray" aria-hidden="true">
            <rect x={6} y={body + 2} width={W - 12} height={trayH - 8} rx={7} />
            <text x={root.x + (zoom ? 18 : 10)} y={body + trayH / 2 + 1} textAnchor="middle">{t("todo.graph.unplaced")}</text>
          </g>
        ) : null}
        {drag ? <path className="todo-edge is-ghost" d={`M${drag.x0},${drag.y0} L${drag.x},${drag.y}`} pointerEvents="none" /> : null}
        <g className={`todo-node is-root${item.slot ? " is-assigned" : ""}`}>
          <circle cx={root.x} cy={root.y} r={9} />
          {/* 뿌리 라벨은 항상 「조율자」 — 모드는 조율자 행이 말하고, 긴 모드명은 그래프 왼쪽 가장자리에서 잘린다. */}
          <text x={root.x} y={root.y + 21} textAnchor="middle">{t("todo.graph.coordinator")}</text>
          {item.slot ? <title>{`${operationTitle(item.slot.operationId)} · ${modeLabel}`}</title> : null}
        </g>
        {steps.map((step, index) => {
          const p = pos.get(step.id)!;
          const unplaced = loose.includes(step);
          const cls = step.done ? "is-done" : step.slot ? "is-assigned" : unplaced ? "is-unplaced" : stepReady(item, step) ? "is-ready" : "is-wait";
          // 노드 곁에는 단계 제목을 줄여 쓴다 — 모델·강도는 단계 행이 말한다.
          // 짝수 열은 위, 홀수 열은 아래 — 첫 열이 위로 가야 뿌리의 「셰프」 라벨과 같은 줄에 놓이지 않는다.
          const above = stagger && (depth.get(step.id) ?? 0) % 2 === 0;
          return (
            <g
              key={step.id}
              className={`todo-node ${cls}${drag?.over === step.id ? " is-over" : ""}${focused?.id === step.id ? " is-focus" : focused?.after.includes(step.id) ? " is-pre" : ""}`}
              data-k={step.id}
              tabIndex={0}
              role="button"
              aria-label={t("todo.graph.nodeAria", { index: index + 1, text: step.text })}
              onPointerDown={onPointerDown(step.id)}
              onPointerEnter={onFocusStep ? () => onFocusStep(step.id) : undefined}
              onPointerLeave={onFocusStep ? () => onFocusStep(null) : undefined}
              onFocus={onFocusStep ? () => onFocusStep(step.id) : undefined}
              onBlur={onFocusStep ? () => onFocusStep(null) : undefined}
            >
              <circle cx={p.x} cy={p.y} r={9} />
              <text x={p.x} y={p.y + 3.5} textAnchor="middle" className="todo-num">{index + 1}</text>
              {/* 안 읽은 단계 기록 — 노드 오른쪽 위 작은 점. 단계 줄의 기록 수를 펼치면 사라진다. */}
              {unseenRecords(step) > 0 ? <circle className="todo-node-unseen" cx={p.x + 7} cy={p.y - 7} r={3} /> : null}
              {showLabels && !unplaced ? <text x={p.x} y={above ? p.y - 15 : p.y + 21} textAnchor="middle">{shorten(step.text)}</text> : null}
              <title>{`${index + 1}. ${step.text}`}</title>
            </g>
          );
        })}
      </svg>
      {steps.length > 1 ? <div className="todo-dag-hint">{t("todo.graph.hint")}</div> : null}
      <span hidden>{mode}</span>
    </div>
  );
}
