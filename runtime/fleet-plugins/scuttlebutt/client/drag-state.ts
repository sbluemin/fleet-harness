import type { Point } from "./geometry.js";

export type DragState =
  | { readonly phase: "idle"; readonly suppressClick: boolean }
  | {
    readonly phase: "pending" | "dragging";
    readonly start: Point;
    readonly origin: Point;
    readonly suppressClick: boolean;
  };

export const initialDragState: DragState = { phase: "idle", suppressClick: false };

export type DragAction =
  | { readonly type: "down"; readonly pointer: Point; readonly origin: Point }
  | { readonly type: "move"; readonly pointer: Point }
  | { readonly type: "up" }
  | { readonly type: "click" };

export interface DragResult {
  readonly state: DragState;
  readonly position?: Point;
}

export function updateDrag(state: DragState, action: DragAction): DragResult {
  if (action.type === "down") {
    return { state: { phase: "pending", start: action.pointer, origin: action.origin, suppressClick: false } };
  }
  if (action.type === "move" && state.phase !== "idle") {
    const dx = action.pointer.left - state.start.left;
    const dy = action.pointer.top - state.start.top;
    if (state.phase === "pending" && Math.abs(dx) + Math.abs(dy) < 5) return { state };
    return {
      state: { ...state, phase: "dragging", suppressClick: true },
      position: { left: state.origin.left + dx, top: state.origin.top + dy },
    };
  }
  if (action.type === "up") {
    return { state: { phase: "idle", suppressClick: state.phase === "dragging" || state.suppressClick } };
  }
  if (action.type === "click") {
    return { state: { phase: "idle", suppressClick: false } };
  }
  return { state };
}
