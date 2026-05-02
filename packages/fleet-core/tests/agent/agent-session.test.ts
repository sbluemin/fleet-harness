import { describe, expect, it } from "vitest";
import { resolveSession } from "../../src/admiral/agent/session.js";

describe("admiral.agent.session", () => {
  describe("resolveSession()", () => {
    it("빈 문자열 sessionId는 undefined를 반환한다", () => {
      expect(resolveSession("")).toBeUndefined();
    });

    it("존재하지 않는 sessionId는 undefined를 반환한다", () => {
      expect(resolveSession("nonexistent-session-id")).toBeUndefined();
    });
  });
});
