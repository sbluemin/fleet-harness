import { describe, expect, it, vi } from "vitest";

vi.mock("../client/shared/index.js", () => ({ TerminalSurface: () => null }));

import { agentOperationKind } from "../client/agent/index.js";
import { shellOperationKind } from "../client/shell/index.js";

// 바닥 크롬 선언은 body 소유자의 계약이다 — 호스트 프리뷰(War Room Watch Deck)는 이 값만큼을
// 프레임 밖으로 밀어낸다. 순정 셸이 이 값을 갖게 되면 프롬프트와 최신 출력이 잘려 나간다.
describe("preview bottom chrome declarations", () => {
  it("declares the agent CLI composer and status band", () => {
    expect(agentOperationKind.previewBottomChrome).toBe(104);
  });

  it("leaves a bare shell undeclared so its prompt stays in frame", () => {
    expect(shellOperationKind.previewBottomChrome).toBeUndefined();
  });
});
