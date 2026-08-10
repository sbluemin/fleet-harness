import { describe, expect, it } from "vitest";

import {
  NATIVE_CLAUDE_EFFORTS,
  NATIVE_CLAUDE_LAUNCH_EFFORTS,
  NATIVE_CLAUDE_SPECIAL_EFFORTS,
} from "../src/index.js";

describe("native Claude effort ladder", () => {
  it("keeps the reasoning ladder as depth alone", () => {
    expect(NATIVE_CLAUDE_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  // ultracode는 max보다 깊이 생각하는 단이 아니다 — xhigh 추론에 dynamic workflow 오케스트레이션을
  // 얹은 세션 모드다. 깊이 사다리에 섞으면 램프의 한 칸 더로 읽힌다.
  it("carries ultracode as a session mode, after the deepest rung", () => {
    expect(NATIVE_CLAUDE_SPECIAL_EFFORTS).toEqual(["ultracode"]);
    expect(NATIVE_CLAUDE_LAUNCH_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
    expect(NATIVE_CLAUDE_LAUNCH_EFFORTS.indexOf("ultracode")).toBeGreaterThan(
      NATIVE_CLAUDE_LAUNCH_EFFORTS.indexOf("max"),
    );
  });

  /**
   * 강도를 깊이로 읽는 표면(Analyst·Cowork)은 `NATIVE_CLAUDE_EFFORTS`를 그대로 펼쳐 쓴다. 두
   * 상수를 다시 하나로 합치면 그 표면들이 아무 변경 없이 ultracode를 물려받아, 워크플로우
   * 오케스트레이션을 켤 수 없는 자리에 그 단을 내놓는다.
   */
  it("never lets the depth ladder inherit the session mode", () => {
    expect(NATIVE_CLAUDE_EFFORTS).not.toContain("ultracode");
    for (const special of NATIVE_CLAUDE_SPECIAL_EFFORTS) {
      expect(NATIVE_CLAUDE_EFFORTS as readonly string[]).not.toContain(special);
    }
  });

  // 게이트웨이 사다리의 `ultra`와는 다른 값이다. Claude Code CLI는 `ultracode`를 받고 `ultra`를 거부한다.
  it("does not confuse the session mode with the gateway's own ultra rung", () => {
    expect(NATIVE_CLAUDE_LAUNCH_EFFORTS as readonly string[]).not.toContain("ultra");
  });
});
