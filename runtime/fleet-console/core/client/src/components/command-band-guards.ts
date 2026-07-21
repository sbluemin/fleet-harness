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
