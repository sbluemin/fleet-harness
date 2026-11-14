import { describe, expect, it } from "vitest";

import { clusterHasPersonDecision, countBoardPersonDecisions, type ObjectiveCluster } from "../../objectives/shared/objective-clusters.js";

const cluster = (overrides: Partial<ObjectiveCluster> & Pick<ObjectiveCluster, "id" | "title">): ObjectiveCluster => ({
  theaterId: "t1",
  members: [],
  ...overrides,
} as ObjectiveCluster);

describe("clusterHasPersonDecision", () => {
  it("사람에게 넘긴 줄만 true이다", () => {
    expect(clusterHasPersonDecision(cluster({ id: "b", title: "b", row: { groupId: null, order: 0, fold: [], personTurnAt: 7 } }))).toBe(true);
    expect(clusterHasPersonDecision(cluster({ id: "d", title: "d" }))).toBe(false);
  });
});

describe("countBoardPersonDecisions", () => {
  it("그 사령관의 사람 차례만 세고 ask 줄은 뺀다", () => {
    const clusters = [
      cluster({ id: "board-1", title: "b1", commodoreId: "c1" }),
      cluster({ id: "board-2", title: "b2", commodoreId: "c1", row: { groupId: null, order: 0, fold: [], personTurnAt: 3 } }),
      cluster({ id: "board-3", title: "b3", commodoreId: "c1", row: { groupId: null, order: 1, fold: [], personTurnAt: 4 } }),
      cluster({ id: "ask-1", title: "q", commodoreId: "c1", row: { groupId: null, order: -1, fold: [], commodore: true, personTurnAt: 5 } }),
      cluster({ id: "other-1", title: "o", commodoreId: "c2", row: { groupId: null, order: 0, fold: [], personTurnAt: 6 } }),
    ];
    expect(countBoardPersonDecisions(clusters, "c1")).toBe(2);
    expect(countBoardPersonDecisions(clusters, "c2")).toBe(1);
    expect(countBoardPersonDecisions(clusters, "c9")).toBe(0);
  });
});
