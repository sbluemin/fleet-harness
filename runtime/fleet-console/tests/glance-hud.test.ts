import { describe, expect, it } from "vitest";

import { resolveGlanceHudModel } from "../core/client/src/canvas/glance-hud.js";

describe("panel Glance HUD model", () => {
  it("uses zero-padded focus-cycle positions and Map panel actions", () => {
    expect(resolveGlanceHudModel({ mode: "map", index: 3 })).toEqual({
      index: "03",
      hints: [
        { key: "↑", messageKey: "canvas.glance.maximize" },
        { key: "↓", messageKey: "canvas.glance.minimize" },
      ],
    });
  });

  it("uses the Formation slot and restore wording for a maximized panel", () => {
    expect(resolveGlanceHudModel({ mode: "formation", index: 2, maximized: true })).toEqual({
      index: "02",
      hints: [
        { key: "↑", messageKey: "canvas.glance.restore" },
        { key: "↓", messageKey: "canvas.glance.minimize" },
      ],
    });
  });

  it("uses the queue fraction and Triage actions without zero padding", () => {
    expect(resolveGlanceHudModel({ mode: "triage", index: 1, total: 3 })).toEqual({
      index: "1/3",
      hints: [
        { key: "→", messageKey: "canvas.glance.defer" },
        { key: "↓", messageKey: "canvas.glance.setAside" },
      ],
    });
  });
});
