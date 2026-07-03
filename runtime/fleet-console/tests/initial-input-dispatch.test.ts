import { describe, expect, it } from "vitest";

import { resolveInitialInputMode } from "../../fleet-plugins/terminal/server/agent-api/initial-input-mode.js";

// (a) claude 계열 → argv 모드: spawn args 마지막에 initialInput 추가됨을 mode 확인으로 검증.
// (b) codex → write 모드: spawn args 불변, quiescence 큐에 enqueue됨을 mode 확인으로 검증.
// (c) initialInput 미제공 no-op: 두 모드 모두 undefined에서 write(안전측) 반환.
// (d) argv 모드 enqueue 미발생: mode=argv이면 write 큐 사용 안 함(mode 확인으로 게이팅됨).

describe("resolveInitialInputMode — per-CLI 모드 테이블", () => {
  describe("(a) claude 계열 → argv 모드", () => {
    it("claude", () => {
      expect(resolveInitialInputMode("claude")).toBe("argv");
    });

    it("claude-kimi", () => {
      expect(resolveInitialInputMode("claude-kimi")).toBe("argv");
    });

    it("claude-glm", () => {
      expect(resolveInitialInputMode("claude-glm")).toBe("argv");
    });
  });

  describe("(b) codex → write 모드", () => {
    it("codex", () => {
      expect(resolveInitialInputMode("codex")).toBe("write");
    });
  });

  describe("(c) initialInput 미제공 no-op — 미지 cliId는 안전측 write", () => {
    it("cliId 미제공(undefined)", () => {
      expect(resolveInitialInputMode(undefined)).toBe("write");
    });

    it("알 수 없는 cliId는 write로 폴백", () => {
      expect(resolveInitialInputMode("unknown-agent")).toBe("write");
    });

    it("빈 문자열은 write로 폴백", () => {
      expect(resolveInitialInputMode("")).toBe("write");
    });
  });

  describe("(d) argv 모드는 write 큐와 배타적 — 모드별 분기 확인", () => {
    it("claude: argv 모드이므로 write 큐 사용 안 함", () => {
      const mode = resolveInitialInputMode("claude");
      // write 큐 enqueue 조건: mode === "write" — claude는 false여야 한다.
      expect(mode === "write").toBe(false);
    });

    it("codex: write 모드이므로 write 큐 사용", () => {
      const mode = resolveInitialInputMode("codex");
      expect(mode === "write").toBe(true);
    });
  });
});
