// 모두 정렬 진입 확인 — 실제 정렬 아레나에서 가장 작은 칸 본문이 하한(280×200)보다 작아지면
// 바로 정렬하지 않고 남길 패널을 고르게 한다. 진입점(Alt+F·모드 캡슐·⌘K·모두 열어 정렬)은 모두
// requestAlignAll 하나를 부른다. 패널 순서·제목은 렌더가 쥔 사이드바 순서에서 오므로 Operations가
// 제공자를 등록한다. 정렬 중에 창이 줄거나 패널이 늘어 넘치는 경우는 묻지 않는다 — 다음 진입 때 확인한다.
import { useSyncExternalStore } from "react";

import { getSideBarState, setSideBarCollapsed } from "../sidebar/operations-side-bar-store.js";
import {
  getAlignAll,
  getAlignLayout,
  getCanvasArenaInsets,
  getCanvasSnapArenaRect,
  minimizeOperations,
  toggleAlignAll,
  type AlignAllLayout,
} from "./canvas-store.js";
import { alignCapacity, alignExceedsMinBody, alignSmallestBody, type SnapRect } from "./snap-layouts.js";

export interface AlignAdmissionPanel {
  readonly id: string;
  readonly title: string;
}

export interface AlignAdmissionContext {
  /** 사이드바 순서의 보이는(최소화되지 않은) 패널. */
  readonly panels: readonly AlignAdmissionPanel[];
  readonly focusedId: string | null;
}

export interface AlignFitRequest {
  readonly panels: readonly AlignAdmissionPanel[];
  /** 기본으로 고른 패널 — 포커스 패널을 먼저, 그다음 정렬 순서. */
  readonly defaultKeptIds: readonly string[];
  readonly capacity: number;
  /** 사이드바를 접으면 늘어나는 수용 개수 — 접을 수 없거나 늘지 않으면 null. */
  readonly collapsedCapacity: number | null;
  readonly smallest: { readonly width: number; readonly height: number };
  readonly returnFocus: HTMLElement | null;
}

type Listener = () => void;

let provider: (() => AlignAdmissionContext) | null = null;
let request: AlignFitRequest | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Operations가 사이드바 순서의 보이는 패널을 돌려주는 제공자를 등록한다. 해제 함수를 돌려준다. */
export function registerAlignAdmissionProvider(next: () => AlignAdmissionContext): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
    cancelAlignFit();
  };
}

export function useAlignFitRequest(): AlignFitRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => request,
    () => null,
  );
}

function priorityIds(panels: readonly AlignAdmissionPanel[], focusedId: string | null): string[] {
  const ids = panels.map((panel) => panel.id);
  return focusedId !== null && ids.includes(focusedId) ? [focusedId, ...ids.filter((id) => id !== focusedId)] : ids;
}

// 사이드바를 접은 뒤의 정렬 아레나 — 왼쪽 인셋(모드 프레임이 14px 되무는 만큼)이 폭에 더해진다.
function collapsedArena(arena: SnapRect): SnapRect | null {
  if (getSideBarState().collapsed) return null;
  const pulled = Math.max(0, getCanvasArenaInsets().left - 14);
  return pulled > 0 ? { ...arena, width: arena.width + pulled } : null;
}

function currentFocus(): HTMLElement | null {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * 모두 정렬 진입점 — 켜져 있으면 끄고, 꺼져 있으면 하한을 보고 바로 켜거나 확인을 연다.
 * 제공자·아레나를 모르면(캔버스 미마운트) 기존처럼 바로 토글한다.
 */
export function requestAlignAll(returnFocus: HTMLElement | null = currentFocus()): void {
  if (getAlignAll() || request) {
    if (getAlignAll()) toggleAlignAll();
    return;
  }
  const arena = getCanvasSnapArenaRect();
  const context = provider?.();
  if (!arena || !context || context.panels.length === 0) {
    toggleAlignAll();
    return;
  }
  const layout: AlignAllLayout = getAlignLayout();
  const count = context.panels.length;
  if (!alignExceedsMinBody(count, layout, arena)) {
    toggleAlignAll();
    return;
  }
  const capacity = alignCapacity(layout, arena, count);
  const wider = collapsedArena(arena);
  const widerCapacity = wider ? alignCapacity(layout, wider, count) : null;
  request = {
    panels: context.panels,
    defaultKeptIds: priorityIds(context.panels, context.focusedId).slice(0, capacity),
    capacity,
    collapsedCapacity: widerCapacity !== null && widerCapacity > capacity ? widerCapacity : null,
    smallest: alignSmallestBody(count, layout, arena) ?? { width: 0, height: 0 },
    returnFocus,
  };
  emit();
}

export function cancelAlignFit(): void {
  const target = request?.returnFocus;
  if (!request) return;
  request = null;
  emit();
  if (target?.isConnected) target.focus({ preventScroll: true });
}

function closeRequest(): AlignFitRequest | null {
  const current = request;
  request = null;
  emit();
  return current;
}

/** 고른 패널만 남기고 나머지를 최소화한 뒤 정렬한다. 세션은 종료·보관하지 않는다. */
export function confirmAlignFit(keptIds: readonly string[]): void {
  const current = closeRequest();
  if (!current) return;
  const kept = new Set(keptIds);
  minimizeOperations(current.panels.map((panel) => panel.id).filter((id) => !kept.has(id)));
  if (!getAlignAll()) toggleAlignAll();
  // 대화상자가 걷히며 잃은 포커스를 돌려준다 — 기존 Alt+F는 포커스를 빼앗지 않았다. 최소화한 패널의
  // 터미널은 다음 렌더에서 사라지므로 한 프레임 뒤에 아직 붙어 있는 요소만 되돌린다.
  const target = current.returnFocus;
  if (target) requestAnimationFrame(() => { if (target.isConnected) target.focus({ preventScroll: true }); });
}

/** 사이드바를 접고, 늘어난 수용 개수만큼 기본 우선순위로 남겨 정렬한다. */
export function confirmAlignFitCollapsed(): void {
  const current = request;
  if (!current || current.collapsedCapacity === null) return;
  const context = provider?.();
  const keptIds = priorityIds(current.panels, context?.focusedId ?? null).slice(0, current.collapsedCapacity);
  setSideBarCollapsed(true);
  confirmAlignFit(keptIds);
}
