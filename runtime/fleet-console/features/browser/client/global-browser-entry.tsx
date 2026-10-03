import type { RailEntryDescriptor, RailPanelContext } from "@fleet-console/sdk/rail";

import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { getT } from "./i18n.js";
import { globalBrowserAttention, isGlobalBrowserOpen, subscribeGlobalBrowserOpen, toggleGlobalBrowser } from "./global-browser-store.js";

/**
 * 전역 Fleet 브라우저의 도구모음 진입점 — fleet 범위 레일 도구 칸 맨 앞.
 *
 * 레지스트리 판단(D): rail entry(activate로 시트 열기)로 등록하면 위치(fleet 맨 앞,
 * consoleExecution이 첫 provider라 플러그인 fleet보다 앞선다)・툴팁+단축키 표기
 * (CORE 명령 railEntryId 연계)・`rail-tab-fleet-browser` 셀렉터・`Mod+Shift+B` 발화
 * (toggleRailSurface→activate, repeat 무시 포함)가 추가 배선 없이 해결된다.
 * 켜짐 표시와 웹 탭 숨김은 entry의 `active`·`visible` 선언으로 푼다.
 */

export const GLOBAL_BROWSER_RAIL_ENTRY_ID = "fleet-browser";

function activateGlobalBrowser(_ctx: RailPanelContext): void {
  toggleGlobalBrowser();
}

export const globalBrowserEntry: RailEntryDescriptor = {
  id: GLOBAL_BROWSER_RAIL_ENTRY_ID,
  title: (locale) => getT(locale)("terminal.globalBrowser.title"),
  icon: FleetBrowserGlyph,
  scope: "fleet",
  activate: activateGlobalBrowser,
  // 시트를 열어도 지금 보는 Operation은 그대로 이어진다(목표 entry와 같은 계약).
  keepsOperationActive: true,
  // 시트가 열려 있는 동안 같은 문법(아래 brass 선 + aria-pressed)으로 켜진다.
  active: {
    subscribe: subscribeGlobalBrowserOpen,
    isActive: isGlobalBrowserOpen,
  },
  // 네이티브 뷰가 없는 문서(웹 탭·모바일 셸 아님)에는 칸을 두지 않는다. 영원히 못 쓰는
  // 칸을 비활성으로 두면 소음이 된다(강등 규칙 §5.3 — 숨김).
  visible: () => isDesktopShell(),
  // 시트를 띄우지 않고 연 뒤 탭이 있으면 모서리에 수를 세운다.
  attention: globalBrowserAttention,
};

/**
 * Fleet 브라우저 글리프 — 시안 G1: 지구본 + 바깥 궤도 호.
 * Operation 브라우저의 기존 지구본과 같은 가족의 변주다.
 * 16 격자, stroke 1.35, round cap/join, fill none.
 */
export function FleetBrowserGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="4.6" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M3.4 8h9.2M8 3.4c1.8 1.8 1.8 7.4 0 9.2M8 3.4c-1.8 1.8-1.8 7.4 0 9.2"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <path d="M12.2 3.4a5 5 0 0 1 0 9.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}
