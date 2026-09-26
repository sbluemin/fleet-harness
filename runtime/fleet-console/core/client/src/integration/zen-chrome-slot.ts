import { useSyncExternalStore } from "react";

/**
 * Zen이 밴드를 내렸을 때 상단 크롬 항목이 옮겨 갈 자리.
 *
 * Zen에서 서 있는 크롬은 상단 경계의 종료 손잡이 하나뿐이다. 밴드에 자리를 빌린 플러그인
 * 항목(부관 글리프 등)은 그 손잡이 옆으로 옮겨 가 계속 근무한다 — 닿을 수 없는 곳에 숨기지
 * 않는다는 원칙과, 크롬 조각은 하나라는 Zen 문법을 함께 지키는 자리다.
 *
 * 밴드는 항목을 **언마운트하지 않고** 이 자리로 포털한다. 언마운트하면 플러그인은 슬롯이
 * 사라진 것으로 보고 자기 표면을 캔버스로 되돌리는데(부관은 새로 돌아간다), 그것이 바로
 * Zen이 치우려던 것이다.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let slot: HTMLElement | null = null;

export function setZenChromeSlot(element: HTMLElement | null): void {
  if (slot === element) return;
  slot = element;
  for (const listener of listeners) listener();
}

export function getZenChromeSlot(): HTMLElement | null {
  return slot;
}

export function useZenChromeSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, getZenChromeSlot, () => null);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Zen 탭의 도구 칸 — 레일 도구 아이콘이 가로로 서는 자리.
 *
 * 탭은 콘솔 크롬(App)이 세우지만, 도구를 여는 문맥(Theater·실행 손잡이)은 Operations 페이지가
 * 가진다. 그래서 칸은 App이 늘 DOM에 두고, 아이콘은 Operations가 이 칸으로 포털한다 — 페이지가
 * 내려가도 컨테이너는 남으므로 포털이 분리된 노드에 남지 않는다(위 슬롯과 같은 계약).
 */
const toolsListeners = new Set<Listener>();
let toolsSlot: HTMLElement | null = null;

export function setZenToolsSlot(element: HTMLElement | null): void {
  if (toolsSlot === element) return;
  toolsSlot = element;
  for (const listener of toolsListeners) listener();
}

export function useZenToolsSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      toolsListeners.add(listener);
      return () => { toolsListeners.delete(listener); };
    },
    () => toolsSlot,
    () => null,
  );
}
