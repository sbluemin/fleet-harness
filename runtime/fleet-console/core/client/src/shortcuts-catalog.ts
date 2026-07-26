import type { Translate } from "@fleet-console/sdk/i18n";

import type { CoreMessageKey } from "./i18n/index.js";

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

export function buildShortcutGroups(
  t: T,
  companionShortcuts: readonly CompanionShortcutEntry[] = [],
): readonly ShortcutGroup[] {
  return [
    {
      title: t("shortcuts.group.console"),
      entries: [
        { combos: [["Mod", "K"]], description: t("shortcuts.console.searchOps") },
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
