import { isBlockingDialogOpen } from "./focus-guards.js";
import { setActiveOperation } from "./store.js";

// Map 위 패널·미니맵·빈 바다만 활성 표면이다. 좌·우 사이드바는 data-canvas-blocker라서
// 제스처만 막고, 활성화는 유지하지 않는다.
// 칩은 그 Operation을 고르는 진입점이고, 커맨드 밴드·패널 포털 메뉴는 활성 Operation을
// 전제로 하므로 별도 표식으로 유지한다.
const KEEP_ACTIVE_SELECTOR = [
  ".operations-canvas",
  "[data-canvas-operation]",
  "[data-side-bar-chip-id]",
  "[data-keep-operation-active]",
].join(", ");

export function isMapActivationSurface(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".operations-canvas, [data-canvas-operation]") !== null;
}

export function shouldReleaseActiveOperation(target: EventTarget | null, documentFor: Document = document): boolean {
  if (isBlockingDialogOpen(documentFor)) return false;
  if (!(target instanceof Element)) return false;
  return target.closest(KEEP_ACTIVE_SELECTOR) === null;
}

export function clearActiveOperation(): void {
  if (typeof document !== "undefined") {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }
  setActiveOperation(null);
}
