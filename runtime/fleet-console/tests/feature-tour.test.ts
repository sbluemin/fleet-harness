// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  availableFeatureTourSteps,
  persistFeatureTourSeen,
  resolveNextFeatureTour,
} from "../core/client/src/components/feature-tour.js";
import type { FeatureTour } from "../core/client/src/feature-tour-catalog.js";
import { FEATURE_TOURS } from "../core/client/src/feature-tour-catalog.js";
import { sanitizeSeenFeatureTours } from "../core/host/console-settings.js";

const TOUR: FeatureTour = {
  id: "example",
  spotlight: {
    anchor: ".feature-entry",
    titleKey: "title",
    bodyKey: "body",
  },
  walkthrough: [
    { anchor: ".active-feature", titleKey: "active-title", bodyKey: "active-body" },
    { anchor: ".missing-step", titleKey: "missing-title", bodyKey: "missing-body" },
  ],
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("feature tour", () => {
  it("does not present a phase whose seen key is recorded", () => {
    document.body.innerHTML = '<button class="feature-entry"></button>';

    expect(resolveNextFeatureTour([TOUR], ["example.spotlight"], document)).toBeNull();
  });

  it("skips walkthrough steps whose anchors are absent", () => {
    document.body.innerHTML = '<section class="active-feature"></section>';

    const presentation = resolveNextFeatureTour([TOUR], [], document);
    expect(presentation?.phase).toBe("walkthrough");
    expect(availableFeatureTourSteps(TOUR.walkthrough, document)).toEqual([TOUR.walkthrough[0]]);
    expect(presentation?.steps).toEqual([TOUR.walkthrough[0]]);
  });

  it("defines the Triage walkthrough as exactly three renumbered steps", () => {
    const triage = FEATURE_TOURS.find((tour) => tour.id === "triage");

    expect(triage?.walkthrough).toHaveLength(3);
    expect(triage?.walkthrough.map((step) => step.anchor)).toEqual([
      ".canvas-operation.is-triage-stage",
      ".canvas-triage-rail",
      ".command-band-triage-toggle",
    ]);
    expect(triage?.walkthrough.map((step) => [step.titleKey, step.bodyKey])).toEqual([
      ["featureTour.triage.step1Title", "featureTour.triage.step1Body"],
      ["featureTour.triage.step2Title", "featureTour.triage.step2Body"],
      ["featureTour.triage.step3Title", "featureTour.triage.step3Body"],
    ]);
    expect(triage?.walkthrough[1]?.anchor).toBe(".canvas-triage-rail");
  });

  it("records the composite key when a phase completes", async () => {
    const persist = vi.fn(async () => true);

    await expect(persistFeatureTourSeen(["older.spotlight"], "example.walkthrough", persist))
      .resolves.toEqual(["older.spotlight", "example.walkthrough"]);
    expect(persist).toHaveBeenCalledWith(["older.spotlight", "example.walkthrough"]);
  });

  it("sanitizes malformed, oversized, and duplicate persisted keys", () => {
    const tooLong = "x".repeat(65);
    const input = ["triage.spotlight", 4, "triage.spotlight", tooLong, "triage.walkthrough"];

    expect(sanitizeSeenFeatureTours(input)).toEqual(["triage.spotlight", "triage.walkthrough"]);
    expect(sanitizeSeenFeatureTours(Array.from({ length: 70 }, (_, index) => `tour-${index}`))).toHaveLength(64);
    expect(sanitizeSeenFeatureTours("triage.spotlight")).toBeUndefined();
  });
});
