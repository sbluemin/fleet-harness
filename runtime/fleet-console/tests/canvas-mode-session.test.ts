// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_MODE_STORAGE_KEY } from "../core/client/src/canvas/canvas-mode-session.js";

// 모듈 그래프를 새로 세우는 것이 곧 "페이지가 새로 떴다"이다 — 콘솔 전환도 새로고침도 브라우저에는
// 같은 탭 안의 전체 페이지 이동이라, 탭 세션만 남기고 모듈 메모리를 비우면 그 경계를 그대로 재현한다.
async function loadPage() {
  const session = await import("../core/client/src/canvas/canvas-mode-session.js");
  const canvasStore = await import("../core/client/src/canvas/canvas-store.js");
  const triageStore = await import("../core/client/src/canvas/triage-store.js");
  return { canvasStore, session, triageStore };
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.resetModules();
});

describe("canvas mode session", () => {
  it("remembers and forgets the Tactical Theater as the user toggles it", async () => {
    const { canvasStore, session } = await loadPage();

    canvasStore.loadForTheater("theater-a");
    canvasStore.toggleFormationView();

    expect(canvasStore.getFormationView()).toBe(true);
    expect(session.readCanvasModeSession().formationTheaters).toEqual(["theater-a"]);

    canvasStore.toggleFormationView();

    expect(canvasStore.getFormationView()).toBe(false);
    expect(session.readCanvasModeSession().formationTheaters).toEqual([]);
  });

  it("brings a Theater back to Tactical after a page load inside the same tab", async () => {
    const before = await loadPage();
    before.canvasStore.loadForTheater("theater-a");
    before.canvasStore.toggleFormationView();

    vi.resetModules();
    const after = await loadPage();

    after.canvasStore.loadForTheater("theater-a");
    expect(after.canvasStore.getFormationView()).toBe(true);
    // Tactical은 Theater별 상태다 — 기억에 없는 Theater는 Cruise로 선다.
    after.canvasStore.loadForTheater("theater-b");
    expect(after.canvasStore.getFormationView()).toBe(false);
  });

  it("restores War Room after a page load inside the same tab", async () => {
    const before = await loadPage();
    before.canvasStore.loadForTheater("theater-a");
    before.triageStore.setTriageActive(true);
    expect(before.session.readCanvasModeSession().warRoom).toBe(true);

    vi.resetModules();
    const after = await loadPage();

    // 복원은 명시적 호출로만 일어난다 — 모듈을 세우는 것만으로는 아직 Cruise다.
    expect(after.triageStore.isTriageActive()).toBe(false);
    expect(after.triageStore.restoreTriageSession()).toBe(true);
    expect(after.triageStore.isTriageActive()).toBe(true);
    // 이미 서 있는 모드를 두 번 복원하지 않는다.
    expect(after.triageStore.restoreTriageSession()).toBe(false);
  });

  it("does not restore War Room once the user has left it", async () => {
    const before = await loadPage();
    before.canvasStore.loadForTheater("theater-a");
    before.triageStore.setTriageActive(true);
    before.triageStore.setTriageActive(false);
    expect(before.session.readCanvasModeSession().warRoom).toBe(false);

    vi.resetModules();
    const after = await loadPage();

    expect(after.triageStore.restoreTriageSession()).toBe(false);
    expect(after.triageStore.isTriageActive()).toBe(false);
  });

  it("keeps the Tactical list and the War Room flag in one record", async () => {
    const { canvasStore, session, triageStore } = await loadPage();

    canvasStore.loadForTheater("theater-a");
    canvasStore.toggleFormationView();
    canvasStore.loadForTheater("theater-b");
    triageStore.setTriageActive(true);

    // War Room 진입은 활성 Theater의 Tactical만 걷는다 — 다른 Theater의 기억은 남는다.
    expect(session.readCanvasModeSession()).toEqual({ formationTheaters: ["theater-a"], warRoom: true });
  });

  it("starts a newly opened tab at Cruise", async () => {
    const before = await loadPage();
    before.canvasStore.loadForTheater("theater-a");
    before.canvasStore.toggleFormationView();
    before.triageStore.setTriageActive(true);

    // 주소창에서 새로 연 탭은 sessionStorage 복사본을 받지 않는다.
    before.session.resetCanvasModeSession();
    vi.resetModules();
    const after = await loadPage();

    after.canvasStore.loadForTheater("theater-a");
    expect(after.canvasStore.getFormationView()).toBe(false);
    expect(after.triageStore.restoreTriageSession()).toBe(false);
  });

  it("falls back to Cruise when the stored session is unreadable", async () => {
    window.sessionStorage.setItem(CANVAS_MODE_STORAGE_KEY, "{not json");

    const { canvasStore, session, triageStore } = await loadPage();

    expect(session.readCanvasModeSession()).toEqual({ formationTheaters: [], warRoom: false });
    canvasStore.loadForTheater("theater-a");
    expect(canvasStore.getFormationView()).toBe(false);
    expect(triageStore.restoreTriageSession()).toBe(false);
  });

  it("keeps the console usable when session storage is unavailable", async () => {
    const denied = () => {
      throw new Error("session storage denied");
    };
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(denied);
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(denied);

    const { canvasStore, triageStore } = await loadPage();

    canvasStore.loadForTheater("theater-a");
    expect(() => canvasStore.toggleFormationView()).not.toThrow();
    expect(canvasStore.getFormationView()).toBe(true);
    // 기억이 남지 않으므로 종전처럼 Cruise로 뜬다 — 저장소가 없다고 캔버스가 막히지는 않는다.
    expect(triageStore.restoreTriageSession()).toBe(false);

    vi.restoreAllMocks();
  });
});
