import { isBlockingDialogOpen } from "./focus-guards.js";
import { isKeyboardShortcutsModalOpen } from "./components/keyboard-shortcuts-dialog.js";

export type PanelShortcutOutcome = "suppress" | "reveal" | "apply";

// 사이드바와 Activity Rail은 데스크톱 /operations에만 마운트된다. 표면이 없는 곳에서 토글을 그대로
// 적용하면 아무 변화 없이 영속 상태만 바뀌고, 나중에 그 표면으로 돌아갔을 때 누른 적 없는 접힘이
// 나타난다(2026-08 실측). 모바일 셸에는 두 표면이 아예 없으므로 발화를 막고(suppress),
// 라우트만 다르면 그 표면으로 돌아가 펼친다(reveal).
export function resolvePanelShortcutOutcome(surfaces: {
  readonly panelSurfacesReachable: boolean;
  readonly operationsViewVisible: boolean;
}): PanelShortcutOutcome {
  if (!surfaces.panelSurfacesReachable) return "suppress";
  return surfaces.operationsViewVisible ? "apply" : "reveal";
}

export interface ConsoleGlobalShortcutDependencies {
  readonly getSideBarCollapsed: () => boolean;
  readonly setSideBarCollapsed: (collapsed: boolean) => void;
  readonly openOperationSearch: () => void;
  readonly toggleOperationSearch: () => void;
  readonly toggleQuickLaunch: () => void;
  readonly toggleRailChrome: () => void;
  readonly canUndoLastClose?: () => boolean;
  readonly undoLastClose?: () => void;
}

// This listener is intentionally installed on window: it owns Console-wide
// commands and checks the shared modal boundary before any command can run.
export function installConsoleGlobalShortcuts(dependencies: ConsoleGlobalShortcutDependencies, windowFor: Window = window): () => void {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (isKeyboardShortcutsModalOpen() || isBlockingDialogOpen(windowFor.document)) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z" && dependencies.canUndoLastClose?.()) {
      const active = windowFor.document.activeElement;
      if (active instanceof HTMLElement && (active.matches("input, textarea, [contenteditable='true']") || active.closest(".xterm"))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.undoLastClose?.();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.toggleOperationSearch();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.openOperationSearch();
      return;
    }
    // Mod+J(Quick Launch): 입력·터미널 포커스 가드를 두지 않는다 — Mod+K/Mod+P와 같은 정책으로,
    // 터미널을 보고 있다가 떠오른 지시를 그 자리에서 띄우는 것이 이 단축키의 목적이다.
    // Alt는 거르고 Shift는 허용한다(Mod+P와 동일한 술어 폭).
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "j") {
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.toggleQuickLaunch();
      return;
    }
    // Mod+Alt+B(rail): macOS는 ⌘(+⌥)로 발화하며 ⌥B의 합성문자(∫)는 무시하고 code로 판정한다.
    // Win/Linux의 Ctrl+Alt는 일부 레이아웃에서 AltGr(문자 입력)와 동일하게 보고되고, Firefox/Windows는
    // 진성 Ctrl+Alt에도 AltGraph=true를 주므로(신뢰 불가) AltGraph 대신 "이 키가 실제로 문자 b를
    // 냈는가"(event.key)로 판정한다: meta면 발화, 아니면 key가 'b'일 때만 발화(AltGr `{` 등은 미삼킴).
    if ((event.metaKey || event.ctrlKey) && event.code === "KeyB" && event.altKey && !event.shiftKey && (event.metaKey || event.key.toLowerCase() === "b")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.toggleRailChrome();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.code === "KeyB" && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.setSideBarCollapsed(!dependencies.getSideBarCollapsed());
    }
  };
  windowFor.addEventListener("keydown", handleKeyDown, true);
  return () => windowFor.removeEventListener("keydown", handleKeyDown, true);
}
