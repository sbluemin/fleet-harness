// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  advanceFeatureTourStep,
  availableFeatureTourSteps,
  featureTourCompletionBase,
  forgetAllFeatureTours,
  forgetSeenFeatureTours,
  isCompletedTourScreenVisible,
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

  it("ships one walkthrough per reworked screen, and a spotlight only where the screen cannot carry one", () => {
    expect(FEATURE_TOURS.map((tour) => tour.id)).toEqual([
      "canvas-modes",
      "quick-launch-pin",
      "war-room",
      "war-room-sidebar",
      "claude-operations",
      "chat-mode",
      "remote-access",
    ]);
    for (const tour of FEATURE_TOURS) {
      expect(tour.walkthrough.length).toBeGreaterThan(0);
    }
    // 화면을 고쳐 만든 투어는 그 화면에서 전부 설명되므로 스포트라이트가 필요 없다.
    for (const tour of FEATURE_TOURS.filter((entry) => entry.id !== "remote-access")) {
      expect(tour.spotlight).toBeNull();
    }
  });

  // Chat Mode 앵커는 Terminal 플러그인 DOM에 있다 — 코어 카탈로그가 짚는 크로스 번들 계약이라
  // 클래스가 아니라 전용 의미 속성(data-chat-tour)으로 고정한다. 세 앵커 모두 채팅 화면이
  // 마운트된 동안 항상 존재하므로 투어는 패널을 처음 연 순간에 뜬다.
  it("anchors the chat-mode walkthrough on the plugin's data-chat-tour contract", () => {
    const chatMode = FEATURE_TOURS.find((tour) => tour.id === "chat-mode");
    expect(chatMode?.spotlight).toBeNull();
    expect(chatMode?.walkthrough.map((step) => step.anchor)).toEqual([
      '[data-chat-tour="badge"]',
      '[data-chat-tour="composer"]',
      '[data-chat-tour="terminal"]',
    ]);
  });

  // 채팅 화면이 마운트되면(세 앵커가 함께 생기면) 다른 화면의 투어 없이도 chat-mode가 바로 뜬다.
  it("starts the chat-mode walkthrough when the chat surface mounts", () => {
    document.body.innerHTML = [
      '<span data-chat-tour="badge"></span>',
      '<span data-chat-tour="composer"></span>',
      '<button data-chat-tour="terminal"></button>',
    ].join("");

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, [], document);
    expect(presentation?.tour.id).toBe("chat-mode");
    expect(presentation?.steps).toHaveLength(3);
    expect(resolveNextFeatureTour(FEATURE_TOURS, ["chat-mode.walkthrough"], document)).toBeNull();
  });

  // 원격 접속만 두 단계를 쓴다 — 설명할 항목이 전부 설정 화면에 있어서, 그 화면에 오기 전에는
  // 존재조차 알 길이 없는 유일한 기능이기 때문이다. 칩 스포트라이트가 그 존재를 알리고,
  // 설정에 들어온 순간 워크스루가 항목을 순서대로 짚는다.
  it("introduces remote access on the host chip and walks its settings cards in order", () => {
    const remote = FEATURE_TOURS.find((tour) => tour.id === "remote-access");
    expect(remote?.spotlight?.anchor).toBe(".host-switcher-chip");
    expect(remote?.walkthrough.map((step) => step.anchor)).toEqual([
      ".remote-section-head",
      '[data-remote-card="hosts"]',
      '[data-remote-card="listener"]',
      '[data-remote-card="identity"]',
      '[data-remote-card="links"]',
    ]);
  });

  // 워크스루를 끝내면 스포트라이트도 본 것으로 남는다 — 설정에서 안내를 다 본 사용자에게
  // 칩 하이라이트가 뒤늦게 다시 뜨면 같은 기능을 두 번 소개하는 셈이 된다.
  it("retires the remote-access chip spotlight once its walkthrough is finished", () => {
    const remote = FEATURE_TOURS.find((tour) => tour.id === "remote-access");
    expect(remote).toBeDefined();
    expect(featureTourCompletionBase([], remote!, "walkthrough")).toEqual(["remote-access.spotlight"]);
  });

  // 리스너가 꺼져 있으면 링크 카드가 렌더되지 않는다. 그 스텝만 빠지고 나머지는 그대로 재생되어야
  // 한다 — 활성화 앵커가 섹션 머리라서 투어 자체는 살아 있다.
  it("drops only the links step while the listener is off", () => {
    document.body.innerHTML = [
      '<header class="remote-section-head"></header>',
      '<div data-remote-card="hosts"></div>',
      '<div data-remote-card="listener"></div>',
      '<div data-remote-card="identity"></div>',
    ].join("");

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, [], document);
    expect(presentation?.tour.id).toBe("remote-access");
    expect(presentation?.phase).toBe("walkthrough");
    expect(presentation?.steps.map((step) => step.anchor)).toEqual([
      ".remote-section-head",
      '[data-remote-card="hosts"]',
      '[data-remote-card="listener"]',
      '[data-remote-card="identity"]',
    ]);
  });

  // 설정 밖에서는 워크스루 앵커가 없으므로 칩 스포트라이트로 떨어진다.
  it("falls back to the chip spotlight away from the settings section", () => {
    document.body.innerHTML = '<button class="host-switcher-chip"></button>';

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, [], document);
    expect(presentation?.tour.id).toBe("remote-access");
    expect(presentation?.phase).toBe("spotlight");
  });

  // 호스트 칩은 커맨드 밴드에 늘 있으므로, 가드가 없으면 다른 투어를 끝낸 그 자리에서 칩
  // 스포트라이트가 곧바로 이어져 안내가 두 번 연달아 뜬다.
  it("holds the chip spotlight back until the finished tour's screen is left", () => {
    document.body.innerHTML = '<button class="host-switcher-chip"></button>';

    expect(resolveNextFeatureTour(FEATURE_TOURS, [], document, true)).toBeNull();
    expect(resolveNextFeatureTour(FEATURE_TOURS, [], document, false)?.phase).toBe("spotlight");
  });

  // 같은 마운트에서 다른 투어를 끝냈어도 워크스루는 지연되지 않는다 — 설정에 들어온 사용자는
  // 그 자리에서 안내를 받아야 한다. 스포트라이트만 미루는 것이 이 가드의 범위다.
  it("still runs the settings walkthrough right after another tour finished", () => {
    document.body.innerHTML = [
      '<button class="host-switcher-chip"></button>',
      '<header class="remote-section-head"></header>',
      '<div data-remote-card="hosts"></div>',
    ].join("");

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, [], document, true);
    expect(presentation?.tour.id).toBe("remote-access");
    expect(presentation?.phase).toBe("walkthrough");
  });

  it("lets a dialog carry the tour that points inside it, and blocks the ones that do not", () => {
    // 사용자가 직접 연 표면에서 그 표면의 컨트롤을 짚는 것은 이 게이트가 막으려던 상황이 아니다.
    document.body.innerHTML = [
      '<div class="command-band-mode-switch"></div>',
      '<section aria-modal="true" class="quick-launch-card">',
      '  <button class="quick-launch-pin"></button>',
      '</section>',
    ].join("");

    const inside = resolveNextFeatureTour(FEATURE_TOURS, [], document);
    expect(inside?.tour.id).toBe("quick-launch-pin");
    // 같은 모달이 떠 있는 동안 그 밖을 가리키는 안내(모드 스위치)는 여전히 막힌다.
    expect(resolveNextFeatureTour(FEATURE_TOURS, ["quick-launch-pin.walkthrough"], document)).toBeNull();
  });

  it("gates the pin tour on the button existing, not on a state class the observer cannot see", () => {
    // 물러난 바는 이 버튼을 렌더하지 않는다. 상태 클래스로 걸러내면 옵저버가 class를 보지 않아
    // (투어 자신이 앵커에 클래스를 붙였다 떼므로 볼 수도 없다) 펼친 뒤에도 안내가 다시 서지 않는다.
    const step = FEATURE_TOURS.find((tour) => tour.id === "quick-launch-pin")?.walkthrough[0];
    expect(step?.anchor).toBe(".quick-launch-pin");

    document.body.innerHTML = '<section class="quick-launch-card is-pinned is-collapsed"></section>';
    expect(resolveNextFeatureTour(FEATURE_TOURS, ["canvas-modes.walkthrough"], document)).toBeNull();

    document.body.innerHTML = [
      '<section class="quick-launch-card is-pinned">',
      '  <button class="quick-launch-pin"></button>',
      '</section>',
    ].join("");
    expect(resolveNextFeatureTour(FEATURE_TOURS, ["canvas-modes.walkthrough"], document)?.tour.id).toBe("quick-launch-pin");
  });

  it("anchors the War Room walkthrough on its own tool tray, so an empty screen still teaches the mode", () => {
    const warRoom = FEATURE_TOURS.find((tour) => tour.id === "war-room");
    // 활성화 스텝(첫 non-null 앵커)은 War Room에서 항상 있으면서 War Room에서만 있어야 한다. 무대는
    // 대기 건이, 덱은 살아 있는 Operation이 있어야 서고, 모드 스위치는 다른 모드에도 있어 조기 발화한다.
    expect(warRoom?.walkthrough[0]?.anchor).toBe('[data-war-room-tool="density"]');
    expect(warRoom?.walkthrough.map((step) => step.anchor)).toEqual([
      '[data-war-room-tool="density"]',
      ".canvas-operation.is-triage-stage",
      ".canvas-triage-deck",
      '[data-war-room-tool="spotlight"]',
    ]);
  });

  it("keeps the War Room walkthrough on an empty queue, minus the stage step", () => {
    document.body.innerHTML = [
      '<section class="canvas-triage-deck"></section>',
      '<button data-war-room-tool="density"></button>',
      '<button data-war-room-tool="spotlight"></button>',
      '<div class="command-band-mode-switch"></div>',
    ].join("");

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, ["canvas-modes.walkthrough"], document);
    expect(presentation?.tour.id).toBe("war-room");
    expect(presentation?.steps.map((step) => step.anchor)).not.toContain(".canvas-operation.is-triage-stage");
    expect(presentation?.steps).toHaveLength(3);
  });

  // 작전이 하나도 없으면 덱도 서지 않는다 — 그때도 투어는 살아 있어야 한다.
  it("still teaches War Room when nothing is on screen but the chrome", () => {
    document.body.innerHTML = [
      '<button data-war-room-tool="density"></button>',
      '<button data-war-room-tool="spotlight"></button>',
      '<div class="command-band-mode-switch"></div>',
    ].join("");

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, ["canvas-modes.walkthrough"], document);
    expect(presentation?.tour.id).toBe("war-room");
    expect(presentation?.steps[0]?.anchor).toBe('[data-war-room-tool="density"]');
  });

  it("holds the sidebar walkthrough back until an item is actually waiting", () => {
    document.body.innerHTML = [
      '<aside class="triage-side-bar is-expanded">',
      '<div class="triage-side-bar-caption"></div>',
      '<li class="side-bar-status-section side-bar-status-section--awaiting side-bar-status-section--empty"></li>',
      "</aside>",
    ].join("");

    expect(resolveNextFeatureTour(FEATURE_TOURS, ["canvas-modes.walkthrough", "war-room.walkthrough"], document)).toBeNull();
  });

  it("holds the sidebar walkthrough back while the sidebar is collapsed out of sight", () => {
    // 접힌 사이드바는 폭 0 + visibility:hidden으로만 가려지고 자식은 DOM에 남는다 — 배제하지
    // 않으면 사용자가 본 적 없는 안내가 재생되고 시청 기록에 남는다.
    document.body.innerHTML = [
      '<aside class="triage-side-bar is-closed">',
      '<div class="triage-side-bar-caption"></div>',
      '<li class="side-bar-status-section side-bar-status-section--awaiting">',
      '<button class="side-bar-chip"></button>',
      "</li></aside>",
    ].join("");
    const seen = ["canvas-modes.walkthrough", "war-room.walkthrough"];

    expect(resolveNextFeatureTour(FEATURE_TOURS, seen, document)).toBeNull();

    document.querySelector(".triage-side-bar")!.className = "triage-side-bar is-expanded";
    expect(resolveNextFeatureTour(FEATURE_TOURS, seen, document)?.tour.id).toBe("war-room-sidebar");
  });

  it("defers the sidebar walkthrough while the visit that just played another tour continues", () => {
    document.body.innerHTML = [
      '<aside class="triage-side-bar is-expanded">',
      '<div class="triage-side-bar-caption"></div>',
      '<li class="side-bar-status-section side-bar-status-section--awaiting">',
      '<button class="side-bar-chip"></button>',
      "</li></aside>",
    ].join("");
    const seen = ["canvas-modes.walkthrough", "war-room.walkthrough"];

    expect(resolveNextFeatureTour(FEATURE_TOURS, seen, document)?.tour.id).toBe("war-room-sidebar");
    expect(resolveNextFeatureTour(FEATURE_TOURS, seen, document, true)).toBeNull();
  });

  it("releases the deferred walkthrough once the completed tour's screen is gone", () => {
    // 오버레이는 라우트 밖에 한 번만 마운트되므로 "이 마운트에서 끝냈다"로 재면 War Room을 오가도
    // 값이 그대로다 — 판정은 끝낸 투어의 화면이 아직 보이는지로 해야 다음 방문에 뜬다.
    document.body.innerHTML = '<button data-war-room-tool="density"></button>';
    expect(isCompletedTourScreenVisible("war-room", FEATURE_TOURS, document)).toBe(true);

    document.body.innerHTML = '<div class="command-band-mode-switch"></div>';
    expect(isCompletedTourScreenVisible("war-room", FEATURE_TOURS, document)).toBe(false);
    expect(isCompletedTourScreenVisible(null, FEATURE_TOURS, document)).toBe(false);
  });

  // "화면 안내 다시 보기"는 지금 화면에 닻을 건 투어 하나가 아니라 온보딩 전체를 초기화한다.
  it("forgets every feature tour seen key, regardless of which screen is anchored", () => {
    document.body.innerHTML = '<div class="command-band-mode-switch"></div>';
    const seen = [
      "canvas-modes.walkthrough",
      "war-room.walkthrough",
      "war-room-sidebar.walkthrough",
      "claude-operations.walkthrough",
      "remote-access.walkthrough",
      "remote-access.spotlight",
    ];

    // 지금 화면에 닻이 있는 투어가 아니라 카탈로그 전체를 되살린다.
    expect(forgetAllFeatureTours(seen)).toEqual([]);
    // 화면에 걸린 앵커와 무관하게, 다른 seen 키는 그대로 둔다.
    expect(forgetAllFeatureTours([...seen, "commissioning", "unrelated"])).toEqual(["commissioning", "unrelated"]);
  });

  it("returns the same array when no feature tour has been seen", () => {
    // 되살릴 것이 없으면 같은 배열을 그대로 돌려준다 — 메뉴 항목의 비활성 판정이 이 동일성을 읽는다.
    const seen = ["commissioning"];
    expect(forgetAllFeatureTours(seen)).toBe(seen);
    expect(forgetSeenFeatureTours(seen, [])).toBe(seen);
  });

  it("walks the surviving Claude launch kinds in menu order without a spotlight", () => {
    const claude = FEATURE_TOURS.find((tour) => tour.id === "claude-operations");
    expect(claude?.spotlight).toBeNull();
    expect(claude?.walkthrough.map((step) => step.anchor)).toEqual([
      '[data-operation-launch-kind="claude-gateway"]',
    ]);
    // 퇴역한 Classic 앵커가 되살아나면 잡는다.
    expect(claude?.walkthrough.map((step) => step.anchor)).not.toContain('[data-operation-launch-kind="claude"]');
    // 앵커는 번역되는 라벨이 아니라 안정 식별자에 걸려야 한다.
    for (const step of claude?.walkthrough ?? []) {
      expect(step.anchor).not.toMatch(/Classic|Native|Gateway/);
    }
  });

  it("introduces the modes first, and War Room only after the user is in it", () => {
    document.body.innerHTML = [
      '<div class="command-band-mode-switch"></div>',
      '<div class="command-band-mode-tray"></div>',
    ].join("");

    expect(resolveNextFeatureTour(FEATURE_TOURS, [], document)?.tour.id).toBe("canvas-modes");
    // 모드 스위치만 보이는 화면은 War Room이 아니다 — War Room 전용 도구 트레이가 그 경계를 판정한다.
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
      '<button data-operation-launch-kind="codex">Codex</button>',
      '<button data-operation-launch-kind="claude-gateway">Claude (Gateway)</button>',
    ].join("");

    const presentation = resolveNextFeatureTour(FEATURE_TOURS, [], document);
    expect(presentation?.tour.id).toBe("claude-operations");
    expect(presentation?.phase).toBe("walkthrough");
    expect(presentation?.steps).toEqual(claude?.walkthrough);

    // 앵커는 정확 일치라 서로를 함께 집지 않는다.
    for (const step of claude?.walkthrough ?? []) {
      const matches = document.querySelectorAll(step.anchor ?? "");
      expect(matches).toHaveLength(1);
    }

    // 워크스루를 보면 이 메뉴에서 더 재생할 안내가 없다.
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

  it("names the Claude Gateway launch kind by what it loads, in both locales", () => {
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
