// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  availableFeatureTourSteps,
  featureTourCompletionBase,
  persistFeatureTourSeen,
  resolveFeatureTourCardPosition,
  resolveNextFeatureTour,
} from "../core/client/src/components/feature-tour.js";
import type { FeatureTour } from "../core/client/src/feature-tour-catalog.js";
import { FEATURE_TOURS } from "../core/client/src/feature-tour-catalog.js";
import { CORE_MESSAGES } from "../core/client/src/i18n/index.js";
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

  it("ships Triage as an entry-only walkthrough without a button spotlight", () => {
    expect(FEATURE_TOURS.map((tour) => tour.id)).toEqual(["triage", "claude-gateway"]);

    const triage = FEATURE_TOURS.find((tour) => tour.id === "triage");
    expect(triage?.spotlight).toBeNull();
    expect(triage?.walkthrough.map((step) => step.anchor)).toEqual([
      ".canvas-operation.is-triage-stage",
      ".canvas-triage-rail",
      ".command-band-triage-toggle",
    ]);
  });

  it("ships the Claude Gateway tour as a spotlight with no walkthrough", () => {
    const gateway = FEATURE_TOURS.find((tour) => tour.id === "claude-gateway");
    expect(gateway?.walkthrough).toEqual([]);
    expect(gateway?.spotlight).toEqual({
      anchor: '[data-operation-launch-kind="claude-gateway"]',
      titleKey: "featureTour.claudeGateway.spotlightTitle",
      bodyKey: "featureTour.claudeGateway.spotlightBody",
    });
  });

  it("does not show Triage onboarding for the button before mode entry", () => {
    document.body.innerHTML = '<button class="command-band-triage-toggle"></button>';

    expect(resolveNextFeatureTour(FEATURE_TOURS, [], document)).toBeNull();
  });

  it("resolves the Triage walkthrough on first mode entry", () => {
    document.body.innerHTML = [
      '<section class="canvas-operation is-triage-stage"></section>',
      '<aside class="canvas-triage-rail"></aside>',
      '<button class="command-band-triage-toggle"></button>',
    ].join("");

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, [], document);
    expect(presentation?.tour.id).toBe("triage");
    expect(presentation?.phase).toBe("walkthrough");
    expect(presentation?.steps).toEqual(
      FEATURE_TOURS.find((tour) => tour.id === "triage")?.walkthrough,
    );
    expect(resolveNextFeatureTour(FEATURE_TOURS, ["triage.walkthrough"], document)).toBeNull();
  });

  it("resolves the shipped Claude Gateway catalog as a spotlight on its semantic launch attribute", () => {
    const gateway = FEATURE_TOURS.find((tour) => tour.id === "claude-gateway");
    const anchor = gateway?.spotlight?.anchor ?? "";
    document.body.innerHTML = [
      '<button data-operation-launch-kind="claude">Claude Code (Classic)</button>',
      '<button data-operation-launch-kind="claude-gateway">Claude (Gateway • Experimental)</button>',
      '<button data-operation-launch-kind="codex">Codex (Classic)</button>',
    ].join("");

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, [], document);
    expect(presentation?.tour.id).toBe("claude-gateway");
    expect(presentation?.phase).toBe("spotlight");
    expect(presentation?.steps).toEqual([gateway?.spotlight]);
    const matches = document.querySelectorAll(anchor);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.getAttribute("data-operation-launch-kind")).toBe("claude-gateway");
    expect(anchor).not.toMatch(/Gateway •|Experimental/);
  });

  it("describes Claude Gateway as suitable for large-scale workloads in both locales", () => {
    expect(CORE_MESSAGES.en["featureTour.claudeGateway.spotlightBody"])
      .toContain("well suited to large-scale workloads");
    expect(CORE_MESSAGES.ko["featureTour.claudeGateway.spotlightBody"])
      .toContain("대규모 워크로드에 적합합니다");
  });

  it("keeps every shipped tour message key present in both locale catalogs", () => {
    for (const tour of FEATURE_TOURS) {
      const steps = [...(tour.spotlight ? [tour.spotlight] : []), ...tour.walkthrough];
      for (const step of steps) {
        expect(CORE_MESSAGES.en).toHaveProperty(step.titleKey);
        expect(CORE_MESSAGES.ko).toHaveProperty(step.titleKey);
        expect(CORE_MESSAGES.en).toHaveProperty(step.bodyKey);
        expect(CORE_MESSAGES.ko).toHaveProperty(step.bodyKey);
      }
    }
  });

  it("positions a tour card outside its containing menu boundary", () => {
    expect(resolveFeatureTourCardPosition({
      anchor: { left: 640, right: 900, top: 360, bottom: 400, width: 260 },
      boundary: { left: 620, right: 920, top: 120, bottom: 640, width: 300, height: 520 },
      cardWidth: 340,
      cardHeight: 180,
      viewportWidth: 1440,
      viewportHeight: 900,
    })).toEqual({ left: 932, top: 290, centered: false });
  });

  it("falls back to the existing anchor placement without a boundary", () => {
    expect(resolveFeatureTourCardPosition({
      anchor: { left: 300, right: 420, top: 200, bottom: 240, width: 120 },
      boundary: null,
      cardWidth: 320,
      cardHeight: 180,
      viewportWidth: 1200,
      viewportHeight: 800,
    })).toEqual({ left: 200, top: 252, centered: false });
  });

  it("does not synthesize a spotlight seen key for a walkthrough-only tour", () => {
    const triage = FEATURE_TOURS.find((tour) => tour.id === "triage");
    expect(triage).toBeDefined();
    expect(featureTourCompletionBase([], triage!, "walkthrough")).toEqual([]);
  });

  it("records the composite key when a phase completes", async () => {
    const persist = vi.fn(async () => true);

    await expect(persistFeatureTourSeen(["older.spotlight"], "example.walkthrough", persist))
      .resolves.toEqual(["older.spotlight", "example.walkthrough"]);
    expect(persist).toHaveBeenCalledWith(["older.spotlight", "example.walkthrough"]);
  });

  it("sanitizes malformed, oversized, and duplicate persisted keys", () => {
    const tooLong = "x".repeat(65);
    const input = ["example.spotlight", 4, "example.spotlight", tooLong, "example.walkthrough"];

    expect(sanitizeSeenFeatureTours(input)).toEqual(["example.spotlight", "example.walkthrough"]);
    expect(sanitizeSeenFeatureTours(Array.from({ length: 70 }, (_, index) => `tour-${index}`))).toHaveLength(64);
    expect(sanitizeSeenFeatureTours("example.spotlight")).toBeUndefined();
  });
});
