// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/shared/index.js", () => ({ TerminalSurface: () => null }));

import { agentOperationKind } from "../client/agent/index.js";
import { setTerminalFontSize } from "../client/shared/terminal-preferences.js";

// 바닥 크롬 선언은 body 소유자의 계약이다 — 호스트 프리뷰(War Room Watch Deck)는 이 값만큼을
// 프레임 밖으로 밀어낸다. 순정 셸이 이 값을 갖게 되면 프롬프트와 최신 출력이 잘려 나간다.
describe("preview bottom chrome declarations", () => {
  afterEach(() => { setTerminalFontSize(14); });

  it("reports the agent CLI composer and status band in the current font's rows", () => {
    // 7행 × 기본 14px.
    expect(agentOperationKind.previewBottomChrome?.()).toBe(98);
  });

  it("follows the terminal font size across its supported range", () => {
    // 밴드는 px가 아니라 행 단위다 — 글꼴을 키우거나 줄여도 잘리는 행 수는 그대로여야 한다.
    setTerminalFontSize(10);
    expect(agentOperationKind.previewBottomChrome?.()).toBe(70);
    setTerminalFontSize(22);
    expect(agentOperationKind.previewBottomChrome?.()).toBe(154);
  });
});
