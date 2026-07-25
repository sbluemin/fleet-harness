import type { LogCommitEntry } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

export interface GraphNode {
  readonly lane: number;
  readonly activeLaneCount: number;
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
      // 목록에 없는 부모를 기다리는 레인은 이 목록 안에서 다시 등장하지 않는다 — 유령 세로선을 남기지 않도록 제외한다
      .filter(({ h, i }) => h !== null && known.has(h) && i !== myLane)
      .map(({ i }) => i);

    const rowMaxLaneIndex = Math.max(myLane, ...passThroughLanes, ...mergeFromLanes, ...branchToLanes);
    maxLaneIndex = Math.max(maxLaneIndex, rowMaxLaneIndex);

    nodes.push({
      lane: myLane,
      activeLaneCount: rowMaxLaneIndex + 1,
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
