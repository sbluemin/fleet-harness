import { describe, expect, it } from "vitest";

import { placeCard } from "../client/geometry.js";

describe("Scuttlebutt card placement", () => {
  const viewport = { width: 800, height: 600 };
  const card = { width: 380, height: 260 };

  it("prefers above and bottom-anchors the card", () => {
    expect(placeCard(viewport, { left: 600, top: 400, width: 80, height: 90 }, card)).toEqual({
      side: "above",
      left: 412,
      bottom: 210,
      maxHeight: 382,
    });
  });

  it("uses below when above cannot fit", () => {
    expect(placeCard(viewport, { left: 300, top: 40, width: 80, height: 90 }, card)).toEqual({
      side: "below",
      left: 150,
      top: 140,
      maxHeight: 452,
    });
  });

  it("uses beside and clamps both axes when vertical space cannot fit", () => {
    expect(placeCard(
      { width: 500, height: 300 },
      { left: 400, top: 110, width: 80, height: 90 },
      { width: 260, height: 250 },
    )).toEqual({
      side: "beside",
      left: 130,
      top: 30,
      maxHeight: 284,
    });
  });
});
