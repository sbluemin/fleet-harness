import { describe, expect, it } from "vitest";

import { birdVisual, type BirdSignals } from "../client/bird-state.js";

const idle: BirdSignals = {
  grabbed: false,
  oneShot: null,
  alert: false,
  thinking: false,
  mode: "fly",
  flight: "hover",
};

describe("Quaker Admiral visual priority", () => {
  it("lets grab win over cheer", () => {
    expect(birdVisual({ ...idle, grabbed: true, oneShot: "cheer" })).toBe("grab");
  });

  it("selects cheer before all persistent states", () => {
    expect(birdVisual({ ...idle, oneShot: "cheer", alert: true, thinking: true, mode: "walk", flight: "cruise" })).toBe("cheer");
  });

  it("lets salute win over alert", () => {
    expect(birdVisual({ ...idle, oneShot: "salute", alert: true })).toBe("salute");
  });

  it("lets alert win over thinking", () => {
    expect(birdVisual({ ...idle, alert: true, thinking: true })).toBe("alert");
  });

  it.each(["walk", "sleep", "preen"] as const)("lets thinking win over %s", (mode) => {
    expect(birdVisual({ ...idle, thinking: true, mode })).toBe("think");
  });

  it.each(["walk", "sleep", "preen"] as const)("falls back to mode %s", (mode) => {
    expect(birdVisual({ ...idle, mode, flight: "cruise" })).toBe(mode);
  });

  it("falls back from cruise to hover", () => {
    expect(birdVisual({ ...idle, flight: "cruise" })).toBe("cruise");
    expect(birdVisual(idle)).toBe("hover");
  });
});
