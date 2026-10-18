import { useViewMode } from "./view-mode-store.js";

/** 좌측 사이드바가 지금 화면에 보이는가 — 사이드바는 접히지 않으므로 모바일 셸에서만 없다. */
export function useHostSideBarVisible(): boolean {
  return useViewMode().effective !== "mobile";
}
