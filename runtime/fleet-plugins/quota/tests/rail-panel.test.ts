import { describe, expect, it } from "vitest";

import { formatCountdown } from "../client/rail-panel.js";

describe("quota countdown", () => {
  it("formats day, hour, and minute windows", () => {
    const now = 1_000_000;
    expect(formatCountdown(now + 4 * 86_400_000 + 7 * 3_600_000, now)).toBe("4d 7h");
    expect(formatCountdown(now + 4 * 3_600_000 + 23 * 60_000, now)).toBe("4h 23m");
    expect(formatCountdown(now + 12 * 60_000, now)).toBe("12m");
  });
});
