import { useSyncExternalStore } from "react";

// 전체화면 커맨드 밴드의 이분 선호: 자동 숨김(기본) / 계속 보이기.
// "계속 보이기"는 오버레이가 아니라 도킹이다 — 밴드가 흐름으로 돌아와 스테이지 위에 자리를
// 만들므로 콘텐츠를 덮지 않는다. 잠시 내려오는 reveal은 그대로 오버레이인데, 일시적인 표시는
// 덮어도 약속을 어기지 않기 때문이다.
const PREFS_DOCKED = "fleet-console.fullscreen-band.docked";

type Listener = () => void;

const listeners = new Set<Listener>();
let docked = readStoredDocked();

export function useCommandBandDocked(): boolean {
  return useSyncExternalStore(subscribe, getCommandBandDocked, getCommandBandDocked);
}

export function getCommandBandDocked(): boolean {
  return docked;
}

export function setCommandBandDocked(next: boolean): void {
  if (docked === next) return;
  docked = next;
  saveStoredDocked(next);
  for (const listener of listeners) listener();
}

export function toggleCommandBandDocked(): void {
  setCommandBandDocked(!docked);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 기본값은 자동 숨김이다 — 저장된 값이 없으면 전체화면은 지금처럼 즉시 밴드를 숨긴다.
function readStoredDocked(): boolean {
  try { return localStorage.getItem(PREFS_DOCKED) === "1"; } catch { return false; }
}

function saveStoredDocked(next: boolean): void {
  try { localStorage.setItem(PREFS_DOCKED, next ? "1" : "0"); } catch { /* ignore */ }
}
