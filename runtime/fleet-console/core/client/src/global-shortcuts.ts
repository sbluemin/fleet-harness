import { isBlockingDialogOpen } from "./blocking-dialog.js";
import { isKeyboardShortcutsModalOpen } from "./components/keyboard-shortcuts-dialog.js";

export interface ConsoleGlobalShortcutDependencies {
  readonly getSideBarCollapsed: () => boolean;
  readonly setSideBarCollapsed: (collapsed: boolean) => void;
  readonly openOperationSearch: () => void;
  readonly toggleOperationSearch: () => void;
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
