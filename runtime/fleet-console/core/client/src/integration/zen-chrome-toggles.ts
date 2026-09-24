import { getRailStoreSnapshot, setRailChromeExpanded } from "../chrome/rail/rail-store.js";
import { getSideBarState, setSideBarCollapsed } from "../../../../features/workspace/client/sidebar/operations-side-bar-store.js";
import { getZenModeState, setZenRailRevealed, setZenSideBarRevealed } from "./zen-mode.js";

/**
 * Zen 안의 좌우 사이드바 토글. Zen을 끄지 않고 그 쪽 크롬만 드러내거나 다시 숨긴다.
 * 숨김은 Zen 드러냄만 걷고 저장된 접힘 선호는 건드리지 않는다. 드러낼 때 선호가 접힘이면
 * 펼친다 — 사용자가 명시적으로 연 것이므로 접힌 모서리만 보여 주면 연 것이 아니다.
 * 반환값은 토글 뒤 그 쪽이 보이는지다.
 */
export function toggleZenSideBar(): boolean {
  // 드러낸 뒤 사이드바 자신의 접기 버튼으로 접었다면 보이는 것이 없으므로 다음 토글은 다시 연다.
  if (getZenModeState().sideBarRevealed && !getSideBarState().collapsed) {
    setZenSideBarRevealed(false);
    return false;
  }
  if (getSideBarState().collapsed) setSideBarCollapsed(false);
  setZenSideBarRevealed(true);
  return true;
}

/** Zen의 레일은 이미 열린 패널 카드를 남긴다. 그 카드가 보이는 동안의 토글은 닫힘이다. */
export function isZenRailVisible(): boolean {
  const rail = getRailStoreSnapshot();
  return rail.railChromeExpanded && (getZenModeState().railRevealed || rail.activePanelId !== null);
}

export function toggleZenRail(): boolean {
  if (isZenRailVisible()) {
    const hadPanel = getRailStoreSnapshot().activePanelId !== null;
    setZenRailRevealed(false);
    if (hadPanel) setRailChromeExpanded(false);
    return false;
  }
  setRailChromeExpanded(true);
  setZenRailRevealed(true);
  return true;
}
