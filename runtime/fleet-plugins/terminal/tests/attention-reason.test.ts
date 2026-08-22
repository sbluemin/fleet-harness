import { describe, expect, it } from "vitest";

import { AGENT_ATTENTION_REASONS, normalizeAttentionReason } from "../server/agent-api/types.js";

describe("normalizeAttentionReason", () => {
  it("passes through every reason the Notification hook can send", () => {
    for (const reason of AGENT_ATTENTION_REASONS) {
      expect(normalizeAttentionReason(reason)).toBe(reason);
    }
  });

  it("drops an unknown notification_type instead of forwarding it", () => {
    // AskUserQuestion은 PreToolUse라 notification_type 필드 자체가 없고, 임의 문자열이 그대로
    // 브라우저 페이로드에 실리면 클라이언트가 해석할 수 없는 reason을 받는다.
    expect(normalizeAttentionReason("tool_permission_denied")).toBeUndefined();
    expect(normalizeAttentionReason(undefined)).toBeUndefined();
    expect(normalizeAttentionReason(null)).toBeUndefined();
    expect(normalizeAttentionReason(42)).toBeUndefined();
    expect(normalizeAttentionReason({ notification_type: "idle_prompt" })).toBeUndefined();
  });
});
