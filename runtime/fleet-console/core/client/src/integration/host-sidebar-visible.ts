import { useSideBarState } from "../../../../features/workspace/client/sidebar/operations-side-bar-store.js";
import { useViewMode } from "./view-mode-store.js";

/** 좌측 사이드바가 지금 화면에 보이는가 — 접힘 선호와 모바일을 함께 본다. */
export function useHostSideBarVisible(): boolean {
  const { collapsed } = useSideBarState();
  const mobile = useViewMode().effective === "mobile";
  return !mobile && !collapsed;
}
