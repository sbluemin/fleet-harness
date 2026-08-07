import { describe, expect, it } from "vitest";

import { getT } from "../i18n/index.js";

describe("goal message interpolation", () => {
  it("interpolates check counts and sheet help in both locales", () => {
    expect(getT("en")("terminal.goal.checks", { used: 3, limit: 8 })).toBe("3 of 8 checks");
    expect(getT("ko")("terminal.goal.checks", { used: 3, limit: 8 })).toBe("확인 3/8");
    expect(getT("en")("terminal.goal.sheet.checksHelp", { limit: 8 })).toBe(
      "Claude may be asked to keep going at most 8 times before Fleet lets the turn end. A new limit applies the next time this Operation is launched.",
    );
    expect(getT("ko")("terminal.goal.sheet.checksHelp", { limit: 8 })).toBe(
      "Fleet이 턴을 끝내기 전까지 Claude에게 최대 8번 계속 진행을 요청합니다. 새 한도는 이 Operation을 다음에 실행할 때 적용됩니다.",
    );
  });
});
