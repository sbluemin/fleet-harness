import { afterEach, describe, expect, it } from "vitest";

import {
  CURATED_TERMINAL_FONTS,
  createCuratedTerminalFontSettings,
  createCustomTerminalFontSettings,
  parseStoredTerminalFontSettings,
  parseTerminalFontSettingsValue,
  resolveTerminalFont,
  serializeTerminalFontSettings,
} from "../client/shared/terminal-preferences.js";

describe("terminal font settings", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
  });

  it("pins curated terminal fonts to the measured fontsource variable family names", () => {
    expect(CURATED_TERMINAL_FONTS.map((font) => [font.name, font.family])).toEqual([
      ["Cascadia Code", "\"Cascadia Code Variable\", \"Nanum Gothic Coding\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace"],
      ["JetBrains Mono", "\"JetBrains Mono Variable\", \"Nanum Gothic Coding\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace"],
      ["Fira Code", "\"Fira Code Variable\", \"Nanum Gothic Coding\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace"],
      ["Source Code Pro", "\"Source Code Pro Variable\", \"Nanum Gothic Coding\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace"],
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
      family: "\"MesloLGS NF\", \"Cascadia Code Variable\", \"Nanum Gothic Coding\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace",
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
      family: "\"Cascadia Code Variable\", \"Nanum Gothic Coding\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace",
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

  /* 한글 등폭 폴백은 "체인에 있다"로 부족하다 — 선택 서체 바로 뒤라야 한다. 뒤로 밀리면 한글이
     ui-monospace/SF Mono/Menlo가 플랫폼에서 무엇으로 풀리느냐에 걸리고, 앞으로 당겨지면 사용자가
     고른 서체의 라틴을 이 서체가 가로챈다. 위치가 곧 계약이다. */
  it("seats the Korean monospace fallback immediately after the selected family in every generated chain", () => {
    const custom = createCustomTerminalFontSettings("MesloLGS NF", 14);
    const families = [...CURATED_TERMINAL_FONTS.map((font) => font.family), custom.family];

    for (const family of families) {
      expect(family).toContain("\"Nanum Gothic Coding\"");
      expect(family).toMatch(/"Nanum Gothic Coding", ui-monospace/);
      expect(family).not.toMatch(/^"Nanum Gothic Coding"/);
      expect(family).not.toMatch(/"Nanum Gothic Coding".*"Nanum Gothic Coding"/);
    }

    /* 큐레이트 4종은 선택 서체가 곧 첫 자리다. 커스텀은 사용자 이름이 첫 자리고 기본 Cascadia가
       그 뒤에 붙으므로, 한글 폴백은 라틴 후보를 전부 지나온 자리에 선다. */
    for (const font of CURATED_TERMINAL_FONTS) {
      expect(font.family).toMatch(new RegExp(`^"${font.familyName}", "Nanum Gothic Coding", `));
    }
    expect(custom.family).toMatch(/^"MesloLGS NF", "Cascadia Code Variable", "Nanum Gothic Coding", /);
  });

  it("maps self-hosted, resolved, and fallback selections through the shared resolver", () => {
    mockCanvasWidths({
      monospace: 100,
      serif: 120,
      "sans-serif": 130,
      '"MesloLGS NF", monospace': 108,
      '"Missing Mono", monospace': 100,
      '"Missing Mono", serif': 120,
      '"Missing Mono", sans-serif': 130,
    });

    expect(resolveTerminalFont(createCuratedTerminalFontSettings("cascadia", 14))).toMatchObject({ status: "self-hosted", fallbackName: "Cascadia Code" });
    expect(resolveTerminalFont(createCustomTerminalFontSettings("MesloLGS NF", 14))).toMatchObject({ status: "resolved" });
    expect(resolveTerminalFont(createCustomTerminalFontSettings("Missing Mono", 14))).toMatchObject({ status: "fallback", fallbackName: "Cascadia Code" });
  });

  it("round-trips legacy custom storage without introducing a system source", () => {
    const settings = createCustomTerminalFontSettings("Installed Mono", 16);
    const serialized = serializeTerminalFontSettings(settings);

    expect(JSON.parse(serialized)).toEqual({ source: "custom", id: null, customName: "Installed Mono", size: 16 });
    expect(parseTerminalFontSettingsValue(JSON.parse(serialized))).toEqual(settings);
    expect(parseTerminalFontSettingsValue({ source: "system", familyName: "Installed Mono", size: 16 })).toBeNull();
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
