import {
  FLEET_LINK_NATIVE,
  FLEET_LINK_SELF,
  gestureFromEvent,
  isRoutableLink,
} from "@fleet-console/link/core";

import { openOtherSurfaceLink } from "./global-link.js";

/**
 * 문서 수준 링크 라우터 — Session 이 없는 표면의 앵커를 내 브라우저로 잇는다.
 *
 * bubble 단계 리스너 하나가 `a[href]`를 보고, http(s)면서 Console 자기 origin이
 * 아니면 내 브라우저로 연다. 고를 대상이 하나뿐이라 카드를 세우지 않는다. bubble이라서 먼저
 * `preventDefault()`하는 표면은 자연히 존중된다. `stopPropagation`을 쓰는 표면
 * (objectives link-text 등)은 여기에 닿지 않으므로 그 자리에서 SDK 공개 API를
 * 명시 호출한다.
 *
 * 예외 표식: `data-fleet-link="native"`(「내 브라우저에서 열기」 등 OS 탈출구 —
 * 절대 가로채지 않음), `data-fleet-link="self"`(채팅·CLI·전역 Shell처럼 자체
 * 카드로 처리하는 영역).
 */
export function installGlobalLinkRouter(): void {
  if (typeof document === "undefined") return;
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("auxclick", onDocumentAuxClick);
}

function onDocumentClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return;
  routeLinkEvent(event);
}

function onDocumentAuxClick(event: MouseEvent): void {
  // 가운데 클릭은 click이 아니라 auxclick으로만 온다.
  if (event.defaultPrevented || event.button !== 1) return;
  routeLinkEvent(event);
}

function routeLinkEvent(event: MouseEvent): void {
  const target = event.target as Element | null;
  const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor) return;
  const marked = anchor.closest("[data-fleet-link]")?.getAttribute("data-fleet-link");
  if (marked === FLEET_LINK_NATIVE || marked === FLEET_LINK_SELF) return;
  // anchor.href는 절대 URL이다 — 상대·해시는 같은 origin이라 걸러진다.
  if (!isRoutableLink(anchor.href, window.location.origin)) return;
  if (!openOtherSurfaceLink(anchor.href, gestureFromEvent(event))) return;
  event.preventDefault();
}
