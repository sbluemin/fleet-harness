import { describe, expect, it } from "vitest";

import { SELECTABLE_THINKING_LEVELS } from "../src/models.js";

describe("admiral.agent.models thinking levels", () => {
  it("minimal은 selectable thinking level 정책에 포함되지 않는다", () => {
    expect(SELECTABLE_THINKING_LEVELS.has("minimal" as never)).toBe(false);
  });
});
