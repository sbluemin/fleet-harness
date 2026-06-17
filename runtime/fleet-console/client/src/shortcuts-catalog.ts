export interface ShortcutEntry {
  readonly combos: readonly (readonly string[])[];
  readonly description: string;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly entries: readonly ShortcutEntry[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "Console",
    entries: [
      { combos: [["Mod", "K"]], description: "Search Operations across Theaters" },
      { combos: [["Mod", "`"]], description: "Toggle the local shell" },
      { combos: [["Esc"]], description: "Close the open overlay or menu" },
    ],
  },
  {
    title: "Operations",
    entries: [
      { combos: [["Esc"]], description: "Close the carrier job stream" },
      { combos: [["Shift", "Enter"]], description: "Insert a newline in the terminal instead of submitting" },
      { combos: [["Enter"], ["Esc"]], description: "Confirm or cancel a session rename" },
      { combos: [["↑"], ["↓"]], description: "Move between Theater, Theme, and launch menu items" },
    ],
  },
  {
    title: "Map",
    entries: [
      { combos: [["Alt", "←"], ["Alt", "→"]], description: "Focus the previous / next Operation (also in Helm)" },
      { combos: [["Drag"]], description: "Pan the operations map" },
      { combos: [["Shift", "Drag"]], description: "Draw a new Operation terminal" },
      { combos: [["Space", "Drag"]], description: "Pan even while a terminal has focus" },
      { combos: [["Scroll"]], description: "Zoom the map in or out" },
      { combos: [["Right-click"]], description: "Open the canvas actions menu" },
      { combos: [["Double-click"]], description: "Focus a panel from its title bar; rename from its name" },
      { combos: [["Click"]], description: "Clear terminal focus on the empty canvas" },
    ],
  },
  {
    title: "Codex",
    entries: [
      { combos: [["Mod", "K"]], description: "Toggle the command palette" },
      { combos: [["↑"], ["↓"]], description: "Move through command palette results" },
      { combos: [["Enter"]], description: "Open the selected result" },
      { combos: [["Tab"]], description: "Move focus within the command palette" },
      { combos: [["Esc"]], description: "Close the command palette or diagram lightbox" },
      { combos: [["+"], ["−"], ["0"]], description: "Zoom the diagram lightbox in / out / reset" },
      { combos: [["F"]], description: "Fit the diagram lightbox to the viewport" },
    ],
  },
];
