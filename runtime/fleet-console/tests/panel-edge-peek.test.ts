// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { getRailStoreSnapshot, setRailChromeExpanded, setRailPeeking } from "../core/client/src/rail/rail-store.js";
import { getSideBarState, setSideBarCollapsed, setSideBarPeeking } from "../core/client/src/sidebar/operations-side-bar-store.js";

// Periscope 픽의 스토어 계약 — 픽은 접힌 패널 위에서만 서고, dock 상태 전환은 어느 방향이든
// 픽을 끝낸다. 이 두 규칙이 무너지면 펼쳐진 카드 위에 유령 픽이 남거나, ⌘B 접힘이
// 픽 잔상 때문에 화면에서 아무 일도 안 한 것처럼 보인다.
describe("side bar peek contract", () => {
  afterEach(() => {
    setSideBarPeeking(false);
    setSideBarCollapsed(false);
  });

  it("only peeks while collapsed", () => {
    setSideBarCollapsed(false);
    setSideBarPeeking(true);
    expect(getSideBarState().peeking).toBe(false);

    setSideBarCollapsed(true);
    setSideBarPeeking(true);
    expect(getSideBarState().peeking).toBe(true);
  });

  it("ends the peek on any dock transition", () => {
    setSideBarCollapsed(true);
    setSideBarPeeking(true);

    setSideBarCollapsed(false);
    expect(getSideBarState().peeking).toBe(false);

    setSideBarCollapsed(true);
    expect(getSideBarState().peeking).toBe(false);
  });
});

describe("rail peek contract", () => {
  afterEach(() => {
    setRailPeeking(false);
    setRailChromeExpanded(true);
  });

  it("only peeks while the chrome is collapsed", () => {
    setRailChromeExpanded(true);
    setRailPeeking(true);
    expect(getRailStoreSnapshot().railPeeking).toBe(false);

    setRailChromeExpanded(false);
    setRailPeeking(true);
    expect(getRailStoreSnapshot().railPeeking).toBe(true);
  });

  it("ends the peek on any dock transition", () => {
    setRailChromeExpanded(false);
    setRailPeeking(true);

    setRailChromeExpanded(true);
    expect(getRailStoreSnapshot().railPeeking).toBe(false);

    setRailChromeExpanded(false);
    expect(getRailStoreSnapshot().railPeeking).toBe(false);
  });
});
