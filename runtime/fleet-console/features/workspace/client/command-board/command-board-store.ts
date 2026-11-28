import { useSyncExternalStore } from "react";

import { getViewModeSnapshot } from "../../../../core/client/src/integration/view-mode-store.js";
import { setContextFlyout } from "../conversation/context-rail/store.js";
import { getConversationSurface, subscribeConversationSurface } from "../conversation/conversation-surface-store.js";
import { isCommandBoardEnabled, subscribeCommandBoardEnabled } from "./command-board-experiment.js";

/**
 * 지휘판(Command Board) 클라이언트 상태 — 좌측 사이드바 상단 고정 행과 ⌘B, 우측 컨텍스트 레일 딥링크가
 * 함께 여닫는다. 모든 사령관의 목표를 4열(시작 전 · 진행 중 · 검토 대기 · 완료)과 3종 보기(통합 · 사령관별 · 매트릭스)로
 * 보여 주며, 사령관·지휘관 대화로 옮겨 가면 자동으로 닫혀 대화가 가운데 칸에 선다.
 */

export type CommandBoardViewMode = "unified" | "commodore" | "matrix";

const VIEW_MODE_KEY = "fleet-console.commandBoard.viewMode";

function readSavedViewMode(): CommandBoardViewMode {
  try {
    const stored = typeof window === "undefined" ? null : window.localStorage.getItem(VIEW_MODE_KEY);
    return stored === "unified" || stored === "commodore" || stored === "matrix" ? stored : "unified";
  } catch {
    return "unified";
  }
}

function writeSavedViewMode(mode: CommandBoardViewMode): void {
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // 저장이 막혀도 이번 세션의 선택은 유지한다.
  }
}

export interface CommandBoardStoreState {
  readonly open: boolean;
  readonly viewMode: CommandBoardViewMode;
  readonly selectedCommodores: ReadonlySet<string>;
  readonly matrixFocusId: string | "ALL";
  readonly matrixRailCollapsed: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

let store: CommandBoardStoreState = {
  open: false,
  viewMode: readSavedViewMode(),
  selectedCommodores: EMPTY_SET,
  matrixFocusId: "ALL",
  matrixRailCollapsed: false,
};

const listeners = new Set<() => void>();
let lastSurfaceNonce = getConversationSurface()?.nonce ?? 0;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function update(patch: Partial<CommandBoardStoreState>): void {
  store = { ...store, ...patch };
  emit();
}

// 사령관·TF·시작 전 목표 등 플러그인 대화가 새로 열리면 지휘판을 닫아 대화가 바로 보이게 한다.
subscribeConversationSurface(() => {
  const current = getConversationSurface();
  const nextNonce = current?.nonce ?? 0;
  const openedNewSurface = current !== null && nextNonce !== lastSurfaceNonce;
  lastSurfaceNonce = nextNonce;
  if (openedNewSurface && store.open) {
    update({ open: false });
  }
});

// 실험이 꺼지면 열려 있던 보드도 닫는다 — 꺼진 기능의 화면이 가운데 칸에 남지 않게.
subscribeCommandBoardEnabled(() => {
  if (store.open && !isCommandBoardEnabled()) update({ open: false });
});

export function getCommandBoardState(): CommandBoardStoreState {
  return store;
}

export function subscribeCommandBoard(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCommandBoardState(): CommandBoardStoreState {
  return useSyncExternalStore(subscribeCommandBoard, getCommandBoardState, getCommandBoardState);
}

export function isCommandBoardOpen(): boolean {
  return store.open;
}

export function useCommandBoardOpen(): boolean {
  return useSyncExternalStore(subscribeCommandBoard, isCommandBoardOpen, () => false);
}

export function openCommandBoard(options?: { readonly commodoreId?: string }): boolean {
  if (getViewModeSnapshot().effective === "mobile" || !isCommandBoardEnabled()) return false;
  setContextFlyout(null);
  const commodoreId = options?.commodoreId;
  if (commodoreId) {
    if (store.viewMode === "matrix") {
      update({ open: true, matrixFocusId: commodoreId, selectedCommodores: EMPTY_SET });
    } else {
      update({ open: true, selectedCommodores: new Set([commodoreId]) });
    }
    return true;
  }
  if (!store.open) update({ open: true });
  return true;
}

export function closeCommandBoard(): void {
  if (!store.open) return;
  update({ open: false });
}

export function toggleCommandBoard(): boolean {
  if (getViewModeSnapshot().effective === "mobile") return false;
  if (!isCommandBoardEnabled()) {
    closeCommandBoard();
    return false;
  }
  if (store.open) {
    closeCommandBoard();
    return true;
  }
  return openCommandBoard();
}

export function setCommandBoardViewMode(viewMode: CommandBoardViewMode): void {
  if (store.viewMode === viewMode) return;
  writeSavedViewMode(viewMode);
  update({ viewMode });
}

export function toggleCommandBoardCommodoreFilter(commodoreId: string): void {
  const next = new Set(store.selectedCommodores);
  if (next.has(commodoreId)) next.delete(commodoreId);
  else next.add(commodoreId);
  update({ selectedCommodores: next });
}

export function clearCommandBoardCommodoreFilter(): void {
  if (store.selectedCommodores.size === 0) return;
  update({ selectedCommodores: EMPTY_SET });
}

export function setCommandBoardMatrixFocus(commodoreId: string | "ALL"): void {
  if (store.matrixFocusId === commodoreId) return;
  update({ matrixFocusId: commodoreId });
}

export function toggleCommandBoardMatrixRail(): void {
  update({ matrixRailCollapsed: !store.matrixRailCollapsed });
}

/** 테스트 격리용 초기화. */
export function __resetCommandBoardStoreForTests(): void {
  lastSurfaceNonce = getConversationSurface()?.nonce ?? 0;
  store = {
    open: false,
    viewMode: "unified",
    selectedCommodores: EMPTY_SET,
    matrixFocusId: "ALL",
    matrixRailCollapsed: false,
  };
  emit();
}
