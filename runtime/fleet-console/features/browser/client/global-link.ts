import {
  isRoutableLink,
  openInDefaultOsBrowser,
  type OpenLinkGesture,
} from "@fleet-console/link/core";

import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { getBrowserEngineSnapshot } from "./browser-panel-store.js";
import { notifySharedFallback } from "./global-browser-store.js";
import { openInFleetBrowserBackground, openInFleetBrowserSheet, type LinkOpenAt } from "./link-open-card.js";

/**
 * 기타 표면(목표·Wiki·부관·파일·Skills·도움말·Settings 등)의 링크 열기.
 *
 * 손짓은 전역 Shell의 2행 카드와 한 벌이다: 클릭·Alt=카드(Fleet 브라우저 / 내 브라우저 —
 * Operation 행 없음), ⌘·가운데=뒤 탭(시트 안 띄움, 칸에 수), Shift=내 브라우저.
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

/* ── 카드 요청 — 전역 영속 호스트(GlobalLinkCardHost)가 구독해 그린다. ── */

export interface GlobalLinkCardRequest { readonly url: string; readonly at: LinkOpenAt; readonly serial: number }

let cardRequest: GlobalLinkCardRequest | null = null;
let cardSerial = 0;
const cardListeners = new Set<() => void>();

function setCardRequest(next: GlobalLinkCardRequest | null): void {
  cardRequest = next;
  for (const listener of cardListeners) listener();
}

export function subscribeGlobalLinkCard(listener: () => void): () => void {
  cardListeners.add(listener);
  return () => { cardListeners.delete(listener); };
}

export function getGlobalLinkCardRequest(): GlobalLinkCardRequest | null { return cardRequest; }

export function closeGlobalLinkCard(): void {
  if (cardRequest !== null) setCardRequest(null);
}

/* ── 누른 자리 — SDK openLink는 좌표를 싣지 않으므로 capture 단계에서 마지막 포인터를 기억한다.
   stopPropagation하는 표면(목표 link-text 등)도 document capture는 먼저 지나간다. ── */

const POINTER_FRESH_MS = 1500;
let lastPointer: { readonly x: number; readonly y: number; readonly time: number } | null = null;

export function trackLinkPointer(event: PointerEvent | MouseEvent): void {
  // 키보드로 누른 click(detail 0, 좌표 0)은 자리가 아니다.
  if (event.type === "click" && event.detail === 0) return;
  lastPointer = { x: event.clientX, y: event.clientY, time: Date.now() };
}

function resolveCardAt(at: LinkOpenAt | undefined): LinkOpenAt {
  if (at) return at;
  if (lastPointer && Date.now() - lastPointer.time <= POINTER_FRESH_MS) return { x: lastPointer.x, y: lastPointer.y };
  // 키보드로 연 링크 — 포커스를 쥔 요소 아래에서 펼친다.
  const active = typeof document === "undefined" ? null : document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    const rect = active.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom };
  }
  return { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 3) };
}

export function openOtherSurfaceLink(url: string, gesture: OpenLinkGesture, at?: LinkOpenAt): boolean {
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
    openInFleetBrowserBackground(url);
    return true;
  }
  // click·companion — 어디서 열지 카드로 묻는다(Operation 행 없음). 카드를 그릴 호스트가 없으면
  // 예전처럼 Fleet 브라우저 시트로 곧장 연다 — 누른 링크는 반드시 어딘가 열린다.
  if (cardListeners.size === 0) {
    openInFleetBrowserSheet(url);
    return true;
  }
  cardSerial += 1;
  setCardRequest({ url, at: resolveCardAt(at), serial: cardSerial });
  return true;
}
