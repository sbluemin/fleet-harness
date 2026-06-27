import { useEffect, useMemo, useRef } from "react";

import { OperationsCanvas } from "../canvas/canvas.js";
import { clearMaximizedOperationId, ensureDefaultGeometry, focusOperation as focusCanvasOperation, loadForTheater, pruneOperations, setMaximizedOperationId, useMaximizedOperationId } from "../canvas/canvas-store.js";
import { RightRail } from "../rail/right-rail.js";
import { consumeOperationFocus, focusOperation, nextOperationId, setActiveOperation } from "../store.js";
import type { ConsoleState, OperationNode } from "../types.js";

interface OperationsProps {
  readonly state: ConsoleState;
}

export function Operations({ state }: OperationsProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const maximizedOperationId = useMaximizedOperationId();
  const operationOrder = useMemo(
    () => sortedTheaterOperations(state).map((operation) => operation.id),
    [state.operations, state.activeTheaterId],
  );
  // 최신 state를 keydown 핸들러에서 읽기 위한 ref(핸들러는 한 번만 등록).
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    loadForTheater(state.activeTheaterId);
  }, [state.activeTheaterId]);

  // Alt+←/→ 로 현재 Theater 내 Operation 포커스를 순환 이동한다.
  useEffect(() => {
    const maximizedRef = { current: maximizedOperationId };
    const handler = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // rename/검색 등 일반 입력 중에는 양보한다. 단, 터미널(xterm) 포커스 중에는 Operation 전환을 허용한다.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches("input, textarea, [contenteditable='true']") && !active.closest(".xterm")) return;
      const order = stateRef.current.operations
        .filter((operation) => operation.theaterId === stateRef.current.activeTheaterId)
        .sort(compareOperationCreatedAt)
        .map((operation) => operation.id);
      if (order.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const currentId = maximizedRef.current ?? stateRef.current.activeOperationId;
      const nextId = nextOperationId(order, currentId, event.key === "ArrowRight" ? 1 : -1);
      if (!nextId) return;
      if (maximizedRef.current) {
        setActiveOperation(nextId);
        setMaximizedOperationId(nextId);
        return;
      }
      focusOperation(nextId);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [maximizedOperationId]);

  useEffect(() => {
    for (const operationId of operationOrder) ensureDefaultGeometry(operationId);
    if (state.operationsHydrated) pruneOperations(operationOrder);
  }, [operationOrder, state.operationsHydrated]);

  // 검색 등에서 들어온 일회성 이동 요청을 처리한다. 위의 loadForTheater/ensureDefaultGeometry
  // effect가 먼저 선언되어 해당 Theater의 Operation이 로드·보장된 뒤 실행되므로 focusCanvasOperation이 안전하다.
  useEffect(() => {
    const operationId = state.pendingOperationFocus;
    if (operationId === null) return;
    clearMaximizedOperationId();
    const viewportSize = viewportSizeFor(bodyRef.current);
    if (viewportSize) focusCanvasOperation(operationId, viewportSize);
    consumeOperationFocus();
  }, [state.pendingOperationFocus]);

  return (
    <div
      className="console-body is-canvas"
      ref={bodyRef}
    >
      <OperationsCanvas state={state} />
      <RightRail theaterId={state.activeTheaterId} />
    </div>
  );
}

function sortedTheaterOperations(state: ConsoleState): readonly OperationNode[] {
  return state.operations
    .filter((operation) => operation.theaterId === state.activeTheaterId)
    .sort(compareOperationCreatedAt);
}

function compareOperationCreatedAt(left: OperationNode, right: OperationNode): number {
  return left.ts.createdAt - right.ts.createdAt || left.id.localeCompare(right.id);
}

function viewportSizeFor(element: HTMLElement | null): { readonly width: number; readonly height: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}
