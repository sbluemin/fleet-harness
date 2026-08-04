// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  advanceFeatureTourStep,
  availableFeatureTourSteps,
  featureTourCompletionBase,
  persistFeatureTourSeen,
  resolveFeatureTourCardPosition,
  resolveNextFeatureTour,
} from "../core/client/src/components/feature-tour.js";
import type { FeatureTour } from "../core/client/src/feature-tour-catalog.js";
import { FEATURE_TOURS } from "../core/client/src/feature-tour-catalog.js";
import { CORE_MESSAGES } from "../core/client/src/i18n/index.js";
import { sanitizeSeenFeatureTours } from "../core/host/settings/settings-domain.js";

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
    expect(FEATURE_TOURS.map((tour) => tour.id)).toEqual(["triage", "claude-operations"]);

    const triage = FEATURE_TOURS.find((tour) => tour.id === "triage");
    expect(triage?.spotlight).toBeNull();
    expect(triage?.walkthrough.map((step) => step.anchor)).toEqual([
      ".canvas-operation.is-triage-stage",
      ".canvas-triage-rail",
      '[data-canvas-mode="warRoom"]',
    ]);
  });

  it("walks the three Claude launch kinds in menu order without a spotlight", () => {
    const claude = FEATURE_TOURS.find((tour) => tour.id === "claude-operations");
    expect(claude?.spotlight).toBeNull();
    expect(claude?.walkthrough.map((step) => step.anchor)).toEqual([
      '[data-operation-launch-kind="claude-native"]',
      '[data-operation-launch-kind="claude"]',
      '[data-operation-launch-kind="claude-gateway"]',
    ]);
    // 앵커는 번역되는 라벨이 아니라 안정 식별자에 걸려야 한다.
    for (const step of claude?.walkthrough ?? []) {
      expect(step.anchor).not.toMatch(/Classic|Native|Gateway •|Experimental/);
    }
  });

  it("does not show Triage onboarding for the button before mode entry", () => {
    document.body.innerHTML = '<button data-canvas-mode="warRoom"></button>';

    expect(resolveNextFeatureTour(FEATURE_TOURS, [], document)).toBeNull();
  });

  it("resolves the Triage walkthrough on first mode entry", () => {
    document.body.innerHTML = [
      '<section class="canvas-operation is-triage-stage"></section>',
      '<aside class="canvas-triage-rail"></aside>',
      '<button data-canvas-mode="warRoom"></button>',
    ].join("");

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, [], document);
    expect(presentation?.tour.id).toBe("triage");
    expect(presentation?.phase).toBe("walkthrough");
    expect(presentation?.steps).toEqual(
      FEATURE_TOURS.find((tour) => tour.id === "triage")?.walkthrough,
    );
    expect(resolveNextFeatureTour(FEATURE_TOURS, ["triage.walkthrough"], document)).toBeNull();
  });

  it("resolves the shipped Claude walkthrough on the open launch menu, step by step", () => {
    const claude = FEATURE_TOURS.find((tour) => tour.id === "claude-operations");
    document.body.innerHTML = [
      '<button data-operation-launch-kind="claude-native">Claude (Native)</button>',
      '<button data-operation-launch-kind="claude">Claude (Classic)</button>',
      '<button data-operation-launch-kind="codex">Codex</button>',
      '<button data-operation-launch-kind="claude-gateway">Claude (Gateway)</button>',
    ].join("");

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, [], document);
    expect(presentation?.tour.id).toBe("claude-operations");
    expect(presentation?.phase).toBe("walkthrough");
    expect(presentation?.steps).toEqual(claude?.walkthrough);

    // "claude" 앵커는 정확 일치라 claude-native·claude-gateway를 함께 집지 않는다.
    for (const step of claude?.walkthrough ?? []) {
      const matches = document.querySelectorAll(step.anchor ?? "");
      expect(matches).toHaveLength(1);
    }
    expect(document.querySelector('[data-operation-launch-kind="claude"]')?.textContent)
      .toBe("Claude (Classic)");

    expect(resolveNextFeatureTour(FEATURE_TOURS, ["claude-operations.walkthrough"], document)).toBeNull();
  });

  it("never advances past the last step, so the progress count cannot exceed the total", () => {
    expect(advanceFeatureTourStep(0, 3)).toBe(1);
    expect(advanceFeatureTourStep(1, 3)).toBe(2);
    // 리렌더 전 연타: 마지막 스텝에서 더 눌러도 인덱스는 그 자리에 머문다 — 넘어가면 "4 / 3"이 뜬다.
    expect(advanceFeatureTourStep(2, 3)).toBe(2);
    expect(advanceFeatureTourStep(9, 3)).toBe(2);
    expect(advanceFeatureTourStep(0, 1)).toBe(0);
    expect(advanceFeatureTourStep(0, 0)).toBe(0);
  });

  it("does not open the Claude walkthrough before the launch menu exists", () => {
    document.body.innerHTML = "";

    expect(resolveNextFeatureTour(FEATURE_TOURS, [], document)).toBeNull();
  });

  it("names each Claude launch kind by what it loads, in both locales", () => {
    expect(CORE_MESSAGES.en["featureTour.claudeOperations.step1Body"]).toContain("no Admiral prompt");
    expect(CORE_MESSAGES.ko["featureTour.claudeOperations.step1Body"]).toContain("Admiral 프롬프트도 Carrier도");
    expect(CORE_MESSAGES.en["featureTour.claudeOperations.step2Body"]).toContain("Carrier dispatch");
    expect(CORE_MESSAGES.ko["featureTour.claudeOperations.step2Body"]).toContain("Carrier 위임");
    expect(CORE_MESSAGES.en["featureTour.claudeOperations.step3Body"]).toContain("/model");
    expect(CORE_MESSAGES.ko["featureTour.claudeOperations.step3Body"]).toContain("/model");
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
