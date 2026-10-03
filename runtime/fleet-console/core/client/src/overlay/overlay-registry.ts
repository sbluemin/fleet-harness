import { useSyncExternalStore } from "react";

/**
 * Console 층 오버레이 레지스트리 — 네이티브 브라우저 뷰를 언제 물릴지 한 곳에서 안다.
 *
 * 네이티브 뷰는 언제나 웹 DOM 위에 그려지므로, Console 층이 뷰 사각형과 겹치면
 * 뷰를 물리고 그 자리에 정지 화면(없으면 무채색 자리)을 깐다. CSS z-index로는
 * 풀리지 않는다. 기존에는 메뉴마다 각자 알렸고(`aria-modal` 감지, 캡션 메뉴 신호),
 * 이제 한 레지스트리로 넓힌다.
 *
 * 두 입력의 합집합이다:
 * - 명시 발행(`publishConsoleOverlay`) — 스스로 뜨고 지는 것을 아는 층이 알린다.
 * - DOM 표식 폴백 — 별도 배선 없이 동작해야 하는 층(팔레트·퀵런치·토스트·툴팁·메뉴·대화상자)은
 *   이미 코드베이스에 있는 안정된 표식으로 읽는다. 표식은 거짓말을 하지 않는 것만 쓴다.
 *   (aria-modal, 역할 표식, 각 층의 오버레이 루트 클래스)
 *
 * 주의: 전역 브라우저 시트 자체는 `role="dialog"`가 아니라 `role="region"`이다.
 * 시트가 dialog면 이 레지스트리가 시트가 열린 내내 켜져 뷰가 영원히 물러선다.
 */

const listeners = new Set<() => void>();
const published = new Map<string, boolean>();
let markerActive = false;
let observing = false;

function notify(): void {
  for (const listener of listeners) listener();
}

/** 스스로 뜨고 지는 것을 아는 층이 알린다. 닫힐 때는 반드시 false로 거둔다. */
export function publishConsoleOverlay(id: string, open: boolean): void {
  const next = open === true;
  if ((published.get(id) ?? false) === next) return;
  if (next) published.set(id, true);
  else published.delete(id);
  notify();
}

function hasPublished(): boolean {
  return published.size > 0;
}

/**
 * DOM 표식으로 읽는 오버레이. 시트 본문(뷰 자리)을 가릴 수 있는 Console 층이다.
 * - `[aria-modal="true"]`: 스스로 모달이라 말하는 대화상자.
 * - `[role="menu"]`, `.command-band-system-menu`: 열린 메뉴. 캡션·프로필 메뉴와
 *   링크 카드도 여기에 걸린다 — 뷰 위에 뜨는 메뉴는 모두 뷰를 물린다.
 * - `.operation-search-overlay`(⌘K·⌘P), `.quick-launch-overlay`(Quick Launch).
 * - `.app-toast-host`의 자식: 떠 있는 토스트. 시트 바깥으로 비켜도 뜨는 동안은 겹친 것으로 본다.
 * - `.console-toolbar-tip.is-visible`: 도구모음 말풍선.
 * - `[data-feature-tour-id]`, `.onboarding-welcome-overlay`: 기능 소개 투어·온보딩
 *   웰컴. 투어 카드(z 120)는 뷰보다 위에 서므로 뜨면 뷰를 물린다.
 */
const OVERLAY_SELECTOR = [
  '[aria-modal="true"]',
  '[role="menu"]',
  ".command-band-system-menu",
  ".operation-search-overlay",
  ".quick-launch-overlay",
  ".console-toolbar-tip.is-visible",
  "[data-feature-tour-id]",
  ".onboarding-welcome-overlay",
].join(",");

function readMarkers(): boolean {
  if (typeof document === "undefined") return false;
  if (document.querySelector(OVERLAY_SELECTOR) !== null) return true;
  const host = document.querySelector(".app-toast-host");
  return host !== null && host.childElementCount > 0;
}

function recompute(): void {
  const next = readMarkers();
  if (next === markerActive) return;
  markerActive = next;
  notify();
}

function ensureObserving(): void {
  if (observing || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  observing = true;
  recompute();
  const observer = new MutationObserver(recompute);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "aria-modal", "aria-hidden", "aria-expanded"],
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureObserving();
  // 보이는 동안 붙었다 떨어지는 일은 이벤트로 오지 않을 수 있다 — 구독 시작점에서 한 번 잰다.
  recompute();
  return () => { listeners.delete(listener); };
}

function snapshot(): boolean {
  if (typeof document !== "undefined") ensureObserving();
  return markerActive || hasPublished();
}

/** 지금 Console 층이 떠 있는가 — 떠 있으면 네이티브 뷰를 즉시 물린다. */
export function useConsoleOverlayActive(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
