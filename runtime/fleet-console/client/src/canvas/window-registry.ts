import { useSyncExternalStore } from "react";

import { terminateTerminalSession } from "../api.js";
import { failTerminateTerminalSession, removeTerminalSession, selectTerminalSession } from "../store.js";
import { animateViewportTo, claimTopZIndex, focusPanel, getSnapshot, minimizePanel, restorePanel, type CanvasViewport, type CanvasViewportSize } from "./canvas-store.js";
import { getActiveShellId, getMinimizedShellPanelIds, getShellPanels, minimizeShellPanel, removeShellPanel, restoreShellPanel, setActiveShellPanel, setShellPanelGeometry } from "./shell-panels.js";

export type WindowPanelKind = "operation" | "shell";

export interface WindowPanelHandle {
  readonly kind: WindowPanelKind;
  readonly id: string;
  readonly createdAt: number;
}

export interface WindowRegistryReadiness {
  readonly operationSessionsHydrated: boolean;
  readonly shellPanelsHydrated: boolean;
  readonly theaterReady: boolean;
}

type Listener = () => void;

const listeners = new Set<Listener>();
const PANEL_FOCUS_PADDING = 96;
const FOCUS_MIN_ZOOM = 0.25;
const FOCUS_MAX_ZOOM = 1;

let maximizedPanelId: string | null = null;

export function useMaximizedPanelId(): string | null {
  return useSyncExternalStore(subscribe, getMaximizedPanelId, getMaximizedPanelId);
}

export function getMaximizedPanelId(): string | null {
  return maximizedPanelId;
}

export function setMaximizedPanelId(id: string): void {
  if (maximizedPanelId === id) return;
  maximizedPanelId = id;
  emit();
}

export function clearMaximizedPanelId(): void {
  if (maximizedPanelId === null) return;
  maximizedPanelId = null;
  emit();
}

export function operationPanelHandle(id: string): WindowPanelHandle {
  return { kind: "operation", id, createdAt: 0 };
}

export function shellPanelHandle(id: string): WindowPanelHandle {
  return { kind: "shell", id, createdAt: 0 };
}

export function getPanelHandles(operationSessionIds: readonly string[]): readonly WindowPanelHandle[] {
  const canvas = getSnapshot();
  const operationHandles = operationSessionIds
    .filter((id) => canvas.panels[id])
    .map((id) => ({ kind: "operation" as const, id, createdAt: canvas.panelCreatedAt[id] ?? 0 }));
  const shellHandles = Object.entries(getShellPanels())
    .map(([id, entry]) => ({ kind: "shell" as const, id, createdAt: entry.createdAt }));
  return [...operationHandles, ...shellHandles].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function getMinimizedPanelHandles(operationSessionIds: readonly string[]): readonly WindowPanelHandle[] {
  const canvas = getSnapshot();
  const validOperationIds = new Set(operationSessionIds);
  const operationHandles = canvas.minimized
    .filter((id) => validOperationIds.has(id) && canvas.panels[id])
    .map((id) => ({ kind: "operation" as const, id, createdAt: canvas.panelCreatedAt[id] ?? 0 }));
  const shellPanels = getShellPanels();
  const shellHandles: WindowPanelHandle[] = [];
  for (const id of getMinimizedShellPanelIds()) {
    const panel = shellPanels[id];
    if (panel) shellHandles.push({ kind: "shell", id, createdAt: panel.createdAt });
  }
  return [...operationHandles, ...shellHandles].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function nextPanelHandle(handles: readonly WindowPanelHandle[], currentId: string | null, delta: number): WindowPanelHandle | null {
  if (handles.length === 0) return null;
  const currentIndex = Math.max(0, handles.findIndex((handle) => handle.id === currentId));
  return handles[(currentIndex + delta + handles.length) % handles.length] ?? null;
}

export function focusWindowPanel(handle: WindowPanelHandle, viewportSize: CanvasViewportSize): void {
  if (handle.kind === "operation") {
    selectTerminalSession(handle.id);
    focusPanel(handle.id, viewportSize);
    return;
  }
  const panel = getShellPanels()[handle.id];
  if (!panel) return;
  restoreShellPanel(handle.id);
  selectTerminalSession(null);
  setActiveShellPanel(handle.id);
  const zIndex = claimTopZIndex();
  setShellPanelGeometry(handle.id, { ...panel.geometry, zIndex });
  animateViewportTo(focusedViewportFor(panel.geometry, viewportSize));
}

export function minimizeWindowPanel(handle: WindowPanelHandle): void {
  // 최대화된 패널을 최소화하면 최대화 상태도 함께 해제한다 — 안 그러면 오버레이가 그 패널을 계속 렌더해
  // Dock 칩과 오버레이에 동시에 떠 있는 유령 상태가 된다.
  if (maximizedPanelId === handle.id) clearMaximizedPanelId();
  if (handle.kind === "operation") {
    minimizePanel(handle.id);
    return;
  }
  minimizeShellPanel(handle.id);
}

export function restoreWindowPanel(handle: WindowPanelHandle): void {
  if (handle.kind === "operation") {
    restorePanel(handle.id);
    selectTerminalSession(handle.id);
    return;
  }
  restoreShellPanel(handle.id);
  selectTerminalSession(null);
  setActiveShellPanel(handle.id);
}

// 패널 최대화 진입·전환의 단일 경로. 대상을 제외한 모든 핸들을 Dock으로 최소화하고(이전 최대화 패널도
// minimizeWindowPanel의 clear 경유로 함께 내려감), 대상은 복원해 오버레이로 띄운다. restoreWindowPanel이
// 종류별 활성(is-active) 상태까지 동기화하므로 별도 활성 처리가 필요 없다. viewport는 건드리지 않는다 —
// 최대화 상태 Alt 순환이 "전환만, 카메라 고정"이 되도록.
export function maximizeWindowPanel(target: WindowPanelHandle, allHandles: readonly WindowPanelHandle[]): void {
  for (const handle of allHandles) {
    if (handle.id !== target.id) minimizeWindowPanel(handle);
  }
  restoreWindowPanel(target);
  setMaximizedPanelId(target.id);
}

export function closeWindowPanel(handle: WindowPanelHandle): void {
  if (handle.kind === "operation") {
    void terminateTerminalSession(handle.id)
      .then(() => removeTerminalSession(handle.id))
      .catch((error) => failTerminateTerminalSession(error instanceof Error ? error.message : String(error)));
    if (maximizedPanelId === handle.id) clearMaximizedPanelId();
    return;
  }
  removeShellPanel(handle.id);
  void terminateTerminalSession(handle.id).catch((error) => {
    failTerminateTerminalSession(error instanceof Error ? error.message : String(error));
  });
  if (maximizedPanelId === handle.id) clearMaximizedPanelId();
}

export function pruneDanglingMaximizedPanelId(
  operationSessionIds: readonly string[],
  readiness: WindowRegistryReadiness,
): boolean {
  if (!readiness.operationSessionsHydrated || !readiness.shellPanelsHydrated || !readiness.theaterReady) return false;
  if (maximizedPanelId === null) return false;
  if (getPanelHandles(operationSessionIds).some((handle) => handle.id === maximizedPanelId)) return false;
  clearMaximizedPanelId();
  return true;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

function focusedViewportFor(geometry: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, viewportSize: CanvasViewportSize): CanvasViewport {
  const zoom = Math.max(FOCUS_MIN_ZOOM, Math.min(FOCUS_MAX_ZOOM, Math.min(
    (viewportSize.width - PANEL_FOCUS_PADDING) / geometry.width,
    (viewportSize.height - PANEL_FOCUS_PADDING) / geometry.height,
  )));
  return {
    x: viewportSize.width / 2 - (geometry.x + geometry.width / 2) * zoom,
    y: viewportSize.height / 2 - (geometry.y + geometry.height / 2) * zoom,
    zoom,
  };
}
