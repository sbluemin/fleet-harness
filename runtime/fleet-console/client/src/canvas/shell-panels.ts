import { useSyncExternalStore } from "react";

import type { PanelGeometry } from "./canvas-store.js";

export interface ShellPanelEntry {
  // 이 셸이 띄워진 Theater id. 백엔드 ticket이 이 id로 cwd(Theater 디렉터리)를 해석한다(raw 경로는 클라이언트에 없음).
  readonly theaterId: string;
  readonly geometry: PanelGeometry;
}

type Listener = () => void;

const listeners = new Set<Listener>();
// 메모리 전용 레지스트리 — localStorage 직렬화·canvas-store 영속·prunePanels에 일절 관여하지 않는다.
// 새로고침하면 모듈이 새로 로드되며 비워지므로 "상태 미유지" 요구가 자연히 충족된다.
let panels: Record<string, ShellPanelEntry> = {};

export function useShellPanels(): Record<string, ShellPanelEntry> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getShellPanels(): Record<string, ShellPanelEntry> {
  return panels;
}

export function addShellPanel(theaterId: string, geometry: PanelGeometry): string {
  const id = newShellPanelId();
  panels = { ...panels, [id]: { theaterId, geometry } };
  emit();
  return id;
}

export function setShellPanelGeometry(id: string, geometry: PanelGeometry): void {
  const existing = panels[id];
  if (!existing) return;
  panels = { ...panels, [id]: { ...existing, geometry } };
  emit();
}

export function removeShellPanel(id: string): void {
  if (!(id in panels)) return;
  const next = { ...panels };
  delete next[id];
  panels = next;
  emit();
}

export function clearShellPanels(): void {
  if (Object.keys(panels).length === 0) return;
  panels = {};
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Record<string, ShellPanelEntry> {
  return panels;
}

function emit(): void {
  for (const listener of listeners) listener();
}

// 전역 고유 셸 패널 id. "shell:" prefix는 백엔드 theater-shell 판별을 위해 유지하되, 탭/새로고침 간
// 충돌을 막도록 무작위 성분을 붙인다 — 다른 브라우저 컨텍스트가 같은 sessionId로 서로의 PTY에
// 잘못 attach/대체되어 엉뚱한 Theater cwd를 물려받는 것을 방지한다.
function newShellPanelId(): string {
  const unique = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `shell:${unique}`;
}
