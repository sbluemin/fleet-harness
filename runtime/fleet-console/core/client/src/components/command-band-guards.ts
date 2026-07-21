import type { OperationNode } from "../types.js";

export function commandBandRenameCommitTarget(capturedOperationId: string | null, activeOperationId: string | null): string | null {
  return capturedOperationId !== null && capturedOperationId === activeOperationId ? capturedOperationId : null;
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
