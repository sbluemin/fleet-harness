/**
 * 호스트와 무관한 표현 상태의 저장 키. 소유 스토어와 콘솔 간 이월(features/remote-access/client/presentation-carry.ts)이
 * 같은 이름을 본다.
 *
 * 부수효과 없는 잎 모듈이어야 한다 — 이월은 부팅 첫 모듈에서 스토어보다 먼저 평가되고, 여기서 스토어를
 * 끌어오면 스토어가 이월 전 값을 먼저 읽는다.
 */
export const TOOLBAR_FOLDED_STORAGE_KEY = "fleet-console.toolbar.folded";
export const RAIL_ACTIVE_PANEL_STORAGE_KEY = "fleet-console.rail.activePanelId";
export const RAIL_PANEL_WIDTHS_STORAGE_KEY = "fleet-console.rail.panelWidths";
/** 탭 세션(sessionStorage)에 산다 — 캔버스 모드는 같은 창에 머무는 동안만 기억한다. */
export const CANVAS_MODE_STORAGE_KEY = "fleet.console.canvas-mode";
