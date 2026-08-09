// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOOT_MINIMIZATION_STORAGE_KEY, claimTheaterBootMinimization, resetBootMinimizationSession } from "../core/client/src/boot-minimization-session.js";

beforeEach(() => {
  window.sessionStorage.clear();
  resetBootMinimizationSession();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  resetBootMinimizationSession();
});

describe("boot minimization session", () => {
  it("hands the claim to the first open of a Theater and refuses the next one", () => {
    expect(claimTheaterBootMinimization("theater-a")).toBe(true);
    expect(claimTheaterBootMinimization("theater-a")).toBe(false);
  });

  it("tracks Theaters independently", () => {
    expect(claimTheaterBootMinimization("theater-a")).toBe(true);
    expect(claimTheaterBootMinimization("theater-b")).toBe(true);
    expect(claimTheaterBootMinimization("theater-a")).toBe(false);
  });

  // 콘솔 전환은 origin을 건너뛰는 전체 페이지 이동이라 모듈 메모리가 사라진다. 같은 탭이라면
  // sessionStorage에 남은 표식만으로 "이미 열었다"를 알아봐야 한다.
  it("refuses the claim after a page load wipes module memory but the tab session survives", () => {
    expect(claimTheaterBootMinimization("theater-a")).toBe(true);

    // 새 페이지의 빈 모듈 메모리를 재현한다 — sessionStorage는 탭에 그대로 남아 있다.
    const surviving = window.sessionStorage.getItem(BOOT_MINIMIZATION_STORAGE_KEY);
    resetBootMinimizationSession();
    window.sessionStorage.setItem(BOOT_MINIMIZATION_STORAGE_KEY, surviving!);

    expect(claimTheaterBootMinimization("theater-a")).toBe(false);
  });

  it("falls back to page-lifetime memory when sessionStorage is unusable", () => {
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new Error("denied"); });

    expect(claimTheaterBootMinimization("theater-a")).toBe(true);
    expect(claimTheaterBootMinimization("theater-a")).toBe(false);
  });

  it("ignores stored junk instead of refusing every claim", () => {
    window.sessionStorage.setItem(BOOT_MINIMIZATION_STORAGE_KEY, "{not json");
    expect(claimTheaterBootMinimization("theater-a")).toBe(true);

    resetBootMinimizationSession();
    window.sessionStorage.setItem(BOOT_MINIMIZATION_STORAGE_KEY, JSON.stringify({ "theater-a": true }));
    expect(claimTheaterBootMinimization("theater-a")).toBe(true);
  });
});
