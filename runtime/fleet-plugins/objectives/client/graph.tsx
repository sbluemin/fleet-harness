import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import { commanderMode, isLoose, missionDepths, missionReady, unseenRecords, wouldCycle, type Objective } from "../server/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";

/**
 * 조율 그래프 — 선행 관계를 그리고 편집하는 유일한 자리.
 * 노드에서 다음 노드로 끌면 간선이 이어지고, 선을 누르면 끊긴다. 순환은 잇기 전에 거절한다.
 * 사람이 선행 없이 더한 미분류 임무는 그래프 아래 「미분류」 칸에 따로 선다 — 지휘관이 자리를 정하거나, 사람이 여기서 이으면 올라간다.
 */

interface GraphProps {
  readonly objective: Objective;
  readonly t: Translate<ObjectiveMessageKey>;
  readonly modeLabel: string;
  readonly onToggleEdge: (from: string, to: string) => void;
  readonly onCycle: () => void;
  readonly operationTitle: (operationId: string) => string;
  /** 확대본 — 넓은 폭에 줄이지 않은 제목. 사이드 패널에서는 생략한다. */
  readonly zoom?: boolean;
  readonly vertical?: boolean;
  /** 빈 배경을 누르면 확대본을 연다. 노드·간선 위의 누름과 드래그 끝은 제외. */
  readonly onZoom?: () => void;
  /** 이 임무의 선행을 사람이 바꿀 수 있는가 — 지휘관이 일하는 동안은 시작 전 임무만. 없으면 모두. */
  readonly canEdit?: (missionId: string) => boolean;
  /** 짚은 임무 — 임무 목록과 함께 켜진다. 그 임무와 선행, 들어오는 선이 강조된다. */
  readonly focusMissionId?: string | null;
  readonly onFocusMission?: (missionId: string | null) => void;
}

export function CoordinationGraph({ objective, t, modeLabel, onToggleEdge, onCycle, operationTitle, zoom = false, vertical = false, onZoom, canEdit, focusMissionId = null, onFocusMission }: GraphProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ from: string; x0: number; y0: number; x: number; y: number; over: string | null } | null>(null);
  const movedRef = useRef(false);
  // 노드에서 시작한 누름 — 포인터 캡처 탓에 뒤따르는 click 의 target 이 svg 가 되므로, 노드 누름은 여기서 기억해 확대를 막는다.
  const pressedNodeRef = useRef(false);

  const missions = objective.missions;
  // 미분류 — 열·행 배치에서 빼고 아래 칸에 줄 세운다.
  const loose = missions.filter(isLoose);
  const placedMissions = missions.filter((mission) => !loose.includes(mission));
  // 열은 스토어가 임무 순서를 정할 때와 같은 값 — 그래서 번호가 왼쪽에서 오른쪽으로 커진다.
  const depth = missionDepths(missions);
  const byId = new Map(missions.map((mission) => [mission.id, mission]));
  const focused = focusMissionId ? byId.get(focusMissionId) ?? null : null;
  const columns = placedMissions.length ? Math.max(...placedMissions.map((mission) => depth.get(mission.id) ?? 0)) + 1 : 0;
  const W = zoom ? 880 : 320;
  // 첫 열의 x — 확대본은 뿌리(지휘관)와 첫 임무 사이를 넓혀 긴 제목이 뿌리 라벨을 덮지 않게 한다.
  const left = zoom ? 150 : 88;
  const colW = columns ? Math.min(zoom ? 150 : 92, (W - left + 4) / Math.max(columns, 1)) : 0;
  const rowH = zoom ? 56 : 42;
  const byDepth = new Map<number, string[]>();
  for (const mission of placedMissions) { const d = depth.get(mission.id) ?? 0; byDepth.set(d, [...(byDepth.get(d) ?? []), mission.id]); }
  const rows = Math.max(1, ...[...byDepth.values()].map((ids) => ids.length));
  // 노드 아래 제목은 열 간격에 맞춰 줄인다. 열이 촘촘하면(긴 일렬) 위·아래를 번갈아 써서 이웃과 겹치지 않게 하고,
  // 그래도 서너 글자가 안 들어가면 제목을 숨긴다 — 번호와 툴팁, 그리고 위의 임무 목록이 남는다.
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
  loose.forEach((mission, i) => pos.set(mission.id, { x: left + i * trayGap, y: body + trayH / 2 - 2 }));
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
    const node = element?.closest?.(".objectives-node[data-k]") as SVGGElement | null;
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
    if (!to.prerequisites.includes(drag.from) && wouldCycle(missions, drag.from, target)) { onCycle(); return; }
    onToggleEdge(drag.from, target);
  };

  const mode = commanderMode(objective.missions);
  if (vertical) return (
    <div className="objectives-dag-box objectives-dag-vertical">
      <div className="objectives-dag-row is-root"><span className="objectives-dag-dot" aria-hidden="true" /><span>{t("objectives.graph.commander")}</span></div>
      {missions.map((mission, index) => <div
        key={mission.id}
        className={`objectives-dag-row${focused?.id === mission.id ? " is-focus" : focused?.prerequisites.includes(mission.id) ? " is-pre" : ""}`}
        onPointerEnter={onFocusMission ? () => onFocusMission(mission.id) : undefined}
        onPointerLeave={onFocusMission ? () => onFocusMission(null) : undefined}
        title={mission.prerequisites.length ? t("objectives.graph.edgeAria", { from: missions.findIndex((candidate) => candidate.id === mission.prerequisites[0]) + 1, to: index + 1 }) : undefined}>
        <span className={`objectives-dag-dot${mission.done ? " is-done" : mission.member ? " is-assigned" : ""}`}>{index + 1}</span><span className="objectives-dag-mission-name">{mission.text}</span>
      </div>)}
      <span hidden>{mode}</span>
    </div>
  );
  return (
    <div className={`objectives-dag-box${onZoom ? " can-zoom" : ""}${zoom ? " is-zoom" : ""}`}>
      <svg
        ref={svgRef}
        className={`objectives-dag${drag ? " is-dragging" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        role="img"
        aria-label={t("objectives.graph.title")}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={() => setDrag(null)}
        onClick={onZoom ? (event) => {
          const fromNode = pressedNodeRef.current || movedRef.current;
          pressedNodeRef.current = false; movedRef.current = false;
          if (fromNode) return;
          if ((event.target as Element).closest(".objectives-node[data-k], .objectives-edge[data-from]")) return;
          onZoom();
        } : undefined}
      >
        {missions.map((mission) => {
          const p = pos.get(mission.id)!;
          return (
            <g key={`edges-${mission.id}`}>
              {mission.prerequisites.length === 0 && !loose.includes(mission) ? <path className="objectives-edge is-root" d={`M${root.x + 9},${root.y} C${root.x + 30},${root.y} ${p.x - 30},${p.y} ${p.x - 9},${p.y}`} /> : null}
              {mission.prerequisites.map((parentId) => {
                const q = pos.get(parentId);
                if (!q) return null;
                const from = missions.findIndex((candidate) => candidate.id === parentId) + 1;
                const to = missions.indexOf(mission) + 1;
                const why = mission.why?.[parentId];
                return (
                  <path
                    key={`${parentId}-${mission.id}`}
                    className={`objectives-edge${byId.get(parentId)?.done ? " is-met" : ""}${focused?.id === mission.id ? " is-hot" : ""}`}
                    data-from={parentId}
                    data-to={mission.id}
                    d={`M${q.x + 9},${q.y} C${q.x + 28},${q.y} ${p.x - 28},${p.y} ${p.x - 9},${p.y}`}
                    role="button"
                    tabIndex={0}
                    aria-label={t("objectives.graph.edgeAria", { from, to })}
                    onClick={() => { if (!canEdit || canEdit(mission.id)) onToggleEdge(parentId, mission.id); }}
                    onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && (!canEdit || canEdit(mission.id))) { event.preventDefault(); onToggleEdge(parentId, mission.id); } }}
                  >
                    <title>{`${from} → ${to}${why && why !== "human" ? ` · ${why}` : ""}`}</title>
                  </path>
                );
              })}
            </g>
          );
        })}
        {loose.length ? (
          <g className="objectives-dag-tray" aria-hidden="true">
            <rect x={6} y={body + 2} width={W - 12} height={trayH - 8} rx={7} />
            <text x={root.x + (zoom ? 18 : 10)} y={body + trayH / 2 + 1} textAnchor="middle">{t("objectives.graph.unplaced")}</text>
          </g>
        ) : null}
        {drag ? <path className="objectives-edge is-ghost" d={`M${drag.x0},${drag.y0} L${drag.x},${drag.y}`} pointerEvents="none" /> : null}
        <g className="objectives-node is-root is-assigned">
          <circle cx={root.x} cy={root.y} r={9} />
          {/* 뿌리 라벨은 항상 「지휘관」 — 모드는 지휘관 행이 말하고, 긴 모드명은 그래프 왼쪽 가장자리에서 잘린다. */}
          <text x={root.x} y={root.y + 21} textAnchor="middle">{t("objectives.graph.commander")}</text>
          <title>{`${operationTitle(objective.id)} · ${modeLabel}`}</title>
        </g>
        {missions.map((mission, index) => {
          const p = pos.get(mission.id)!;
          const unplaced = loose.includes(mission);
          const cls = mission.done ? "is-done" : mission.operationId ? "is-assigned" : unplaced ? "is-unplaced" : missionReady(objective.missions, mission) ? "is-ready" : "is-wait";
          // 노드 곁에는 임무 제목을 줄여 쓴다 — 모델·강도는 임무 행이 말한다.
          // 짝수 열은 위, 홀수 열은 아래 — 첫 열이 위로 가야 뿌리의 「지휘관」 라벨과 같은 줄에 놓이지 않는다.
          const above = stagger && (depth.get(mission.id) ?? 0) % 2 === 0;
          return (
            <g
              key={mission.id}
              className={`objectives-node ${cls}${drag?.over === mission.id ? " is-over" : ""}${focused?.id === mission.id ? " is-focus" : focused?.prerequisites.includes(mission.id) ? " is-pre" : ""}`}
              data-k={mission.id}
              tabIndex={0}
              role="button"
              aria-label={t("objectives.graph.nodeAria", { index: index + 1, text: mission.text })}
              onPointerDown={onPointerDown(mission.id)}
              onPointerEnter={onFocusMission ? () => onFocusMission(mission.id) : undefined}
              onPointerLeave={onFocusMission ? () => onFocusMission(null) : undefined}
              onFocus={onFocusMission ? () => onFocusMission(mission.id) : undefined}
              onBlur={onFocusMission ? () => onFocusMission(null) : undefined}
            >
              <circle cx={p.x} cy={p.y} r={9} />
              <text x={p.x} y={p.y + 3.5} textAnchor="middle" className="objectives-num">{index + 1}</text>
              {/* 안 읽은 임무 기록 — 노드 오른쪽 위 작은 점. 임무 줄의 기록 수를 펼치면 사라진다. */}
              {unseenRecords(mission) > 0 ? <circle className="objectives-node-unseen" cx={p.x + 7} cy={p.y - 7} r={3} /> : null}
              {showLabels && !unplaced ? <text x={p.x} y={above ? p.y - 15 : p.y + 21} textAnchor="middle">{shorten(mission.text)}</text> : null}
              <title>{`${index + 1}. ${mission.text}`}</title>
            </g>
          );
        })}
      </svg>
      {missions.length > 1 ? <div className="objectives-dag-hint">{t("objectives.graph.hint")}</div> : null}
      <span hidden>{mode}</span>
    </div>
  );
}
