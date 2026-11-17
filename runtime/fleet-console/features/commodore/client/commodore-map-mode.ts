import { useSyncExternalStore } from "react";

/**
 * 사령관 대화의 채팅·지도 전환과 지도 선택 — 사령관(UUID)마다 하나, 기본은 채팅이다.
 * 다른 사령관으로 옮기면 그 사령관의 값(없으면 채팅·선택 없음)으로 시작한다.
 * 레일 열림 상태는 건드리지 않는다. 가운데 칸 본문과 오른쪽 레일 패널이 함께 읽는다.
 */

export type CommodoreMapMode = "chat" | "map";

interface CommodoreMapUi {
  readonly mode: CommodoreMapMode;
  readonly selectedId: string | null;
}

const ui = new Map<string, CommodoreMapUi>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function read(commodoreId: string | null | undefined): CommodoreMapUi {
  if (!commodoreId) return { mode: "chat", selectedId: null };
  return ui.get(commodoreId) ?? { mode: "chat", selectedId: null };
}

function write(commodoreId: string, next: CommodoreMapUi): void {
  const current = ui.get(commodoreId);
  if (current?.mode === next.mode && current?.selectedId === next.selectedId) return;
  ui.set(commodoreId, next);
  notify();
}

export function readCommodoreMapMode(commodoreId: string | null | undefined): CommodoreMapMode {
  return read(commodoreId).mode;
}

export function readCommodoreMapSelection(commodoreId: string | null | undefined): string | null {
  return read(commodoreId).selectedId;
}

export function setCommodoreMapMode(commodoreId: string, mode: CommodoreMapMode): void {
  write(commodoreId, { mode, selectedId: read(commodoreId).selectedId });
}

export function setCommodoreMapSelection(commodoreId: string, selectedId: string | null): void {
  write(commodoreId, { mode: read(commodoreId).mode, selectedId });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export { subscribe as subscribeCommodoreMapMode };

export function useCommodoreMapMode(commodoreId: string | null | undefined): CommodoreMapMode {
  return useSyncExternalStore(subscribe, () => read(commodoreId).mode, () => "chat");
}

export function useCommodoreMapSelection(commodoreId: string | null | undefined): string | null {
  return useSyncExternalStore(subscribe, () => read(commodoreId).selectedId, () => null);
}
