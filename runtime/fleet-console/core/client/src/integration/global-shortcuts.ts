import { isBlockingDialogOpen } from "./shortcuts.js";
import { isKeyboardShortcutsModalOpen } from "../chrome/components/keyboard-shortcuts-dialog.js";
import { CORE_SHORTCUT_COMMANDS, isShortcutRecording, matchesShortcutCommand } from "./shortcut-bindings.js";

export type PanelShortcutOutcome = "suppress" | "reveal" | "apply";

// 사이드바와 Activity Rail은 데스크톱 /objectives에만 마운트된다. 표면이 없는 곳에서 토글을 그대로
// 적용하면 아무 변화 없이 영속 상태만 바뀌고, 나중에 그 표면으로 돌아갔을 때 누른 적 없는 접힘이
// 나타난다(2026-08 실측). 모바일 셸에는 두 표면이 아예 없으므로 발화를 막고(suppress),
// 라우트만 다르면 그 표면으로 돌아가 펼친다(reveal).
export function resolvePanelShortcutOutcome(surfaces: {
  readonly panelSurfacesReachable: boolean;
  readonly objectiveRecordsViewVisible: boolean;
}): PanelShortcutOutcome {
  if (!surfaces.panelSurfacesReachable) return "suppress";
  return surfaces.objectiveRecordsViewVisible ? "apply" : "reveal";
}

export interface ConsoleGlobalShortcutDependencies {
  readonly openObjectiveSearch: (seed?: string) => void;
  readonly closeObjectiveSearch: () => void;
  /** 열려 있으면 그 모드, 닫혀 있으면 null. */
  readonly getObjectiveSearchMode: () => "objectiveRecords" | "commands" | null;
  readonly openTaskforce?: () => boolean;
  /** 지휘판(Command Board)을 여닫는다. 모바일에서는 false. */
  readonly toggleCommandBoard?: () => boolean;
  /** 독립 CLI 패널·팔레트를 여닫는다. 그릴 자리가 없는 문서(모바일)에서는 false — 키를 소비하지 않는다. */
  readonly toggleStandaloneCli?: () => boolean;
  /** 독립 CLI 선택 팔레트를 바로 여닫는다(열린 CLI 안에서 다른 CLI로 전환). 모바일에서는 false. */
  readonly switchStandaloneCli?: () => boolean;
  readonly toggleRailSurface: (entryId: string) => boolean;
  readonly canUndoLastClose?: () => boolean;
  readonly undoLastClose?: () => void;
}

// 검색 팔레트는 스스로 aria-modal이다. 그 가드를 그대로 적용하면 토글이
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
    // ⌘K / ⌘P — 한 팔레트를 여닫는 두 문. 모드는 열림 표시로만 남고, 두 단축키 모두
    // 같은 한 목록을 토글한다. 자기 모달 가드보다 먼저 봐야 닫힘이 막히지 않는다.
    if (matches("console.search-objectiveRecords") || matches("console.command-palette")) {
      // 여기서 양보하지 않으면 세션 검색과 전환기가 같은 키에 함께 열린다.
      if (isForeignBlockingDialogOpen(windowFor.document, ".objective-search-overlay")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (dependencies.getObjectiveSearchMode() !== null) dependencies.closeObjectiveSearch();
      else dependencies.openObjectiveSearch();
      return;
    }
    // 독립 CLI: 터미널 포커스 가드를 두지 않고, 자기 팔레트 모달 위에서도 같은 키로 닫히게 자기 모달 가드보다 먼저 본다.
    if (matches("console.standalone-cli-switch")) {
      if (isForeignBlockingDialogOpen(windowFor.document, ".standalone-cli-palette-overlay")) return;
      if (event.repeat || dependencies.switchStandaloneCli?.()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (matches("console.standalone-cli")) {
      if (isForeignBlockingDialogOpen(windowFor.document, ".standalone-cli-palette-overlay")) return;
      if (event.repeat || dependencies.toggleStandaloneCli?.()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (isBlockingDialogOpen(windowFor.document)) return;
    if (matches("console.command-board")) {
      if (event.repeat || dependencies.toggleCommandBoard?.()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (matches("console.new-taskforce")) {
      if (event.repeat || dependencies.openTaskforce?.()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    const surfaceCommand = CORE_SHORTCUT_COMMANDS.find((command) => command.railEntryId !== undefined && matches(command.id));
    if (surfaceCommand?.railEntryId !== undefined) {
      // 길게 눌러도 한 번만 토글한다. 반복 이벤트는 터미널 입력으로 새지 않게 소비한다.
      if (event.repeat || dependencies.toggleRailSurface(surfaceCommand.railEntryId)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (matches("console.undo-close") && dependencies.canUndoLastClose?.()) {
      const active = windowFor.document.activeElement;
      if (active instanceof HTMLElement && (active.matches("input, textarea, [contenteditable='true']") || active.closest(".xterm"))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dependencies.undoLastClose?.();
      return;
    }
  };
  windowFor.addEventListener("keydown", handleKeyDown, true);
  return () => windowFor.removeEventListener("keydown", handleKeyDown, true);
}
