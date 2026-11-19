import { describe, expect, it } from "vitest";

import { bandChoices, objectiveBoardActions } from "./board-actions.js";
import type { Objective, ObjectivePersonHold } from "../shared/types.js";

/** 보드 행동이 읽는 값만 채운 검토 대기 목표 — 지휘관이 서 있고 편집·제안·후속 후보가 없다. */
function reviewObjective(extra: Partial<Objective> = {}): Objective {
  return {
    id: "o1", commodoreId: "c1", theaterId: "t1", title: "Review", done: null, removed: null, archived: false,
    awaitingReview: true, awaitingHandoff: false, planning: false, criteriaProposals: [], followups: [], followupBatches: [],
    members: [], missions: [], criteria: [], personHolds: [], edited: null,
    commander: { started: true, sessionName: "s", hasSession: true },
    ...extra,
  } as unknown as Objective;
}
const heldReview: ObjectivePersonHold = { target: "review", requestId: null, reason: "Pick the direction", at: 1, by: { kind: "commodore", commodoreId: "c1" }, settled: null };
const input = (objective: Objective) => ({ objective, working: false, commanderAwaiting: false, memberAwaiting: null, commanderExists: true, recipientCount: 1 });

describe("board actions at review", () => {
  // 목표 보드 입력창은 주행동 「완료」와 보조 「범위 넓히기」를 같은 칩 줄(메뉴 밖)에 세운다 — 사람이 넘긴 검토에서도 같다.
  for (const [name, personHolds] of [["a review nobody handed over", [] as ObjectivePersonHold[]], ["a review the Commodore handed to the person", [heldReview]]] as const) {
    it(`offers Complete and Extend scope outside the menu for ${name}`, () => {
      const board = objectiveBoardActions(reviewObjective({ personHolds }));
      expect(board.suggestions.map((action) => action.id)).toEqual(["complete", "extend"]);
      expect(board.more).toBeUndefined();
      expect(board.suggestions[0]).toMatchObject({ emphasis: "review" });
      // 범위 넓히기는 한마디가 필수다 — 비어 있으면 보내지 못한다.
      expect(board.suggestions[1]).toMatchObject({ context: { required: true } });
      expect(board.suggestions[1]!.emphasis).toBeUndefined();
    });
  }

  it("keeps Extend scope offered with the steering chip when edits wait for the Commander", () => {
    const board = objectiveBoardActions(reviewObjective({ edited: { kinds: ["missions"], actors: [] } as unknown as Objective["edited"] }));
    expect(board.suggestions.map((action) => action.id)).toEqual(["steer", "extend"]);
  });

  it("chooses extend for review and finished objectives only (the phone menu uses the same choice)", () => {
    const choose = (objective: Objective, working = false) => bandChoices({ ...input(objective), working });
    expect(choose(reviewObjective())).toMatchObject({ primary: "complete", alts: ["extend", "message"] });
    expect(choose(reviewObjective({ personHolds: [heldReview] })).alts).toContain("extend");
    expect(choose(reviewObjective({ done: { at: 1, by: "human" } as unknown as Objective["done"], awaitingReview: false }))).toMatchObject({ primary: "extend" });
    const running = choose(reviewObjective({ awaitingReview: false, planning: false }), true);
    expect([running.primary, ...running.alts]).not.toContain("extend");
    const gated = choose(reviewObjective({ criteriaProposals: [{ id: "p1" }] as unknown as Objective["criteriaProposals"] }));
    expect([gated.primary, ...gated.alts]).not.toContain("extend");
  });
});
