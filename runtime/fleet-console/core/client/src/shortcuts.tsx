// Console keyboard-shortcut policy: the catalog the dialog renders, which companion
// panels a surface can reach, and the guards every global key handler consults first.
// Installation of the window-level listeners stays in global-shortcuts.ts, which reads
// the dialog module — folding it in here would make the two files import each other.

import { createContext, useContext, type ReactNode } from "react";
import type { CompanionPanelDescriptor } from "@fleet-console/sdk/plugin";
import type { CoreMessageKey } from "./i18n/index.js";
import type { OperationNode } from "@fleet-console/sdk/operations";
import type { Translate } from "@fleet-console/sdk/i18n";

// ─── catalog — entries, groups, and combo formatting ───────────────────────────

export interface ShortcutEntry {
  readonly combos: readonly (readonly string[])[];
  readonly description: string;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly entries: readonly ShortcutEntry[];
}

export interface CompanionShortcutEntry {
  readonly label: string;
  readonly title: string;
}

type T = Translate<CoreMessageKey>;

/** Quick Launch 토글. 전역 단축키와 접힌 바 힌트가 같은 목록을 쓴다. */
export const QUICK_LAUNCH_TOGGLE_COMBOS = [
  ["Mod", "J"],
  ["Ctrl", "Space"],
] as const;

/**
 * 접힌 바처럼 한 덩어리로 읽는 힌트. Mod는 플랫폼 글쇠(⌘/Ctrl)로 바꾸고,
 * ⌘ 조합만 붙여 쓴다(⌘J). 그 밖은 +로 잇는다(Ctrl+J, Ctrl+Space).
 */
export function formatShortcutCombo(combo: readonly string[], modLabel: string): string {
  const keys = combo.map((key) => (key === "Mod" ? modLabel : key));
  return keys.join(keys[0] === "⌘" ? "" : "+");
}

export function buildShortcutGroups(
  t: T,
  companionShortcuts: readonly CompanionShortcutEntry[] = [],
): readonly ShortcutGroup[] {
  return [
    {
      title: t("shortcuts.group.console"),
      entries: [
        { combos: [["Mod", "K"]], description: t("shortcuts.console.searchOps") },
        { combos: [["Mod", "P"]], description: t("shortcuts.console.commandPalette") },
        { combos: [...QUICK_LAUNCH_TOGGLE_COMBOS], description: t("shortcuts.console.quickLaunch") },
        { combos: [["Mod", "B"]], description: t("shortcuts.console.toggleSidebar") },
        { combos: [["Mod", "Alt", "B"]], description: t("shortcuts.console.toggleRail") },
      ],
    },
    {
      title: t("shortcuts.group.operations"),
      entries: [
        { combos: [["Mod", "Z"]], description: t("shortcuts.operations.undoClose") },
        { combos: [["Shift", "Enter"]], description: t("shortcuts.operations.insertNewline") },
        { combos: [["Enter"], ["Esc"]], description: t("shortcuts.operations.renameConfirm") },
        { combos: [["↑"], ["↓"]], description: t("shortcuts.operations.menuNav") },
        ...companionShortcuts.map((entry) => ({
          combos: [["Alt", entry.label]],
          description: t("shortcuts.operations.toggleCompanion", { title: entry.title }),
        })),
      ],
    },
    {
      title: t("shortcuts.group.map"),
      entries: [
        { combos: [["Alt", "←"], ["Alt", "→"]], description: t("shortcuts.map.focusPrevNext") },
        { combos: [["Alt", "→"]], description: t("shortcuts.map.triageDefer") },
        { combos: [["Alt", "↑"]], description: t("shortcuts.map.maximizePanel") },
        { combos: [["Alt", "↓"]], description: t("shortcuts.map.minimizePanel") },
        { combos: [["Alt", "↓"]], description: t("shortcuts.map.triageSetAside") },
        { combos: [["Alt", "F"]], description: t("shortcuts.map.toggleFormation") },
        { combos: [["Alt", "T"]], description: t("shortcuts.map.toggleTriage") },
        { combos: [["Alt", "S"]], description: t("shortcuts.map.sortByStatus") },
        { combos: [["Drag"]], description: t("shortcuts.map.pan") },
        { combos: [["Shift", "Drag"]], description: t("shortcuts.map.drawTerminal") },
        { combos: [["Space", "Drag"]], description: t("shortcuts.map.panWithSpace") },
        { combos: [["Scroll"]], description: t("shortcuts.map.zoom") },
        { combos: [["Shift", "1"]], description: t("shortcuts.map.fitAll") },
        { combos: [["Right-click"]], description: t("shortcuts.map.contextMenu") },
        { combos: [["Double-click"]], description: t("shortcuts.map.doubleClick") },
        { combos: [["Click"]], description: t("shortcuts.map.clearFocus") },
      ],
    },
    {
      title: t("shortcuts.group.codex"),
      entries: [
        { combos: [["Mod", "K"]], description: t("shortcuts.codex.togglePalette") },
        { combos: [["↑"], ["↓"]], description: t("shortcuts.codex.moveResults") },
        { combos: [["Enter"]], description: t("shortcuts.codex.openResult") },
        { combos: [["Tab"]], description: t("shortcuts.codex.tabFocus") },
        { combos: [["Esc"]], description: t("shortcuts.codex.closePalette") },
        { combos: [["+"], ["−"], ["0"]], description: t("shortcuts.codex.zoomLightbox") },
        { combos: [["F"]], description: t("shortcuts.codex.fitLightbox") },
      ],
    },
  ];
}

// ─── companion panels — availability and toggle resolution ─────────────────────

// core가 플러그인보다 먼저 소비하는 키는 선언을 허용하면 도움말과 실제 디스패치가 어긋난다.
export const RESERVED_SHORTCUT_CODES: readonly string[] = [
  "KeyF", "KeyS", "KeyT", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape",
];

export interface CompanionVisibilityChange {
  readonly id: string;
  readonly visible: boolean;
}

export interface CompanionShortcutToggle {
  readonly openLayer: boolean;
  readonly closeLayer: boolean;
  readonly visibilityChanges: readonly CompanionVisibilityChange[];
}

export function availableCompanionPanels(
  companions: readonly CompanionPanelDescriptor[],
  operation: OperationNode,
): readonly CompanionPanelDescriptor[] {
  return companions.filter((companion) => companion.available?.(operation) ?? true);
}

export function usableCompanionShortcuts(
  companions: readonly CompanionPanelDescriptor[],
): readonly CompanionPanelDescriptor[] {
  const seenCodes = new Set<string>();
  return companions.filter((companion) => {
    const code = companion.shortcut?.code;
    if (!code || RESERVED_SHORTCUT_CODES.includes(code) || seenCodes.has(code)) return false;
    seenCodes.add(code);
    return true;
  });
}

export function resolveCompanionShortcutToggle(input: {
  readonly companions: readonly CompanionPanelDescriptor[];
  readonly targetId: string;
  readonly clusterIds?: readonly string[];
  readonly companionsOpen: boolean;
  readonly visibilityOverrides: Readonly<Record<string, boolean>>;
}): CompanionShortcutToggle {
  const target = input.companions.find((companion) => companion.id === input.targetId);
  const currentlyVisible = target
    ? companionVisible(target, input.companionsOpen, input.visibilityOverrides)
    : false;
  if (!currentlyVisible) {
    return {
      openLayer: !input.companionsOpen,
      closeLayer: false,
      visibilityChanges: [{ id: input.targetId, visible: true }],
    };
  }

  const clusterIds = [...new Set([input.targetId, ...(input.clusterIds ?? [])])];
  const clusterIdSet = new Set(clusterIds);
  const remainingVisible = input.companions.some((companion) =>
    !clusterIdSet.has(companion.id)
    && companionVisible(companion, input.companionsOpen, input.visibilityOverrides));
  return {
    openLayer: false,
    closeLayer: !remainingVisible,
    visibilityChanges: clusterIds.map((id) => ({ id, visible: false })),
  };
}

function companionVisible(
  companion: CompanionPanelDescriptor,
  companionsOpen: boolean,
  visibilityOverrides: Readonly<Record<string, boolean>>,
): boolean {
  return companionsOpen && (visibilityOverrides[companion.id] ?? companion.defaultHidden !== true);
}

// ─── companion shortcuts in scope for the active surface ───────────────────────

const ActiveCompanionShortcutsContext = createContext<readonly CompanionShortcutEntry[]>([]);

export function ActiveCompanionShortcutsProvider({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: readonly CompanionShortcutEntry[];
}) {
  return (
    <ActiveCompanionShortcutsContext.Provider value={value}>
      {children}
    </ActiveCompanionShortcutsContext.Provider>
  );
}

export function useActiveCompanionShortcuts(): readonly CompanionShortcutEntry[] {
  return useContext(ActiveCompanionShortcutsContext);
}

// ─── focus guards — dialog boundary and return-focus handoff ───────────────────

// Console-wide keyboard commands must consult this boundary before acting. Dialogs
// can be rendered through portals, so event listener ordering is not a safe guard.
export function isBlockingDialogOpen(documentFor: Document = document): boolean {
  return documentFor.querySelector('[aria-modal="true"]:not([hidden])') !== null;
}

// 팔레트처럼 "자신이 닫히면서" 단축키 다이얼로그를 여는 표면이, 다이얼로그가 닫힐 때 복원할
// 원래 포커스 요소를 App에 넘기는 1회성 채널. 여는 시점의 document.activeElement는 이미
// 제거 중인 표면 내부 요소라 App 캡처만으로는 opener를 알 수 없다.
// (core 클라이언트 단일 번들 내부 전용 — 호스트/플러그인 번들 경계를 넘지 않는다.)
let target: HTMLElement | null = null;

export function stashKeyboardShortcutsReturnFocus(element: HTMLElement | null): void {
  target = element;
}

export function takeKeyboardShortcutsReturnFocus(): HTMLElement | null {
  const taken = target;
  target = null;
  return taken;
}

export function focusCommandBandToggleWhenPanelContainsActiveElement(panel: HTMLElement | null, toggleSelector: string): void {
  const activeElement = document.activeElement;
  if (panel === null || !(activeElement instanceof Node) || !panel.contains(activeElement)) return;
  document.querySelector<HTMLButtonElement>(toggleSelector)?.focus();
}

// ─── editing guard — when typing swallows an Operations shortcut ───────────────

/**
 * 편집 중인 요소에 포커스가 있을 때 Operations 단축키를 삼킬지 정하는 정책.
 *
 * 기본은 삼키는 것이다 — 타자가 단축키에 먹히면 글을 쓸 수 없다. 예외는 Alt를 쥔 조합 전체,
 * 즉 Console 뷰 축(Alt+문자)과 패널 축(Alt+화살표)이다: 같은 키가 터미널 포커스에서는 이미
 * 살아 있으므로(xterm은 편집 판정에서 빠진다), 컴포저에 포커스가 있다는 이유로만 화면을 바꾸는
 * 키가 죽으면 표면마다 문법이 갈린다. macOS의 Option+문자 합성은 각 분기의 preventDefault가
 * 막으므로 문자가 새지 않는다.
 *
 * 화살표에도 예외를 두지 않는다. 채팅 패널에서 캐럿이 사는 자리는 컴포저 하나뿐이라, 편집 중
 * Alt+화살표를 캐럿 이동에 내주면 패널 사이를 오가는 키가 정확히 필요한 순간에만 죽는다.
 * macOS의 단어 단위 이동은 같은 사정을 이미 터미널에서 Console에 내주고 있고, 선택(Alt+Shift+
 * 화살표)은 shiftKey 분기가 preventDefault 없이 통과시키므로 편집자에게 그대로 남는다.
 */
export function blocksOperationsShortcutWhileEditing(
  editing: boolean,
  event: { readonly altKey: boolean },
): boolean {
  return editing && !event.altKey;
}

// ─── arrow keys — Operations focus, triage, and layout actions ─────────────────

export type OperationsArrowShortcutAction =
  | "focus-previous"
  | "focus-next"
  | "triage-defer"
  | "triage-noop"
  | "maximize-toggle"
  | "minimize"
  | "triage-set-aside";

export function resolveOperationsArrowShortcutAction(
  triageActive: boolean,
  key: string,
): OperationsArrowShortcutAction | null {
  if (triageActive) {
    if (key === "ArrowRight") return "triage-defer";
    if (key === "ArrowDown") return "triage-set-aside";
    if (key === "ArrowLeft" || key === "ArrowUp") return "triage-noop";
    return null;
  }
  if (key === "ArrowRight") return "focus-next";
  if (key === "ArrowLeft") return "focus-previous";
  if (key === "ArrowUp") return "maximize-toggle";
  if (key === "ArrowDown") return "minimize";
  return null;
}
