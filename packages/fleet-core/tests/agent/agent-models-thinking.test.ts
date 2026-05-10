import { describe, expect, it } from "vitest";

import {
  getSelectableThinkingLevels,
  SELECTABLE_THINKING_LEVELS,
} from "../../src/admiral/agent/models.js";

describe("admiral.agent.models thinking levels", () => {
  it("sonnet은 max를 selectable thinking level로 노출한다", () => {
    expect(getSelectableThinkingLevels("claude", "sonnet")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("minimal은 selectable thinking level 정책에 포함되지 않는다", () => {
    expect(SELECTABLE_THINKING_LEVELS.has("minimal" as never)).toBe(false);
  });
});
