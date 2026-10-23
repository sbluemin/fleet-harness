import { isBlockingDialogOpen } from "./shortcuts.js";
import { setActiveObjective } from "./store.js";

// 대화 화면에서 사이드바·레일·커맨드 밴드 밖을 누르면 활성 Objective을 푼다.
// 좌·우 사이드바의 빈 곳을 누르면 Objective 활성화가 풀린다.
// 칩은 그 Objective을 고르는 진입점이고, 커맨드 밴드·패널 포털 메뉴는 활성 Objective을
// 전제로 하므로 별도 표식으로 유지한다.
const KEEP_ACTIVE_SELECTOR = [
  "[data-side-bar-chip-id]",
  "[data-keep-objective-active]",
].join(", ");

export function shouldReleaseActiveObjective(target: EventTarget | null, documentFor: Document = document): boolean {
  if (isBlockingDialogOpen(documentFor)) return false;
  if (!(target instanceof Element)) return false;
  return target.closest(KEEP_ACTIVE_SELECTOR) === null;
}

export function blurActiveElement(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

export function clearActiveObjective(): void {
  blurActiveElement();
  setActiveObjective(null);
}
