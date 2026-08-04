// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  advanceFeatureTourStep,
  availableFeatureTourSteps,
  featureTourCompletionBase,
  forgetSeenFeatureTours,
  persistFeatureTourSeen,
  replayableFeatureTourIds,
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

  it("ships one walkthrough per reworked screen, none of them spotlights", () => {
    expect(FEATURE_TOURS.map((tour) => tour.id)).toEqual([
      "canvas-modes",
      "war-room",
      "war-room-sidebar",
      "claude-operations",
    ]);
    for (const tour of FEATURE_TOURS) expect(tour.spotlight).toBeNull();
  });

  it("anchors the War Room walkthrough on the rail, so an empty queue still teaches the mode", () => {
    const warRoom = FEATURE_TOURS.find((tour) => tour.id === "war-room");
    // 활성화 스텝(첫 non-null 앵커)이 무대면 대기 0건 진입에서 투어 전체가 조용히 사라진다.
    expect(warRoom?.walkthrough[0]?.anchor).toBe(".canvas-triage-rail");
    expect(warRoom?.walkthrough.map((step) => step.anchor)).toEqual([
      ".canvas-triage-rail",
      ".canvas-operation.is-triage-stage",
      ".canvas-triage-deck",
      '[data-war-room-tool="density"]',
      '[data-war-room-tool="spotlight"]',
      ".command-band-mode-switch",
    ]);
  });

  it("keeps the War Room walkthrough on an empty queue, minus the stage step", () => {
    document.body.innerHTML = [
      '<aside class="canvas-triage-rail"></aside>',
      '<section class="canvas-triage-deck"></section>',
      '<button data-war-room-tool="density"></button>',
      '<button data-war-room-tool="spotlight"></button>',
      '<div class="command-band-mode-switch"></div>',
    ].join("");

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, ["canvas-modes.walkthrough"], document);
    expect(presentation?.tour.id).toBe("war-room");
    expect(presentation?.steps.map((step) => step.anchor)).not.toContain(".canvas-operation.is-triage-stage");
    expect(presentation?.steps).toHaveLength(5);
  });

  it("holds the sidebar walkthrough back until an item is actually waiting", () => {
    document.body.innerHTML = [
      '<aside class="triage-side-bar">',
      '<div class="triage-side-bar-caption"></div>',
      '<li class="side-bar-status-section side-bar-status-section--awaiting side-bar-status-section--empty"></li>',
      "</aside>",
    ].join("");

    expect(resolveNextFeatureTour(FEATURE_TOURS, ["canvas-modes.walkthrough", "war-room.walkthrough"], document)).toBeNull();
  });

  it("defers the sidebar walkthrough when another tour already played on this mount", () => {
    document.body.innerHTML = [
      '<aside class="triage-side-bar">',
      '<div class="triage-side-bar-caption"></div>',
      '<li class="side-bar-status-section side-bar-status-section--awaiting">',
      '<button class="side-bar-chip"></button>',
      "</li></aside>",
    ].join("");
    const seen = ["canvas-modes.walkthrough", "war-room.walkthrough"];

    expect(resolveNextFeatureTour(FEATURE_TOURS, seen, document)?.tour.id).toBe("war-room-sidebar");
    expect(resolveNextFeatureTour(FEATURE_TOURS, seen, document, true)).toBeNull();
  });

  it("replays the narrowest guide anchored on the screen in front of the user", () => {
    document.body.innerHTML = '<div class="command-band-mode-switch"></div>';
    const seen = ["canvas-modes.walkthrough", "war-room.walkthrough", "claude-operations.walkthrough"];

    // 모드 스위치는 War Room 투어의 마지막 스텝이기도 하지만, 활성화 앵커는 대기 레일이다.
    expect(replayableFeatureTourIds(FEATURE_TOURS, document)).toEqual(["canvas-modes"]);
    expect(forgetSeenFeatureTours(seen, replayableFeatureTourIds(FEATURE_TOURS, document)))
      .toEqual(["war-room.walkthrough", "claude-operations.walkthrough"]);
    // 되살릴 것이 없으면 같은 배열을 그대로 돌려준다 — 메뉴 항목의 비활성 판정이 이 동일성을 읽는다.
    expect(forgetSeenFeatureTours(seen, [])).toBe(seen);
  });

  it("replays War Room, not the mode introduction, when both are anchored on screen", () => {
    document.body.innerHTML = [
      '<div class="command-band-mode-switch"></div>',
      '<div class="command-band-mode-tray"></div>',
      '<aside class="canvas-triage-rail"></aside>',
      '<section class="canvas-triage-deck"></section>',
    ].join("");

    expect(replayableFeatureTourIds(FEATURE_TOURS, document)).toEqual(["war-room"]);
    expect(forgetSeenFeatureTours(["canvas-modes.walkthrough", "war-room.walkthrough"], ["war-room"]))
      .toEqual(["canvas-modes.walkthrough"]);
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

  it("introduces the modes first, and War Room only after the user is in it", () => {
    document.body.innerHTML = [
      '<div class="command-band-mode-switch"></div>',
      '<div class="command-band-mode-tray"></div>',
    ].join("");

    expect(resolveNextFeatureTour(FEATURE_TOURS, [], document)?.tour.id).toBe("canvas-modes");
    // 모드 스위치만 보이는 화면은 War Room이 아니다 — 대기 레일이 그 경계를 판정한다.
    expect(resolveNextFeatureTour(FEATURE_TOURS, ["canvas-modes.walkthrough"], document)).toBeNull();
  });

  it("resolves the full War Room walkthrough on first mode entry", () => {
    document.body.innerHTML = [
      '<aside class="canvas-triage-rail"></aside>',
      '<section class="canvas-operation is-triage-stage"></section>',
      '<section class="canvas-triage-deck"></section>',
      '<button data-war-room-tool="density"></button>',
      '<button data-war-room-tool="spotlight"></button>',
      '<div class="command-band-mode-switch"></div>',
    ].join("");

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, ["canvas-modes.walkthrough"], document);
    expect(presentation?.tour.id).toBe("war-room");
    expect(presentation?.phase).toBe("walkthrough");
    expect(presentation?.steps).toEqual(
      FEATURE_TOURS.find((tour) => tour.id === "war-room")?.walkthrough,
    );
    expect(resolveNextFeatureTour(FEATURE_TOURS, ["canvas-modes.walkthrough", "war-room.walkthrough"], document)).toBeNull();
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
    const warRoom = FEATURE_TOURS.find((tour) => tour.id === "war-room");
    expect(warRoom).toBeDefined();
    expect(featureTourCompletionBase([], warRoom!, "walkthrough")).toEqual([]);
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
