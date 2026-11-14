import {
  isRoutableLink,
  openInDefaultOsBrowser,
  type OpenLinkGesture,
} from "@fleet-console/link/core";

import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { getBrowserEngineSnapshot } from "./browser-engine.js";
import { openBrowserLink } from "./browser-surface.js";

/**
 * Session 이 없는 표면(목표·Wiki·파일·도움말·Settings 등)의 링크 열기.
 *
 * 고를 브라우저가 내 브라우저 하나뿐이므로 카드를 세우지 않는다. Desktop shared 이면
 * 내 브라우저로 열고 처음 한 번 안내한다. 브라우저를 쓸 수 없으면 false 를 돌려
 * 호출부가 기존 앵커 동작으로 떨어지게 한다.
 */

export interface OtherLinkAvailability {
  readonly canOffer: boolean;
  readonly viewOnly: boolean;
}

export function readOtherLinkAvailability(): OtherLinkAvailability {
  const engine = getBrowserEngineSnapshot();
  const remote = engine?.surfaceMode === "remote";
  return {
    canOffer: remote ? engine.available : engine === null || engine.available,
    viewOnly: engine?.surfaceMode === "viewer",
  };
}

export function openOtherSurfaceLink(url: string, _gesture: OpenLinkGesture): boolean {
  if (!isDesktopShell()) return false;
  if (!isRoutableLink(url, typeof window !== "undefined" ? window.location.origin : undefined)) return false;
  const availability = readOtherLinkAvailability();
  if (availability.viewOnly || !availability.canOffer) return false;
  // 원격 Desktop 은 플릿 브라우저로 연다. 웹·모바일은 위에서 떨어지고, viewer 는 viewOnly 로 막힌다.
  if (getBrowserEngineSnapshot()?.surfaceMode === "remote") {
    void openBrowserLink(url);
    return true;
  }
  openInDefaultOsBrowser(url);
  return true;
}
