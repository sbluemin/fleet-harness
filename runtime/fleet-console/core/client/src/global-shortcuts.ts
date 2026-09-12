import { isBlockingDialogOpen } from "./shortcuts.js";
import { isKeyboardShortcutsModalOpen } from "./components/keyboard-shortcuts-dialog.js";
import { isShortcutRecording, matchesShortcutCommand } from "./shortcut-bindings.js";

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
  readonly openOperationSearch: (seed?: string) => void;
  readonly closeOperationSearch: () => void;
  /** 열려 있으면 그 모드, 닫혀 있으면 null. */
  readonly getOperationSearchMode: () => "operations" | "commands" | null;
  readonly toggleQuickLaunch: () => void;
  readonly toggleRailChrome: () => void;
  readonly canUndoLastClose?: () => boolean;
  readonly undoLastClose?: () => void;
}

// 가운데 Quick Launch와 검색 팔레트는 스스로 aria-modal이다. 그 가드를 그대로 적용하면 토글이
// 열기만 하고 닫히지 않는다(⌘K가 팔레트를 못 닫던 실측). 자기 표면이 아닌 다른 차단
// 다이얼로그가 떠 있을 때만 막는다.
function isForeignBlockingDialogOpen(documentFor: Document, ownSelector: string): boolean {
  return [...documentFor.querySelectorAll('[aria-modal="true"]:not([hidden])')]
    .some((element) => element.closest(ownSelector) === null);
}

// This listener is intentionally installed on window: it owns Console-wide
// commands and checks the shared modal boundary before any command can run.
export function installConsoleGlobalShortcuts(dependencies: ConsoleGlobalShortcutDependencies, windowFor: Window = window): () => void {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (isKeyboardShortcutsModalOpen()) return;
    // 설정 카드가 조합을 기록하는 동안은 어떤 명령도 발화하지 않는다 — 기록기가 그 키를 받는다.
    if (isShortcutRecording(windowFor.document)) return;
    const matches = (commandId: string) => matchesShortcutCommand(event, commandId);
    // Quick Launch: 입력·터미널 포커스 가드를 두지 않는다 — Mod+K/Mod+P와 같은 정책으로,
    // 터미널을 보고 있다가 떠오른 지시를 그 자리에서 띄우는 것이 이 단축키의 목적이다.
    // 조합은 등록부가 정한다(기본 Mod+J 또는 Ctrl+Space). 수식키는 정확히 맞아야 하므로
    // Ctrl+Shift+Space나 IME/Spotlight 코드를 삼키지 않는다.
    // 토글은 자기 모달 가드보다 먼저 본다 — 가운데 컴포저가 aria-modal이라 닫힘이 막히면 안 된다.
    if (matches("console.quick-launch")) {
      if (isForeignBlockingDialogOpen(windowFor.document, ".quick-launch-overlay")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.toggleQuickLaunch();
      return;
    }
    // ⌘K / ⌘P — 같은 창의 두 문. 닫힌 창은 열고, 열린 창에서는 ⌘K가 「검색 탭으로, 이미 검색이면
    // 닫기」, ⌘P가 「명령 탭으로」다. 자기 모달 가드보다 먼저 봐야 닫힘·전환이 막히지 않는다.
    if (matches("console.search-operations")) {
      // Codex 확대 읽기가 캔버스를 덮고 있는 동안 ⌘K는 그 화면의 항목 전환기다.
      // 여기서 양보하지 않으면 세션 검색과 전환기가 같은 키에 함께 열린다.
      if (windowFor.document.body.dataset.codexReading === "true") return;
      if (isForeignBlockingDialogOpen(windowFor.document, ".operation-search-overlay")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const mode = dependencies.getOperationSearchMode();
      if (mode === null) dependencies.openOperationSearch();
      else if (mode === "operations") dependencies.closeOperationSearch();
      else dependencies.openOperationSearch("");
      return;
    }
    if (matches("console.command-palette")) {
      if (isForeignBlockingDialogOpen(windowFor.document, ".operation-search-overlay")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (dependencies.getOperationSearchMode() !== "commands") dependencies.openOperationSearch(">");
      return;
    }
    if (isBlockingDialogOpen(windowFor.document)) return;
    if (matches("console.undo-close") && dependencies.canUndoLastClose?.()) {
      const active = windowFor.document.activeElement;
      if (active instanceof HTMLElement && (active.matches("input, textarea, [contenteditable='true']") || active.closest(".xterm"))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.undoLastClose?.();
      return;
    }
    // Mod+Alt+B(rail): macOS는 ⌘⌥로 발화하며 ⌥B의 합성문자(∫)는 무시하고 code로 판정한다.
    // Win/Linux의 AltGr 오인은 등록부의 matchesChord가 event.key 교차 판정으로 거른다.
    if (matches("console.toggle-rail")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.toggleRailChrome();
      return;
    }
    if (matches("console.toggle-sidebar")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.setSideBarCollapsed(!dependencies.getSideBarCollapsed());
    }
  };
  windowFor.addEventListener("keydown", handleKeyDown, true);
  return () => windowFor.removeEventListener("keydown", handleKeyDown, true);
}
