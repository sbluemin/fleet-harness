import { useSyncExternalStore } from "react";

import { collapseCodexReader, getState, subscribe as subscribeConsole } from "./store.js";

/**
 * 캔버스 면을 빌려 선 rail 기여가 지금 무엇인가.
 *
 * 면은 하나뿐이다 — 캔버스 열은 한 장이고, 두 장이 겹치면 위의 것이 아래의 것을 덮은 채
 * 아래가 여전히 키보드를 듣는 상태가 태어난다. 그래서 이 store는 목록이 아니라 값 하나를 든다.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let activePanelId: string | null = null;
// 면이 열릴 때마다 오르는 번호. 닫았다 다시 연 면은 같은 id를 쓰더라도 다른 면이다 —
// 늦게 도착한 옛 면의 콜백이 지금 서 있는 면을 접지 못하게 하는 손잡이다.
let openEpoch = 0;

export function useCanvasSurfacePanelId(): string | null {
  return useSyncExternalStore(subscribe, getCanvasSurfacePanelId, getCanvasSurfacePanelId);
}

export function getCanvasSurfacePanelId(): string | null {
  return activePanelId;
}

export function getCanvasSurfaceEpoch(): number {
  return openEpoch;
}

export function openCanvasSurface(panelId: string): void {
  // Codex 리딩 덱과 같은 면을 두고 다툰다. 먼저 접어야 둘이 겹친 채 양쪽 모두 살아 있는
  // 상태가 생기지 않는다 — 반대 방향(Codex가 열릴 때 이 면이 접히는 것)은 아래 구독이 맡는다.
  collapseCodexReader();
  setActivePanelId(panelId);
}

export function closeCanvasSurface(): void {
  setActivePanelId(null);
}

export function toggleCanvasSurface(panelId: string): void {
  if (activePanelId === panelId) closeCanvasSurface();
  else openCanvasSurface(panelId);
}

function setActivePanelId(next: string | null): void {
  if (activePanelId === next) return;
  if (next !== null) openEpoch += 1;
  activePanelId = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 역방향 배타: Codex가 확대되면 캔버스 면은 물러난다. store를 여기서 구독해 한 방향 의존만
// 남긴다 — store가 이 모듈을 부르면 두 모듈이 서로를 물어 import 순환이 된다.
let codexWasExpanded = getState().codexReaderExpanded;
subscribeConsole(() => {
  const expanded = getState().codexReaderExpanded;
  if (expanded && !codexWasExpanded) setActivePanelId(null);
  codexWasExpanded = expanded;
});
