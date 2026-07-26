import { flattenGroupedOrder } from "../store.js";
import type { OperationGroup, OperationNode } from "../types.js";

export function commandBandRenameCommitTarget(capturedOperationId: string | null, activeOperationId: string | null): string | null {
  return capturedOperationId !== null && capturedOperationId === activeOperationId ? capturedOperationId : null;
}

// Operation 메뉴는 사이드바·Alt+←/→와 동일한 그룹 인식 순서를 미러한다. collapsedGroups는
// 넘기지 않는다 — 스위처 메뉴는 접힌 그룹의 Operation도 도달 가능해야 한다(순서만 미러, 가시성 미러 아님).
export function commandBandTheaterOperations(
  operations: readonly OperationNode[],
  groups: readonly OperationGroup[],
  activeTheaterId: string | null,
  operationOrder: readonly string[],
): readonly OperationNode[] {
  return flattenGroupedOrder(
    operations.filter((operation) => operation.theaterId === activeTheaterId),
    groups.filter((group) => group.theaterId === activeTheaterId),
    operationOrder,
  );
}

// Theater만 전환하면(setActiveTheater) activeOperationId가 남는다 — 브레드크럼은
// 활성 Theater 소속 Operation만 신뢰한다(표시 가드, state는 건드리지 않는다).
export function commandBandActiveOperation(
  operations: readonly OperationNode[],
  activeOperationId: string | null,
  activeTheaterId: string | null,
): OperationNode | null {
  if (activeOperationId === null || activeTheaterId === null) return null;
  const operation = operations.find((candidate) => candidate.id === activeOperationId) ?? null;
  return operation !== null && operation.theaterId === activeTheaterId ? operation : null;
}

// Tab 등으로 포커스가 스위처 래퍼(트리거+메뉴) 밖으로 나가면 메뉴를 닫는다.
// relatedTarget null(창 블러·비포커서블 클릭)도 닫는다 — 바깥 pointerdown 경로와 멱등.
export function commandBandSwitcherFocusLeft(wrapper: HTMLElement, relatedTarget: EventTarget | null): boolean {
  return !(relatedTarget instanceof Node && wrapper.contains(relatedTarget));
}

// 포털 없는 밴드 내 absolute 메뉴의 left(래퍼 좌표계)를 viewport gutter 안으로 clamp한다.
// 우측 초과를 먼저 안으로 끌어들이고, 좌측 하한(gutter)이 최종 우선한다.
export function commandBandMenuClampedLeft(
  desiredLeft: number,
  wrapperViewportLeft: number,
  menuWidth: number,
  viewportWidth: number,
  gutter = 12,
): number {
  const maxLeft = viewportWidth - gutter - menuWidth - wrapperViewportLeft;
  const minLeft = gutter - wrapperViewportLeft;
  return Math.max(minLeft, Math.min(desiredLeft, maxLeft));
}

// 맵 컨트롤 클러스터(.command-band-map-controls)는 절대 배치라 그리드가 그 폭을 모른다.
// 매직 오프셋 상수는 버튼이 늘 때마다 겹침으로 깨졌으므로(구 116px 사고) 실측 폭에서 계산한다.
// 좌우 여백 트랙은 반드시 같은 하한을 쓴다 — 값이 어긋나면 하한이 물리는 순간 중앙이 밀린다.
// 사이드바를 접으면 밴드 좌측 캡은 자리를 지키지만 스테이지 좌단은 0으로 내려간다. 그 차이가
// mapControlsLead — 하한은 스테이지 원점 기준으로 재야 접힌 상태에서도 겹치지 않는다.
export const COMMAND_BAND_MAP_CONTROLS_INSET_PX = 8;
export const COMMAND_BAND_CENTER_BREATHING_PX = 12;
export const COMMAND_BAND_CENTER_GUTTER_FLOOR_PX = 44;
export const COMMAND_BAND_CENTER_MIN_PX = 168;

// Activity Rail의 고정 스트립 폭. 패널 폭은 포함하지 않는다 — PR #302가 밴드를 레일
// 크기 조절에서 떼어냈고, 여기서 예약하는 것은 접히지 않은 레일이 늘 차지하는 스트립뿐이다.
export const COMMAND_BAND_RAIL_STRIP_PX = 44;

export function commandBandCenterGutter(mapControlsLead: number, mapControlsWidth: number): number {
  if (mapControlsWidth <= 0) return COMMAND_BAND_CENTER_GUTTER_FLOOR_PX;
  return Math.max(
    COMMAND_BAND_CENTER_GUTTER_FLOOR_PX,
    mapControlsLead + COMMAND_BAND_MAP_CONTROLS_INSET_PX + mapControlsWidth + COMMAND_BAND_CENTER_BREATHING_PX,
  );
}

// 좌우 여백 트랙을 뺀 나머지가 최소 판독 폭에 못 미치면 브레드크럼을 접는다.
// 미측정(0 이하)은 보이는 쪽으로 판정한다 — 첫 페인트에서 깜빡이며 사라지지 않게 한다.
export function commandBandCenterFits(centerTrackWidth: number, gutter: number): boolean {
  if (centerTrackWidth <= 0) return true;
  return centerTrackWidth - gutter * 2 >= COMMAND_BAND_CENTER_MIN_PX;
}
