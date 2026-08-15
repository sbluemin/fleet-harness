import { describe, expect, it } from "vitest";

import { compactPercentFromTrackRatio, compactTrackFillPercent } from "./index.js";

describe("compact timing track geometry", () => {
  it("maps the 70–99 policy onto the full track", () => {
    expect(compactTrackFillPercent(70)).toBe(0);
    expect(compactTrackFillPercent(99)).toBe(100);
    expect(compactTrackFillPercent(84.5)).toBe(50);
  });

  it("reads a pointer ratio back onto the same 70–99 axis", () => {
    expect(compactPercentFromTrackRatio(0)).toBe(70);
    expect(compactPercentFromTrackRatio(1)).toBe(99);
    expect(compactPercentFromTrackRatio(0.5)).toBe(85);
    expect(compactPercentFromTrackRatio(-0.2)).toBe(70);
    expect(compactPercentFromTrackRatio(1.4)).toBe(99);
  });

  it("round-trips every integer percent on the custom axis", () => {
    for (let percent = 70; percent <= 99; percent += 1) {
      const fill = compactTrackFillPercent(percent);
      expect(compactPercentFromTrackRatio(fill / 100)).toBe(percent);
    }
  });
});
