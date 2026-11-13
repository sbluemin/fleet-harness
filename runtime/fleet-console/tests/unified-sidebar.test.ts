import { describe, expect, it } from "vitest";

import { COMMODORE_ALIAS_MAX_LENGTH } from "../features/commodore/shared/alias.js";
import { sanitizeConsoleSettingsData } from "../features/settings/host/settings-domain.js";
import {
  UNIFIED_CREATE_ALIAS_MAX,
  UNIFIED_SIDEBAR_HOME,
  isUnifiedSidebarLayout,
  parseConsoleSectionCommand,
  seedUnifiedSidebar,
  withoutUnifiedConsole,
} from "../protocol/desktop/console-section.js";

const ids = () => {
  let n = 0;
  return () => `section-${n += 1}`;
};

describe("unified sidebar contract", () => {
  it("seeds by section name without rewriting a machine's own section ids", () => {
    const layout = seedUnifiedSidebar({
      sections: [
        { id: "home-fleet", name: "플릿", collapsed: false },
        { id: "home-meta", name: "메타", collapsed: true },
      ],
      membership: { "commodore-home": "home-fleet" },
      order: ["commodore-home", "commodore-loose"],
      unsectionedCollapsed: false,
    }, [{
      consoleId: "machine-mac",
      sections: [{ id: "remote-fleet", name: "플릿", collapsed: true }, { id: "remote-win", name: "윈도우" }],
      commodores: [
        { id: "commodore-remote", section: "remote-fleet" },
        { id: "commodore-window", section: "remote-win" },
        { id: "commodore-none" },
      ],
    }], ids());

    expect(layout.seeded).toBe(true);
    expect(layout.sections.map((section) => [section.name, section.collapsed])).toEqual([
      ["플릿", false],
      ["메타", true],
      ["윈도우", false],
    ]);
    expect(layout.sections.map((section) => section.id)).not.toEqual(expect.arrayContaining(["home-fleet", "remote-fleet", "remote-win"]));
    const fleet = layout.sections[0]!.id;
    const win = layout.sections[2]!.id;
    expect(layout.membership).toEqual([
      { consoleId: UNIFIED_SIDEBAR_HOME, commodoreId: "commodore-home", sectionId: fleet },
      { consoleId: "machine-mac", commodoreId: "commodore-remote", sectionId: fleet },
      { consoleId: "machine-mac", commodoreId: "commodore-window", sectionId: win },
    ]);
    expect(layout.order.map((row) => row.commodoreId)).toEqual(["commodore-home", "commodore-loose", "commodore-remote", "commodore-window", "commodore-none"]);
    expect(layout.order.find((row) => row.commodoreId === "commodore-loose")?.consoleId).toBe(UNIFIED_SIDEBAR_HOME);
  });

  it("keeps a disconnected machine and drops only a forgotten one", () => {
    const seeded = seedUnifiedSidebar({
      sections: [{ id: "home-fleet", name: "플릿", collapsed: false }],
      membership: {},
      order: ["commodore-home"],
      unsectionedCollapsed: false,
    }, [{ consoleId: "machine-mac", sections: [], commodores: [{ id: "commodore-remote" }] }], ids());
    expect(seeded.order).toHaveLength(2);
    expect(withoutUnifiedConsole(seeded, UNIFIED_SIDEBAR_HOME)).toEqual(seeded);
    const forgotten = withoutUnifiedConsole(seeded, "machine-mac");
    expect(forgotten.order.map((row) => row.commodoreId)).toEqual(["commodore-home"]);
    expect(forgotten.membership).toEqual([]);
    expect(forgotten.sections.map((section) => section.name)).toEqual(["플릿"]);
  });

  it("accepts additive commands and still rejects a mixed command", () => {
    expect(parseConsoleSectionCommand(JSON.stringify({ request: "state" }))).toEqual({ request: "state" });
    expect(parseConsoleSectionCommand(JSON.stringify({
      unified: { op: "move", row: { consoleId: "machine-mac", commodoreId: "commodore-remote" }, sectionId: null },
    }))).toEqual({ unified: { op: "move", row: { consoleId: "machine-mac", commodoreId: "commodore-remote" }, sectionId: null } });
    expect(parseConsoleSectionCommand(JSON.stringify({
      createCommodore: { consoleId: UNIFIED_SIDEBAR_HOME, alias: "새 사령관", request: "req-1" },
    }))).toEqual({ createCommodore: { consoleId: UNIFIED_SIDEBAR_HOME, alias: "새 사령관", request: "req-1" } });
    expect(parseConsoleSectionCommand(JSON.stringify({ createCommodore: { consoleId: "machine-mac", alias: "x".repeat(41), request: "req-1" } }))).toBeNull();
    expect(parseConsoleSectionCommand(JSON.stringify({ unified: { op: "state" }, request: "state" }))).toBeNull();
    expect(UNIFIED_CREATE_ALIAS_MAX).toBe(COMMODORE_ALIAS_MAX_LENGTH);
  });

  it("stores unified placement beside, not inside, commodoreSidebar", () => {
    const unifiedSidebar = {
      v: 1 as const,
      seeded: true,
      sections: [{ id: "section-1", name: "플릿", collapsed: false }],
      membership: [{ consoleId: "machine-mac", commodoreId: "commodore-remote", sectionId: "section-1" }],
      order: [{ consoleId: "machine-mac", commodoreId: "commodore-remote" }],
      unsectionedCollapsed: false,
    };
    const commodoreSidebar = { sections: [{ id: "11111111-1111-4111-8111-111111111111", name: "로컬", collapsed: false }], membership: {}, unsectionedCollapsed: false };
    expect(isUnifiedSidebarLayout(unifiedSidebar)).toBe(true);
    const saved = sanitizeConsoleSettingsData({ version: 1, commodoreSidebar, unifiedSidebar });
    expect(saved.unifiedSidebar).toEqual(unifiedSidebar);
    expect(saved.commodoreSidebar).toEqual(commodoreSidebar);
    const dropped = sanitizeConsoleSettingsData({ version: 1, commodoreSidebar, unifiedSidebar: { v: 1, seeded: false } });
    expect(dropped.unifiedSidebar).toBeUndefined();
    expect(dropped.commodoreSidebar).toEqual(commodoreSidebar);
  });
});
