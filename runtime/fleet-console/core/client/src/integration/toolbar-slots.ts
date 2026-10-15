import { useSyncExternalStore } from "react";

/**
 * 도구모음이 설 자리와, 도구모음 안에서 레일 도구 아이콘이 설 칸.
 *
 * 도구모음은 콘솔에 하나뿐이다(console-toolbar.tsx). 자리는 상단 바 오른쪽(`band`)이고,
 * 커맨드 밴드가 그 칸을 DOM에 두고 여기에 알린다. 도구모음은 자기 DOM 노드를 그대로 두므로 안의 항목
 * (플러그인이 둔 부관 글리프 등)은 다시 마운트되지 않는다.
 *
 * 레일 도구 아이콘은 도구를 여는 문맥(Theater·실행 손잡이)을 가진 Operations 페이지가 도구 칸으로
 * 포털한다. 칸은 도구모음이 늘 들고 있으므로 페이지가 내려가도 포털이 분리된 노드에 남지 않는다.
 */
type Listener = () => void;
export type ToolbarHostKind = "band";

const hosts: Record<ToolbarHostKind, HTMLElement | null> = { band: null };
const hostListeners = new Set<Listener>();

export function setToolbarHost(kind: ToolbarHostKind, element: HTMLElement | null): void {
  if (hosts[kind] === element) return;
  hosts[kind] = element;
  for (const listener of hostListeners) listener();
}

export const setBandToolbarHost = (element: HTMLElement | null): void => setToolbarHost("band", element);

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
