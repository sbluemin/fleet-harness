import type { GraphNode } from "./graph-layout.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface GraphGutterProps {
  readonly node: GraphNode;
  readonly laneCount: number;
  readonly collapsed?: boolean;
}

// ─── constants ───────────────────────────────────────────────────────────────

const LANE_WIDTH = 12;
const ROW_HEIGHT = 20;
const NODE_R = 3;
const HEAD_RING_R = 5;
const LANE_COLORS = [
  "var(--brass)",
  "var(--aurora)",
  "var(--warn)",
  "var(--positive)",
  "color-mix(in oklch, var(--brass) 70%, var(--aurora))",
  "color-mix(in oklch, var(--aurora) 70%, var(--positive))",
  "color-mix(in oklch, var(--warn) 72%, var(--brass))",
  "color-mix(in oklch, var(--ink-spectral) 76%, var(--aurora))",
] as const;

// ─── helpers ─────────────────────────────────────────────────────────────────

function laneCx(lane: number): number {
  return lane * LANE_WIDTH + 6;
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length] ?? "var(--ink-fog)";
}

// ─── GraphGutter ─────────────────────────────────────────────────────────────

export function GraphGutter({ node, laneCount, collapsed = false }: GraphGutterProps) {
  const lanes = Math.max(laneCount, 1);
  const collapseIndicatorWidth = collapsed ? 10 : 0;
  const width = lanes * LANE_WIDTH + collapseIndicatorWidth;
  const cx = laneCx(node.lane);
  const cy = ROW_HEIGHT / 2;

  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      {/* passThrough 수직선 */}
      {node.passThroughLanes.map((lane) => (
        <line
          key={`pt-${lane}`}
          x1={laneCx(lane)}
          y1={0}
          x2={laneCx(lane)}
          y2={ROW_HEIGHT}
          stroke={laneColor(lane)}
          strokeWidth={1.5}
        />
      ))}

      {/* 위로 연결선 */}
      {node.connectAbove && (
        <line
          x1={cx}
          y1={0}
          x2={cx}
          y2={cy - NODE_R}
          stroke={laneColor(node.lane)}
          strokeWidth={1.5}
        />
      )}

      {/* 아래로 연결선 */}
      {node.connectBelow && (
        <line
          x1={cx}
          y1={cy + NODE_R}
          x2={cx}
          y2={ROW_HEIGHT}
          stroke={laneColor(node.lane)}
          strokeWidth={1.5}
        />
      )}

      {/* mergeFromLanes: 병합으로 닫히는 레인 — 위쪽에서 노드로 대각선 */}
      {node.mergeFromLanes.map((lane) => (
        <line
          key={`mf-${lane}`}
          x1={laneCx(lane)}
          y1={0}
          x2={cx}
          y2={cy}
          stroke={laneColor(lane)}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}

      {/* branchToLanes: 노드에서 새로 분기되는 레인 — 아래로 대각선 */}
      {node.branchToLanes.map((lane) => (
        <line
          key={`bt-${lane}`}
          x1={cx}
          y1={cy}
          x2={laneCx(lane)}
          y2={ROW_HEIGHT}
          stroke={laneColor(lane)}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}

      {/* HEAD 링 */}
      {node.isHead && (
        <circle
          cx={cx}
          cy={cy}
          r={HEAD_RING_R}
          fill="none"
          stroke={laneColor(node.lane)}
          strokeWidth={1.5}
        />
      )}

      {/* 노드 원 */}
      <circle
        cx={cx}
        cy={cy}
        r={NODE_R}
        fill={laneColor(node.lane)}
      />

      {/* collapse 인디케이터 */}
      {collapsed && (
        <text
          x={lanes * LANE_WIDTH + 2}
          y={cy + 4}
          fontSize={10}
          fontFamily="monospace"
          fill="var(--ink-fog)"
        >
          ⋯
        </text>
      )}
    </svg>
  );
}
