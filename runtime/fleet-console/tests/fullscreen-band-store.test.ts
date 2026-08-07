// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE = "../core/client/src/fullscreen-band-store.js";
const KEY = "fleet-console.fullscreen-band.docked";

// 저장값은 모듈 최초 임포트 때 한 번만 읽힌다 — 그 시점이 지난 뒤 손대는 테스트로는 읽기 규칙을
// 전혀 검증하지 못한다(그래서 훅 테스트는 이 규칙을 통과시켜 버린다). 매번 모듈 레지스트리를
// 비우고 씨앗을 심은 뒤 새로 임포트해야 실제 부팅 경로를 지난다.
async function loadStore(seed: string | null) {
  vi.resetModules();
  localStorage.clear();
  if (seed !== null) localStorage.setItem(KEY, seed);
  return import(MODULE);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("fullscreen band preference", () => {
  it("defaults to auto-hide when nothing is stored", async () => {
    const store = await loadStore(null);
    expect(store.getCommandBandDocked()).toBe(false);
  });

  it("docks only for the exact stored marker", async () => {
    expect((await loadStore("1")).getCommandBandDocked()).toBe(true);
    expect((await loadStore("0")).getCommandBandDocked()).toBe(false);
    // 임의의 참 같은 값이 도킹으로 읽히면, 남의 쓰레기 값 하나가 기본값을 뒤집는다.
    expect((await loadStore("true")).getCommandBandDocked()).toBe(false);
    expect((await loadStore("")).getCommandBandDocked()).toBe(false);
  });

  it("writes both directions so an undock is remembered too", async () => {
    const store = await loadStore("1");
    expect(store.getCommandBandDocked()).toBe(true);

    store.toggleCommandBandDocked();
    expect(store.getCommandBandDocked()).toBe(false);
    // removeItem으로 지우면 다음 부팅이 "저장된 적 없음"과 구별하지 못한다 — 여기서는 같은
    // 기본값이라 증상이 없지만, 기본값이 바뀌는 날 조용히 뒤집힌다.
    expect(localStorage.getItem(KEY)).toBe("0");

    store.toggleCommandBandDocked();
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  it("keeps this session's choice when storage refuses the write", async () => {
    const store = await loadStore(null);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => store.setCommandBandDocked(true)).not.toThrow();
    expect(store.getCommandBandDocked()).toBe(true);
  });

  it("survives storage that refuses to be read at boot", async () => {
    vi.resetModules();
    localStorage.clear();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const store = await import(MODULE);
    expect(store.getCommandBandDocked()).toBe(false);
  });
});
