import type { LogCommitEntry } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

export interface GraphNode {
  readonly lane: number;
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

const LANE_HARD_CAP = 3;

// ─── functions ───────────────────────────────────────────────────────────────

export function layoutGraph(commits: readonly LogCommitEntry[]): GraphLayout {
  if (commits.length === 0) {
    return { nodes: [], activeLaneCount: 0, collapsed: false };
  }

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
    const mergeFromLanes: number[] = [];

    if (matched.length === 0) {
      // 새 레인 개설: 빈 슬롯 재사용 또는 append
      const freeSlot = laneHeads.indexOf(null);
      if (freeSlot >= 0) {
        myLane = freeSlot;
      } else {
        myLane = laneHeads.length;
        laneHeads.push(null);
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
      laneHeads[myLane] = parents[0] ?? null;
      // 나머지 부모: 기존 레인에 이미 기다리는 것이 있으면 재사용, 없으면 새 레인
      for (const parent of parents.slice(1)) {
        const existing = laneHeads.indexOf(parent);
        if (existing >= 0) {
          // 이미 다른 레인이 이 해시를 기다리고 있음 — 새 레인 불필요
        } else {
          const freeSlot = laneHeads.indexOf(null);
          if (freeSlot >= 0) {
            laneHeads[freeSlot] = parent;
            branchToLanes.push(freeSlot);
          } else {
            const newLane = laneHeads.length;
            laneHeads.push(parent);
            branchToLanes.push(newLane);
          }
        }
      }
    }

    // 하드캡 3 적용: 활성 레인 수 초과 시 초과분 제거
    const activeLanes = laneHeads
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h !== null)
      .map(({ i }) => i);

    if (activeLanes.length > LANE_HARD_CAP) {
      collapsed = true;
      // 가장 최근에 새로 개설된 레인(인덱스가 큰 것)부터 축약
      const toCollapse = activeLanes
        .filter((i) => i !== myLane)
        .sort((a, b) => b - a)
        .slice(0, activeLanes.length - LANE_HARD_CAP);
      for (const lane of toCollapse) {
        laneHeads[lane] = null;
        // branchToLanes에서도 제거
        const btIdx = branchToLanes.indexOf(lane);
        if (btIdx >= 0) branchToLanes.splice(btIdx, 1);
      }
    }

    // passThroughLanes: 이 행 처리 후 활성인 레인 중 myLane이 아닌 것들
    const passThroughLanes = laneHeads
      .map((h, i) => ({ h, i }))
      .filter(({ h, i }) => h !== null && i !== myLane)
      .map(({ i }) => i);

    // 최대 레인 인덱스 추적
    maxLaneIndex = Math.max(maxLaneIndex, myLane, ...branchToLanes, ...passThroughLanes);

    nodes.push({
      lane: myLane,
      isHead: c.refs.includes("HEAD") || idx === 0,
      connectAbove: idx > 0,
      connectBelow: idx < commits.length - 1,
      passThroughLanes,
      mergeFromLanes,
      branchToLanes,
    });
  }

  return { nodes, activeLaneCount: maxLaneIndex + 1, collapsed };
}
