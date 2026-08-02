import type { LogCommitEntry } from "../server/types.js";

// ═══ graph-layout ════════════════════════════════════════════════════════════

// ─── types ───────────────────────────────────────────────────────────────────

export interface GraphNode {
  readonly lane: number;
  readonly collapsed: boolean;
  readonly isHead: boolean;
  readonly connectAbove: boolean;
  readonly connectBelow: boolean;
  readonly passThroughLanes: readonly number[];
  readonly mergeFromLanes: readonly number[];
  readonly branchToLanes: readonly number[];
}

export interface GraphLayout {
  readonly nodes: readonly GraphNode[];
  readonly activeLaneCount: number;
  readonly collapsed: boolean;
}

// ─── constants ───────────────────────────────────────────────────────────────

const LANE_HARD_CAP = 8;

// ─── functions ───────────────────────────────────────────────────────────────

export function layoutGraph(commits: readonly LogCommitEntry[]): GraphLayout {
  if (commits.length === 0) {
    return { nodes: [], activeLaneCount: 0, collapsed: false };
  }

  // 목록에 없는 부모 = 서버 쿼리나 필터가 생략한 구간. 레인을 새로 열지 않고 이어 붙이기 위한 판정 근거.
  const known = new Set(commits.map((c) => c.fullHash));
  // laneHeads[i]: 레인 i가 다음에 매치되기를 기다리는 부모 커밋 해시. null = 비어있음(재사용 가능)
  const laneHeads: (string | null)[] = [];
  const nodes: GraphNode[] = [];
  let collapsed = false;
  let maxLaneIndex = 0;

  for (let idx = 0; idx < commits.length; idx++) {
    const c = commits[idx]!;
    const hash = c.fullHash;
    const parents = [...c.parents];

    // 이 커밋 해시를 기다리는 레인들을 찾는다
    const matched: number[] = [];
    for (let i = 0; i < laneHeads.length; i++) {
      if (laneHeads[i] === hash) matched.push(i);
    }

    let myLane: number;
    let usesCollapsedBucket = false;
    const mergeFromLanes: number[] = [];

    if (matched.length === 0) {
      const danglingLane = laneHeads.findIndex((head) => head !== null && !known.has(head));
      if (danglingLane >= 0) {
        myLane = danglingLane;
      } else {
        // 새 레인 개설: 빈 슬롯 재사용 또는 append
        const freeSlot = laneHeads.indexOf(null);
        if (freeSlot >= 0) {
          myLane = freeSlot;
        } else if (laneHeads.length < LANE_HARD_CAP) {
          myLane = laneHeads.length;
          laneHeads.push(null);
        } else {
          // 캡을 넘는 독립 topology는 마지막 레인을 축약 버킷으로 재사용한다.
          // 기존 대기 부모와 현재 부모 모두 추적하지 않아 허위 ancestry 연결을 만들지 않는다.
          collapsed = true;
          myLane = LANE_HARD_CAP - 1;
          laneHeads[myLane] = null;
          usesCollapsedBucket = true;
        }
      }
    } else {
      // 가장 작은 인덱스 레인을 이 커밋의 레인으로
      myLane = Math.min(...matched);
      // 나머지 매치 레인은 병합으로 닫힘
      for (const m of matched) {
        if (m !== myLane) {
          mergeFromLanes.push(m);
          laneHeads[m] = null;
        }
      }
    }

    // 부모 갱신
    const branchToLanes: number[] = [];
    if (parents.length === 0) {
      laneHeads[myLane] = null;
    } else {
      // 첫 번째 부모: 현재 레인 계승
      laneHeads[myLane] = usesCollapsedBucket ? null : (parents[0] ?? null);
      // 나머지 부모: 기존 레인에 이미 기다리는 것이 있으면 재사용, 없으면 새 레인
      for (const parent of parents.slice(1)) {
        // 목록 밖 부모로는 레인을 열지 않는다 — 이어지지 않는 대각선 스텁을 만들기 때문(connectBelow와 동일 판정)
        if (!known.has(parent)) continue;
        const existing = laneHeads.indexOf(parent);
        if (existing >= 0) {
          // 이미 다른 레인이 이 해시를 기다리고 있음 — 새 레인 불필요
        } else {
          const freeSlot = laneHeads.indexOf(null);
          if (freeSlot >= 0) {
            laneHeads[freeSlot] = parent;
            branchToLanes.push(freeSlot);
          } else if (laneHeads.length < LANE_HARD_CAP) {
            const newLane = laneHeads.length;
            laneHeads.push(parent);
            branchToLanes.push(newLane);
          } else {
            collapsed = true;
          }
        }
      }
    }

    // passThroughLanes: 이 행 처리 후 활성인 레인 중 myLane이 아닌 것들
    const passThroughLanes = laneHeads
      .map((h, i) => ({ h, i }))
      // 목록에 없는 부모를 기다리는 레인은 이 목록 안에서 다시 등장하지 않는다 — 유령 세로선을 남기지 않도록 제외한다.
      // 이 행에서 갓 개설된 분기 레인은 대각선이 담당한다 — 수직선까지 그리면 분기점 위로 돌출된다.
      .filter(({ h, i }) => h !== null && known.has(h) && i !== myLane && !branchToLanes.includes(i))
      .map(({ i }) => i);

    const rowMaxLaneIndex = Math.max(myLane, ...passThroughLanes, ...mergeFromLanes, ...branchToLanes);
    maxLaneIndex = Math.max(maxLaneIndex, rowMaxLaneIndex);

    nodes.push({
      lane: myLane,
      collapsed,
      isHead: c.refs.some((r) => r === "HEAD" || r.startsWith("HEAD ->")),
      connectAbove: matched.length > 0,
      connectBelow: parents.length > 0 && laneHeads[myLane] === parents[0] && known.has(parents[0]!),
      passThroughLanes,
      mergeFromLanes,
      branchToLanes,
    });
  }

  return { nodes, activeLaneCount: maxLaneIndex + 1, collapsed };
}

// ═══ graph-gutter ════════════════════════════════════════════════════════════

// ─── types ───────────────────────────────────────────────────────────────────

interface GraphGutterProps {
  readonly node: GraphNode;
  readonly laneCount: number;
}

// ─── constants ───────────────────────────────────────────────────────────────

const LANE_WIDTH = 12;
// .history-commit-row의 고정 높이(diff.css)와 반드시 일치해야 행 간 레인 선이 이음새 없이 연결된다
export const ROW_HEIGHT = 28;
const NODE_R = 3;
const HEAD_RING_R = 5;
// 장식적 구분 채도는 --id-* 정체성 봉투에서만 가져온다 — 테마별 재조율·상태 신호와
// 혼동할 수 없어야 한다. 신호 토큰(warn/positive/aurora) 순환은 상태 채널을 침범하므로 폐기.
const LANE_COLORS = [
  "var(--id-cerulean)",
  "var(--id-plum)",
  "var(--id-amber)",
  "var(--id-teal)",
  "var(--id-moss)",
  "var(--id-indigo)",
  "var(--id-rose)",
  "var(--id-crimson)",
] as const;

// ─── helpers ─────────────────────────────────────────────────────────────────

function laneCx(lane: number): number {
  return lane * LANE_WIDTH + 6;
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length] ?? "var(--ink-fog)";
}

// ─── GraphGutter ─────────────────────────────────────────────────────────────

export function GraphGutter({ node, laneCount }: GraphGutterProps) {
  const lanes = Math.max(laneCount, 1);
  const collapseIndicatorWidth = node.collapsed ? 10 : 0;
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
      {node.collapsed && (
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
