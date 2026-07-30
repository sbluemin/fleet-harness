import { describe, expect, it } from "vitest";

import { getT } from "../core/client/src/i18n/index.js";
import { buildShortcutGroups } from "../core/client/src/shortcuts-catalog.js";

describe("shortcut catalog", () => {
  it("lists the command palette immediately after operation search", () => {
    const consoleGroup = buildShortcutGroups(getT("en"))
      .find((group) => group.title === "Console")!;

    expect(consoleGroup.entries.slice(0, 2)).toEqual([
      { combos: [["Mod", "K"]], description: "Search Operations across Theaters" },
      { combos: [["Mod", "P"]], description: "Open Command Palette" },
    ]);
  });

  it("appends active companion shortcuts to the end of Operations", () => {
    const operations = buildShortcutGroups(getT("en"), [
      { label: "C", title: "Carrier Streams" },
      { label: "A", title: "Session Analyst" },
    ]).find((group) => group.title === "Operations")!;

    expect(operations.entries.slice(-2)).toEqual([
      { combos: [["Alt", "C"]], description: "Toggle Carrier Streams" },
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
      .not.toContain("Close the carrier job stream");
  });
});
