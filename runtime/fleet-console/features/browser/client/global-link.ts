import {
  isRoutableLink,
  openInDefaultOsBrowser,
  type OpenLinkGesture,
} from "@fleet-console/link/core";

import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { getBrowserEngineSnapshot } from "./browser-panel-store.js";
import {
  focusOrCreateGlobalTab,
  noteBackgroundTab,
  notifySharedFallback,
  openGlobalBrowser,
} from "./global-browser-store.js";

/**
 * 기타 표면(목표·Wiki·부관·파일·Skills·도움말·Settings 등)의 링크 열기.
 *
 * 손짓 한 벌: 클릭=Fleet 브라우저 시트, ⌘·가운데=뒤 탭(시트 안 띄움, 칸에 수),
 * Shift=내 브라우저, Alt=클릭과 같음(대상 Operation 없음).
 * 브라우저를 쓸 수 없으면 false를 돌려 호출부가 기존 앵커 동작으로 떨어지게 한다.
 * Desktop shared일 때는 내 브라우저로 열고 처음 한 번 안내한다.
 */

export interface OtherLinkAvailability {
  readonly canOffer: boolean;
  readonly isShared: boolean;
}

export function readOtherLinkAvailability(): OtherLinkAvailability {
  const engine = getBrowserEngineSnapshot();
  return {
    canOffer: engine === null || engine.available,
    isShared: engine !== null && !engine.available && engine.reason === "shared",
  };
}

export function openOtherSurfaceLink(url: string, gesture: OpenLinkGesture): boolean {
  // 뷰를 그릴 셸이 없는 문서(웹 탭)에서는 묻지도 가로채지도 않는다 — 엔진 상태는
  // 구독자가 있을 때만 채워지므로, null을 곧바로 앵커 기본 동작으로 떨어뜨린다.
  if (!isDesktopShell()) return false;
  if (!isRoutableLink(url, typeof window !== "undefined" ? window.location.origin : undefined)) return false;
  const availability = readOtherLinkAvailability();
  if (!availability.canOffer) {
    if (!availability.isShared) return false;
    notifySharedFallback();
    openInDefaultOsBrowser(url);
    return true;
  }
  if (gesture === "external") {
    openInDefaultOsBrowser(url);
    return true;
  }
  if (gesture === "background") {
    // 뒤 탭 — 시트를 띄우지 않고 탭만 열고, 칸에 수를 남긴다. 실패하면 OS로 떨어진다.
    void focusOrCreateGlobalTab(url, { activate: false }).then((ok) => {
      if (ok) noteBackgroundTab();
      else openInDefaultOsBrowser(url);
    }).catch(() => openInDefaultOsBrowser(url));
    return true;
  }
  // click·companion — 시트를 띄우고 새 탭(같은 주소면 그 탭)으로 연다. 실패하면 OS로 떨어진다.
  void focusOrCreateGlobalTab(url).then((ok) => {
    if (ok) openGlobalBrowser();
    else openInDefaultOsBrowser(url);
  }).catch(() => openInDefaultOsBrowser(url));
  return true;
}
