import {
  isRoutableLink,
  openInDefaultOsBrowser,
  type OpenLinkGesture,
} from "@fleet-console/link/core";

import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { getBrowserEngineSnapshot } from "./browser-panel-store.js";
import { notifySharedFallback } from "./browser-shared-fallback.js";

/**
 * Session 이 없는 표면(목표·Wiki·부관·파일·도움말·Settings 등)의 링크 열기.
 *
 * 고를 브라우저가 내 브라우저 하나뿐이므로 카드를 세우지 않는다. Desktop shared 이면
 * 내 브라우저로 열고 처음 한 번 안내한다. 브라우저를 쓸 수 없으면 false 를 돌려
 * 호출부가 기존 앵커 동작으로 떨어지게 한다.
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

export function openOtherSurfaceLink(url: string, _gesture: OpenLinkGesture): boolean {
  if (!isDesktopShell()) return false;
  if (!isRoutableLink(url, typeof window !== "undefined" ? window.location.origin : undefined)) return false;
  const availability = readOtherLinkAvailability();
  if (!availability.canOffer) {
    if (!availability.isShared) return false;
    notifySharedFallback();
  }
  openInDefaultOsBrowser(url);
  return true;
}
