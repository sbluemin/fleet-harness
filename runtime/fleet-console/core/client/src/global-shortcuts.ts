import { isBlockingDialogOpen } from "./shortcuts.js";
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

function isSpaceKey(event: KeyboardEvent): boolean {
  return event.code === "Space" || event.key === " ";
}

function isQuickLaunchToggleShortcut(event: KeyboardEvent): boolean {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "j") return true;
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && isSpaceKey(event);
}

// 가운데 Quick Launch는 스스로 aria-modal이다. 그 가드를 그대로 적용하면 토글이 열기만 하고
// 닫히지 않는다. 다른 차단 다이얼로그가 떠 있을 때만 막는다.
function isForeignBlockingDialogOpen(documentFor: Document): boolean {
  return [...documentFor.querySelectorAll('[aria-modal="true"]:not([hidden])')]
    .some((element) => element.closest(".quick-launch-overlay") === null);
}

// This listener is intentionally installed on window: it owns Console-wide
// commands and checks the shared modal boundary before any command can run.
export function installConsoleGlobalShortcuts(dependencies: ConsoleGlobalShortcutDependencies, windowFor: Window = window): () => void {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (isKeyboardShortcutsModalOpen()) return;
    // Quick Launch: 입력·터미널 포커스 가드를 두지 않는다 — Mod+K/Mod+P와 같은 정책으로,
    // 터미널을 보고 있다가 떠오른 지시를 그 자리에서 띄우는 것이 이 단축키의 목적이다.
    // Mod+J는 Alt만 거르고 Shift는 허용한다(Mod+P와 동일한 술어 폭).
    // Ctrl+Space는 모든 OS에서 Control+Space다(macOS의 Command+Space/Spotlight가 아니다).
    // Shift·Alt·Meta는 거른다 — Ctrl+Shift+Space와 IME/Spotlight 코드를 삼키지 않는다.
    // 토글은 자기 모달 가드보다 먼저 본다 — 가운데 컴포저가 aria-modal이라 닫힘이 막히면 안 된다.
    if (isQuickLaunchToggleShortcut(event)) {
      if (isForeignBlockingDialogOpen(windowFor.document)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.toggleQuickLaunch();
      return;
    }
    if (isBlockingDialogOpen(windowFor.document)) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z" && dependencies.canUndoLastClose?.()) {
      const active = windowFor.document.activeElement;
      if (active instanceof HTMLElement && (active.matches("input, textarea, [contenteditable='true']") || active.closest(".xterm"))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.undoLastClose?.();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      // Codex 확대 읽기가 캔버스를 덮고 있는 동안 ⌘K는 그 화면의 항목 전환기다.
      // 여기서 양보하지 않으면 세션 검색과 전환기가 같은 키에 함께 열린다.
      if (windowFor.document.body.dataset.codexReading === "true") return;
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
