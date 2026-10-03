import {
  FLEET_LINK_NATIVE,
  FLEET_LINK_SELF,
  gestureFromEvent,
  isRoutableLink,
} from "@fleet-console/link/core";

import { openOtherSurfaceLink, trackLinkPointer } from "./global-link.js";

/**
 * 문서 수준 링크 라우터 — 표면마다 흩어진 앵커를 한 곳에서 전역 브라우저로 잇는다.
 *
 * bubble 단계 리스너 하나가 `a[href]`를 보고, http(s)면서 Console 자기 origin이
 * 아니면 openLink로 넘긴다(클릭·Alt는 2행 선택 카드, ⌘·가운데는 뒤 탭, Shift는 내 브라우저). bubble이라서 War Room 감시 카드처럼 먼저
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
  // 누른 자리를 먼저 기억한다 — stopPropagation 표면이 SDK openLink로 부를 때 카드가 그 점에서 선다.
  document.addEventListener("pointerdown", trackLinkPointer, true);
  document.addEventListener("click", trackLinkPointer, true);
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
  // 키보드로 누른 링크(detail 0)는 좌표가 없다 — 앵커 아래에서 카드를 펼친다.
  const rect = event.detail === 0 ? anchor.getBoundingClientRect() : null;
  const at = rect ? { x: rect.left, y: rect.bottom } : { x: event.clientX, y: event.clientY };
  if (!openOtherSurfaceLink(anchor.href, gestureFromEvent(event), at)) return;
  event.preventDefault();
}
