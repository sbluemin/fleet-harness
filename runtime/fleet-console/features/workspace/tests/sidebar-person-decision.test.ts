import { describe, expect, it } from "vitest";

import { clusterHasPersonDecision, countBoardPersonDecisions, type ObjectiveCluster } from "../../objectives/shared/objective-clusters.js";

const cluster = (overrides: Partial<ObjectiveCluster> & Pick<ObjectiveCluster, "id" | "title">): ObjectiveCluster => ({
  theaterId: "t1",
  members: [],
  ...overrides,
} as ObjectiveCluster);

describe("person holds in the sidebar", () => {
  it("넘긴 항목만 사람 차례로 세며 다른 사령관과 별도 ask 배지는 구분한다", () => {
    const held = cluster({ id: "held", title: "held", commodoreId: "c1", row: { groupId: null, order: 0, fold: [], personTurnAt: 7 } });
    const ordinary = cluster({ id: "ordinary", title: "ordinary", commodoreId: "c1" });
    const ask = cluster({ id: "ask", title: "ask", commodoreId: "c1", row: { groupId: null, order: -1, fold: [], commodore: true, personTurnAt: 8 } });
    const other = cluster({ id: "other", title: "other", commodoreId: "c2", row: { groupId: null, order: 0, fold: [], personTurnAt: 9 } });
    expect(clusterHasPersonDecision(held)).toBe(true);
    expect(clusterHasPersonDecision(ordinary)).toBe(false);
    const clusters = [held, ordinary, ask, other];
    expect(countBoardPersonDecisions(clusters, "c1")).toBe(1);
    expect(countBoardPersonDecisions(clusters, "c2")).toBe(1);
    expect(countBoardPersonDecisions(clusters, "c9")).toBe(0);
  });
});
