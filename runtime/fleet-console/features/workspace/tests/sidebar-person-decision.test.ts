import { describe, expect, it } from "vitest";

import { clusterHasPersonDecision, countBoardPersonDecisions, type ObjectiveCluster } from "../../objectives/shared/objective-clusters.js";

const cluster = (overrides: Partial<ObjectiveCluster> & Pick<ObjectiveCluster, "id" | "title">): ObjectiveCluster => ({
  theaterId: "t1",
  members: [],
  ...overrides,
} as ObjectiveCluster);

describe("clusterHasPersonDecision", () => {
  it("묶음·줄 어느 쪽의 사람 차례 신호에도 true이다", () => {
    expect(clusterHasPersonDecision(cluster({ id: "a", title: "a", decisionRequest: true }))).toBe(true);
    expect(clusterHasPersonDecision(cluster({ id: "b", title: "b", row: { groupId: null, order: 0, fold: [], decisionRequestedAt: 7 } }))).toBe(true);
  });

  it("맡은 이가 다루는 요청(delegated)과 일반 줄은 제외한다", () => {
    expect(clusterHasPersonDecision(cluster({
      id: "c", title: "c",
      row: { groupId: null, order: 0, fold: [], delegated: { questions: 2, status: "답변 중" } },
    }))).toBe(false);
    expect(clusterHasPersonDecision(cluster({ id: "d", title: "d" }))).toBe(false);
  });
});

describe("countBoardPersonDecisions", () => {
  it("그 사령관의 사람 차례 결정만 세고 ask 줄은 빼며 중복 셈하지 않는다", () => {
    const clusters = [
      cluster({ id: "board-1", title: "b1", commodoreId: "c1", decisionRequest: true }),
      cluster({ id: "board-2", title: "b2", commodoreId: "c1", row: { groupId: null, order: 0, fold: [], decisionRequestedAt: 3, decisionQuestions: 2 } }),
      // 묶음 판정과 줄 판정이 겹쳐도 하나다.
      cluster({ id: "board-3", title: "b3", commodoreId: "c1", decisionRequest: true, row: { groupId: null, order: 1, fold: [], decisionRequestedAt: 4 } }),
      // 사령관 질문 줄은 ask 배지가 세므로 뺀다.
      cluster({ id: "ask-1", title: "q", commodoreId: "c1", row: { groupId: null, order: -1, fold: [], commodore: true, decisionRequestedAt: 5, decisionQuestions: 1 } }),
      // 다른 사령관 몫은 세지 않는다.
      cluster({ id: "other-1", title: "o", commodoreId: "c2", decisionRequest: true }),
      // 맡은 이 요청·일반 줄은 세지 않는다.
      cluster({ id: "delegated-1", title: "g", commodoreId: "c1", row: { groupId: null, order: 2, fold: [], delegated: { questions: 1, status: "답변 중" } } }),
    ];
    expect(countBoardPersonDecisions(clusters, "c1")).toBe(3);
    expect(countBoardPersonDecisions(clusters, "c2")).toBe(1);
    expect(countBoardPersonDecisions(clusters, "c9")).toBe(0);
  });
});
