import { describe, expect, it } from "vitest";

import { layoutGraph } from "../client/graph-layout.js";
import type { LogCommitEntry } from "../server/types.js";

function makeCommit(overrides: Partial<LogCommitEntry> = {}): LogCommitEntry {
  return {
    shortHash: "abc1234",
    fullHash: "abc1234def5678abc1234def5678abc1234def56",
    subject: "test commit",
    authorName: "Author",
    relTime: "1 hour ago",
    authorAt: 1_700_000_000,
    refs: [],
    parents: [],
    onHead: true,
    ...overrides,
  };
}

describe("layoutGraph — Phase 1 단일 레인 skeleton", () => {
  it("① 빈 커밋 배열에서 빈 레이아웃을 반환한다", () => {
    const layout = layoutGraph([]);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.activeLaneCount).toBe(0);
    expect(layout.collapsed).toBe(false);
  });

  it("② 단일 커밋에서 lane=0, connectAbove=false, connectBelow=false", () => {
    const layout = layoutGraph([makeCommit()]);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]?.lane).toBe(0);
    expect(layout.nodes[0]?.connectAbove).toBe(false);
    expect(layout.nodes[0]?.connectBelow).toBe(false);
    expect(layout.activeLaneCount).toBe(1);
    expect(layout.collapsed).toBe(false);
  });

  it("③ 선형 조상 관계는 모든 lane=0에서 양 끝 연결선 규칙을 따른다", () => {
    const commits = [
      makeCommit({ fullHash: "aaa", parents: ["bbb"] }),
      makeCommit({ fullHash: "bbb", parents: ["ccc"] }),
      makeCommit({ fullHash: "ccc" }),
    ];
    const layout = layoutGraph(commits);
    expect(layout.nodes).toHaveLength(3);
    expect(layout.nodes.every((n) => n.lane === 0)).toBe(true);
    // 첫 커밋: connectAbove=false, connectBelow=true
    expect(layout.nodes[0]?.connectAbove).toBe(false);
    expect(layout.nodes[0]?.connectBelow).toBe(true);
    // 중간 커밋: connectAbove=true, connectBelow=true
    expect(layout.nodes[1]?.connectAbove).toBe(true);
    expect(layout.nodes[1]?.connectBelow).toBe(true);
    // 마지막 커밋: connectAbove=true, connectBelow=false
    expect(layout.nodes[2]?.connectAbove).toBe(true);
    expect(layout.nodes[2]?.connectBelow).toBe(false);
  });

  it("④ HEAD decoration이 없는 첫 커밋은 isHead=false", () => {
    const layout = layoutGraph([makeCommit({ refs: [] })]);
    expect(layout.nodes[0]?.isHead).toBe(false);
  });

  it("⑤ refs에 'HEAD'가 포함된 커밋은 isHead=true", () => {
    const commits = [
      makeCommit({ refs: [] }),
      makeCommit({ refs: ["HEAD", "refs/heads/main"] }),
      makeCommit({ refs: [] }),
    ];
    const layout = layoutGraph(commits);
    // index 0에는 HEAD decoration이 없으므로 false
    expect(layout.nodes[0]?.isHead).toBe(false);
    // index 1는 refs에 HEAD 포함
    expect(layout.nodes[1]?.isHead).toBe(true);
    // index 2는 refs에 HEAD 없음, index 0 아님 → isHead=false
    expect(layout.nodes[2]?.isHead).toBe(false);
  });

  it("⑥ Phase 1에서 passThroughLanes/mergeFromLanes/branchToLanes는 모두 빈 배열", () => {
    const layout = layoutGraph([makeCommit(), makeCommit(), makeCommit()]);
    for (const node of layout.nodes) {
      expect(node.passThroughLanes).toEqual([]);
      expect(node.mergeFromLanes).toEqual([]);
      expect(node.branchToLanes).toEqual([]);
    }
  });

  it("⑦ activeLaneCount는 커밋이 있으면 1", () => {
    const layout = layoutGraph([makeCommit(), makeCommit()]);
    expect(layout.activeLaneCount).toBe(1);
  });

  it("⑧ collapsed는 항상 false (Phase 1)", () => {
    const layout = layoutGraph([makeCommit(), makeCommit()]);
    expect(layout.collapsed).toBe(false);
  });
});

describe("layoutGraph — Phase 2 다중 레인 topology", () => {
  it("① linear 5 commits → 모든 lane=0, passThrough=[], activeLaneCount=1, collapsed=false", () => {
    const commits = [
      makeCommit({ fullHash: "aaa", parents: ["bbb"] }),
      makeCommit({ fullHash: "bbb", parents: ["ccc"] }),
      makeCommit({ fullHash: "ccc", parents: ["ddd"] }),
      makeCommit({ fullHash: "ddd", parents: ["eee"] }),
      makeCommit({ fullHash: "eee", parents: [] }),
    ];
    const layout = layoutGraph(commits);
    expect(layout.nodes.every((n) => n.lane === 0)).toBe(true);
    expect(layout.nodes.every((n) => n.passThroughLanes.length === 0)).toBe(true);
    expect(layout.activeLaneCount).toBe(1);
    expect(layout.collapsed).toBe(false);
  });

  it("② merge commit(2 parents) → 병합 커밋 이후 새 lane 개설, mergeFromLanes/branchToLanes 정확 배정", () => {
    // merge: hash=M, parents=[A, B]
    // A: hash=A, parents=[]
    // B: hash=B, parents=[]
    const commits = [
      makeCommit({ fullHash: "M", parents: ["A", "B"] }),
      makeCommit({ fullHash: "A", parents: [] }),
      makeCommit({ fullHash: "B", parents: [] }),
    ];
    const layout = layoutGraph(commits);
    // M은 lane 0 (새로 개설)
    expect(layout.nodes[0]?.lane).toBe(0);
    // M의 branchToLanes에는 B를 기다리는 새 레인이 있어야 함
    expect(layout.nodes[0]?.branchToLanes.length).toBeGreaterThan(0);
    // A는 laneHeads[0] = A 이므로 lane 0 매치
    expect(layout.nodes[1]?.lane).toBe(0);
    // B는 branchToLanes에서 개설된 레인 매치
    const bLane = layout.nodes[0]?.branchToLanes[0] ?? -1;
    expect(layout.nodes[2]?.lane).toBe(bLane);
    // A에서 mergeFromLanes는 빈 배열 (A는 M의 첫 번째 부모이므로 닫힘이 없음)
    expect(layout.nodes[1]?.mergeFromLanes).toEqual([]);
    // collapsed는 false (2레인 = 캡 3 이하)
    expect(layout.collapsed).toBe(false);
  });

  it("③ octopus 9 parents → 활성 레인이 8 초과 즉시 collapsed=true", () => {
    // C의 parents: 9개 — 레인 9개 개설 → 캡 8 초과
    const commits = [
      makeCommit({ fullHash: "C", parents: ["A", "B", "D", "E", "F", "G", "H", "I", "J"] }),
      makeCommit({ fullHash: "A", parents: [] }),
      makeCommit({ fullHash: "B", parents: [] }),
      makeCommit({ fullHash: "D", parents: [] }),
      makeCommit({ fullHash: "E", parents: [] }),
      makeCommit({ fullHash: "F", parents: [] }),
      makeCommit({ fullHash: "G", parents: [] }),
      makeCommit({ fullHash: "H", parents: [] }),
      makeCommit({ fullHash: "I", parents: [] }),
      makeCommit({ fullHash: "J", parents: [] }),
    ];
    const layout = layoutGraph(commits);
    expect(layout.collapsed).toBe(true);
    // 활성 레인은 8 이하
    const activeLanes = new Set<number>();
    for (const node of layout.nodes) activeLanes.add(node.lane);
    expect(activeLanes.size).toBeLessThanOrEqual(8);
  });

  it("④ dangling parent(로그 범위 밖) → 남은 laneHead가 매치 없이 종료해도 크래시 없음", () => {
    const commits = [
      makeCommit({ fullHash: "A", parents: ["MISSING"] }),
      makeCommit({ fullHash: "B", parents: [] }),
    ];
    expect(() => layoutGraph(commits)).not.toThrow();
    const layout = layoutGraph(commits);
    expect(layout.nodes).toHaveLength(2);
  });

  it("⑤ --all 다중 루트 topology는 HEAD decoration에만 head ring을 남긴다", () => {
    const commits = [
      makeCommit({ fullHash: "A", parents: ["A0"], refs: ["HEAD -> refs/heads/main"] }),
      makeCommit({ fullHash: "B", parents: ["B0"], refs: ["refs/remotes/origin/topic"] }),
      makeCommit({ fullHash: "A0", parents: [] }),
      makeCommit({ fullHash: "B0", parents: [] }),
    ];
    const layout = layoutGraph(commits);
    expect(layout.nodes).toHaveLength(4);
    expect(layout.nodes[0]?.isHead).toBe(true);
    expect(layout.nodes[1]?.isHead).toBe(false);
    expect(layout.activeLaneCount).toBeGreaterThanOrEqual(2);
  });

  it("⑥ 독립 root→parent 9쌍은 8레인 cap 안에서 collapsed 된다", () => {
    const commits = Array.from({ length: 9 }, (_, index) => makeCommit({
      fullHash: `root-${index}`,
      parents: [`parent-${index}`],
    }));
    const layout = layoutGraph(commits);

    expect(layout.activeLaneCount).toBeLessThanOrEqual(8);
    expect(layout.collapsed).toBe(true);
  });

  it("⑦ 무관한 연속 root는 ancestry 없는 수직 연결선을 만들지 않는다", () => {
    const layout = layoutGraph([
      makeCommit({ fullHash: "root-a", parents: [] }),
      makeCommit({ fullHash: "root-b", parents: [] }),
    ]);

    expect(layout.nodes.map(({ connectAbove, connectBelow }) => ({ connectAbove, connectBelow }))).toEqual([
      { connectAbove: false, connectBelow: false },
      { connectAbove: false, connectBelow: false },
    ]);
  });

  it("⑧ 오래된 분기 topology가 나타날 때만 행 폭이 넓어지고 수렴 후 다시 좁아진다", () => {
    const layout = layoutGraph([
      makeCommit({ fullHash: "HEAD", parents: ["head-1"], refs: ["HEAD -> refs/heads/main"] }),
      makeCommit({ fullHash: "head-1", parents: ["common"] }),
      makeCommit({ fullHash: "topic", parents: ["common"], refs: ["refs/remotes/origin/topic"] }),
      makeCommit({ fullHash: "common", parents: ["base"] }),
      makeCommit({ fullHash: "base", parents: [] }),
    ]);

    expect(layout.nodes.map((node) => node.activeLaneCount)).toEqual([1, 1, 2, 2, 1]);
    expect(layout.nodes[2]?.passThroughLanes).toEqual([0]);
    expect(layout.nodes[3]?.mergeFromLanes).toEqual([1]);
  });

  it("⑨ 오래된 9-topology overflow는 앞선 HEAD 행을 소급해 collapsed 처리하지 않는다", () => {
    const layout = layoutGraph([
      makeCommit({ fullHash: "HEAD", parents: ["head-1"], refs: ["HEAD -> refs/heads/main"] }),
      makeCommit({ fullHash: "head-1", parents: ["octopus"] }),
      makeCommit({ fullHash: "octopus", parents: ["A", "B", "C", "D", "E", "F", "G", "H", "I"] }),
      makeCommit({ fullHash: "A", parents: [] }),
    ]);

    expect(layout.collapsed).toBe(true);
    expect(layout.nodes.map((node) => node.collapsed)).toEqual([false, false, true, true]);
    expect(layout.nodes[2]?.activeLaneCount).toBe(8);
  });
});
