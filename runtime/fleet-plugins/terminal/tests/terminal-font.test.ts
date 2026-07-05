import { afterEach, describe, expect, it } from "vitest";

import {
  CURATED_TERMINAL_FONTS,
  createCustomTerminalFontSettings,
  parseStoredTerminalFontSettings,
  resolveTerminalFont,
} from "../client/shared/terminal-font.js";

describe("terminal font settings", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
  });

  it("pins curated terminal fonts to the measured fontsource variable family names", () => {
    expect(CURATED_TERMINAL_FONTS.map((font) => [font.name, font.family])).toEqual([
      ["Cascadia Code", "\"Cascadia Code Variable\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace"],
      ["JetBrains Mono", "\"JetBrains Mono Variable\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace"],
      ["Fira Code", "\"Fira Code Variable\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace"],
      ["Source Code Pro", "\"Source Code Pro Variable\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace"],
    ]);
  });

  it("normalizes stored custom font names and clamps sizes", () => {
    expect(parseStoredTerminalFontSettings(JSON.stringify({
      source: "custom",
      customName: "  MesloLGS NF  ",
      size: 99,
    }))).toMatchObject({
      source: "custom",
      customName: "MesloLGS NF",
      family: "\"MesloLGS NF\", \"Cascadia Code Variable\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace",
      size: 22,
    });
  });

  it("removes control characters and caps custom font names before building font-family", () => {
    const longName = "A".repeat(140);
    const settings = createCustomTerminalFontSettings(`\t\n  Meslo\r"NF"\\${longName}\f  `, 14);

    expect(settings.customName).toHaveLength(128);
    expect(settings.customName).not.toMatch(/[\x00-\x1F\x7F]/);
    expect(settings.family).not.toMatch(/[\r\n\t\f]/);
    expect(settings.family).toContain("\\\"NF\\\"");
    expect(settings.family).toContain("\\\\");
  });

  it("sanitizes custom font names restored from localStorage", () => {
    const settings = parseStoredTerminalFontSettings(JSON.stringify({
      source: "custom",
      customName: "\n\t  \f",
      size: 14,
    }));

    expect(settings).toMatchObject({
      source: "custom",
      customName: "",
      family: "\"Cascadia Code Variable\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace",
      size: 14,
    });
  });

  it("keeps Symbols Nerd Font Mono immediately before final monospace in every generated chain", () => {
    const custom = createCustomTerminalFontSettings("MesloLGS NF", 14);
    const families = [...CURATED_TERMINAL_FONTS.map((font) => font.family), custom.family];

    for (const family of families) {
      expect(family).toMatch(/"Symbols Nerd Font Mono", monospace$/);
      expect(family).not.toMatch(/"Symbols Nerd Font Mono".*"Symbols Nerd Font Mono"/);
    }
  });

  it("uses canvas width comparison to distinguish resolved custom fonts from fallback", () => {
    mockCanvasWidths({
      monospace: 100,
      serif: 120,
      "sans-serif": 130,
      '"MesloLGS NF", monospace': 108,
      '"Missing Mono", monospace': 100,
      '"Missing Mono", serif': 120,
      '"Missing Mono", sans-serif': 130,
    });

    expect(resolveTerminalFont(createCustomTerminalFontSettings("MesloLGS NF", 14))).toMatchObject({ status: "resolved" });
    expect(resolveTerminalFont(createCustomTerminalFontSettings("Missing Mono", 14))).toMatchObject({ status: "fallback", fallbackName: "Cascadia Code" });
  });
});

function mockCanvasWidths(widths: Readonly<Record<string, number>>): void {
  let currentFamily = "";
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => ({
          set font(value: string) {
            currentFamily = value.replace(/^28px /, "");
          },
          measureText: () => ({ width: widths[currentFamily] ?? 100 }),
        }),
      }),
    },
  });
}
