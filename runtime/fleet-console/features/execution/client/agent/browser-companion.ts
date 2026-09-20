import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

/** Operation Browser companion의 id — 캡션의 지구본 문, Alt+B, 링크 열기가 같은 이름을 부른다. */
export const BROWSER_COMPANION_ID = "browser";

/**
 * 브라우저 패널을 연다 — 여는 쪽만 하는 손잡이다.
 *
 * 캡션의 문은 토글이지만(같은 버튼이 닫기도 한다) 링크를 여는 쪽은 여는 일만 한다: 이미 열려 있는
 * 패널을 링크 하나가 닫으면 방금 고른 주소가 갈 자리가 없다.
 */
export function openBrowserCompanion(context: OperationRenderContext): void {
  if (!context.onSetCompanionPanelVisible) {
    context.onRequestCompanions?.(true);
    return;
  }
  if (!context.companionsOpen) context.onRequestCompanions?.(true);
  context.onSetCompanionPanelVisible(BROWSER_COMPANION_ID, true);
}
