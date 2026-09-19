import { isBlockingDialogOpen } from "./shortcuts.js";
import { setActiveOperation } from "./store.js";

// 문서 캡처 가드는 Map 위 패널·미니맵·Map 표면을 유지한다. 빈 바다의 해제는 캔버스
// onClick이 맡고, 좌·우 사이드바는 data-canvas-blocker라서 제스처만 막고 활성화는 풀린다.
// 칩은 그 Operation을 고르는 진입점이고, 커맨드 밴드·패널 포털 메뉴는 활성 Operation을
// 전제로 하므로 별도 표식으로 유지한다.
const KEEP_ACTIVE_SELECTOR = [
  ".operations-canvas",
  "[data-canvas-operation]",
  "[data-side-bar-chip-id]",
  "[data-keep-operation-active]",
].join(", ");

// War Room은 캔버스 제스처 훅을 끄므로 Cruise의 onClick 빈 바다 해제가 닿지 않는다.
// 덱·빈 판은 Map 표면(.operations-canvas) 안이라 문서 캡처 가드도 유지를 고른다.
// 카드·점·패널·승격 면이 아닌 War Room 자리만 활성 해제의 빈곳으로 본다.
const WAR_ROOM_EMPTY_SURFACE_SELECTOR = [
  ".operations-canvas.is-triage",
  ".canvas-triage-deck",
  ".canvas-triage-clear",
].join(", ");

const WAR_ROOM_OWNED_SELECTOR = [
  "[data-canvas-operation]",
  "[data-triage-deck-card]",
  ".canvas-triage-deck-pick",
  ".canvas-minimap",
  ".canvas-context-menu",
].join(", ");

export function isMapActivationSurface(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".operations-canvas, [data-canvas-operation]") !== null;
}

export function shouldReleaseActiveOperation(target: EventTarget | null, documentFor: Document = document): boolean {
  if (isBlockingDialogOpen(documentFor)) return false;
  if (!(target instanceof Element)) return false;
  return target.closest(KEEP_ACTIVE_SELECTOR) === null;
}

export function isWarRoomEmptyReleaseTarget(target: EventTarget | null, documentFor: Document = document): boolean {
  if (isBlockingDialogOpen(documentFor)) return false;
  if (!(target instanceof Element)) return false;
  if (target.closest(WAR_ROOM_OWNED_SELECTOR) !== null) return false;
  return target.closest(WAR_ROOM_EMPTY_SURFACE_SELECTOR) !== null;
}

export function blurActiveElement(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

export function clearActiveOperation(): void {
  blurActiveElement();
  setActiveOperation(null);
}
