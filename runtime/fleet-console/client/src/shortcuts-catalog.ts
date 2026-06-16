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
