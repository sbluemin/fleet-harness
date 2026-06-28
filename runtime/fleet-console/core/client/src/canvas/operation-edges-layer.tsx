import { useEffect, useState } from "react";

import type { OperationEdge } from "./operation-edges.js";

interface OperationEdgesProps {
  readonly edges: readonly OperationEdge[];
  // world 레이어의 줌. made-fast 노드 반지름을 1/zoom으로 역보정해 화면상 일정 크기를 유지한다
  // (예삭 stroke는 non-scaling-stroke로 이미 화면 일정 두께라, 노드만 맞춰 보정).
  readonly zoom: number;
}

// world 좌표에서의 made-fast 노드 기본 반지름(px). zoom으로 나눠 화면 일정 크기로 환산한다.
const NODE_RADIUS = 4.5;

// 부모-자식 Operation을 잇는 "지휘 예삭(command tether)" 레이어.
// world 레이어 안에 두어 뷰포트 transform을 함께 받고, 패널보다 DOM 선행이라 글래스 패널 아래에 깔린다.
// 신호 전류(흐름)는 부모(기함)→자식(예하)으로 상시 행진하는 기능적 상태 신호다(ambient 장식 아님).
export function OperationEdges({ edges, zoom }: OperationEdgesProps) {
  // 탭이 백그라운드일 때 흐름을 멈춘다 — radar 스윕과 동일한 성능 처리.
  const [paused, setPaused] = useState(() => typeof document !== "undefined" && document.hidden);

  useEffect(() => {
    const handleVisibilityChange = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  if (edges.length === 0) return null;
  const nodeRadius = NODE_RADIUS / Math.max(zoom, 0.0001);

  return (
    <svg className={`operation-edges${paused ? " is-animation-paused" : ""}`} aria-hidden="true">
      {edges.map((edge) => (
        <g key={edge.id} className="operation-edge">
          <path className="operation-edge-link" d={edge.path} />
          <path className="operation-edge-flow" d={edge.path} />
          <circle className="operation-edge-node" cx={edge.to.x} cy={edge.to.y} r={nodeRadius} />
        </g>
      ))}
    </svg>
  );
}
