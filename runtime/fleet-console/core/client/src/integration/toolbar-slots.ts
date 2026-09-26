import { useSyncExternalStore } from "react";

/**
 * 도구모음이 설 자리와, 도구모음 안에서 레일 도구 아이콘이 설 칸.
 *
 * 도구모음은 콘솔에 하나뿐이다(console-toolbar.tsx). 모드는 그 하나가 **어디에 서는가**만 바꾼다 —
 * 평소에는 상단 바 오른쪽(`band`), Zen에서는 작업 표시줄 오른쪽 끝 트레이(`zen`). 두 자리는 각자의
 * 크롬이 늘 DOM에 두고 여기에 알린다. 도구모음은 자기 DOM 노드를 그대로 들고 옮겨 가므로 안의 항목
 * (플러그인이 둔 부관 글리프 등)은 모드가 바뀌어도 다시 마운트되지 않는다.
 *
 * 레일 도구 아이콘은 도구를 여는 문맥(Theater·실행 손잡이)을 가진 Operations 페이지가 도구 칸으로
 * 포털한다. 칸은 도구모음이 늘 들고 있으므로 페이지가 내려가도 포털이 분리된 노드에 남지 않는다.
 */
type Listener = () => void;
export type ToolbarHostKind = "band" | "zen";

const hosts: Record<ToolbarHostKind, HTMLElement | null> = { band: null, zen: null };
const hostListeners = new Set<Listener>();

export function setToolbarHost(kind: ToolbarHostKind, element: HTMLElement | null): void {
  if (hosts[kind] === element) return;
  hosts[kind] = element;
  for (const listener of hostListeners) listener();
}

export const setBandToolbarHost = (element: HTMLElement | null): void => setToolbarHost("band", element);
export const setZenToolbarHost = (element: HTMLElement | null): void => setToolbarHost("zen", element);

export function useToolbarHost(kind: ToolbarHostKind): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      hostListeners.add(listener);
      return () => { hostListeners.delete(listener); };
    },
    () => hosts[kind],
    () => null,
  );
}

const toolsListeners = new Set<Listener>();
let toolsSlot: HTMLElement | null = null;

export function setToolbarToolsSlot(element: HTMLElement | null): void {
  if (toolsSlot === element) return;
  toolsSlot = element;
  for (const listener of toolsListeners) listener();
}

export function useToolbarToolsSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (listener) => {
      toolsListeners.add(listener);
      return () => { toolsListeners.delete(listener); };
    },
    () => toolsSlot,
    () => null,
  );
}
