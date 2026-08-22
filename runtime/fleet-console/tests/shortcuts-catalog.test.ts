import { describe, expect, it } from "vitest";

import { getT } from "../core/client/src/i18n/index.js";
import { buildShortcutGroups, formatShortcutCombo, QUICK_LAUNCH_TOGGLE_COMBOS } from "../core/client/src/shortcuts.js";

describe("shortcut catalog", () => {
  it("lists the command palette immediately after operation search, then Quick Launch", () => {
    const consoleGroup = buildShortcutGroups(getT("en"))
      .find((group) => group.title === "Console")!;

    expect(consoleGroup.entries.slice(0, 3)).toEqual([
      { combos: [["Mod", "K"]], description: "Search Operations across Theaters" },
      { combos: [["Mod", "P"]], description: "Open Command Palette" },
      { combos: [...QUICK_LAUNCH_TOGGLE_COMBOS], description: "Toggle Quick Launch" },
    ]);
    expect(QUICK_LAUNCH_TOGGLE_COMBOS).toEqual([["Mod", "J"], ["Ctrl", "Space"]]);
  });

  it("formats Quick Launch toggle hints as one chord each", () => {
    expect(formatShortcutCombo(["Mod", "J"], "⌘")).toBe("⌘J");
    expect(formatShortcutCombo(["Mod", "J"], "Ctrl")).toBe("Ctrl+J");
    expect(formatShortcutCombo(["Ctrl", "Space"], "⌘")).toBe("Ctrl+Space");
    expect(formatShortcutCombo(["Ctrl", "Space"], "Ctrl")).toBe("Ctrl+Space");
  });

  it("appends active companion shortcuts to the end of Operations", () => {
    const operations = buildShortcutGroups(getT("en"), [
      { label: "C", title: "Chat" },
      { label: "A", title: "Session Analyst" },
    ]).find((group) => group.title === "Operations")!;

    expect(operations.entries.slice(-2)).toEqual([
      { combos: [["Alt", "C"]], description: "Toggle Chat" },
      { combos: [["Alt", "A"]], description: "Toggle Session Analyst" },
    ]);
  });

  it("keeps static groups unchanged when no companion shortcuts are supplied", () => {
    const groups = buildShortcutGroups(getT("en"));
    const operations = groups.find((group) => group.title === "Operations")!;

    expect(operations.entries).toHaveLength(4);
    expect(groups.flatMap((group) => group.entries).map((entry) => entry.description))
      .not.toContain("Close the open overlay or menu");
    expect(groups.flatMap((group) => group.entries).map((entry) => entry.description))
      .not.toContain("Close the job stream");
  });
});
