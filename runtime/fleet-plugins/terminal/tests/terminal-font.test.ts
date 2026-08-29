import { afterEach, describe, expect, it } from "vitest";

import {
  CURATED_TERMINAL_FONTS,
  BUNDLED_CJK_FALLBACK_FAMILY,
  createCuratedTerminalFontSettings,
  createTerminalFontSettings,
  curatedTerminalFontFamily,
  terminalFontFallbackStack,
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
    expect(CURATED_TERMINAL_FONTS.map((font) => [font.name, curatedTerminalFontFamily(font.id, "")])).toEqual([
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
    const families = [...CURATED_TERMINAL_FONTS.map((font) => curatedTerminalFontFamily(font.id, "")), custom.family];

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
    const families = [...CURATED_TERMINAL_FONTS.map((font) => curatedTerminalFontFamily(font.id, "")), custom.family];

    for (const family of families) {
      expect(family).toContain("\"Nanum Gothic Coding\"");
      expect(family).toMatch(/"Nanum Gothic Coding", ui-monospace/);
      expect(family).not.toMatch(/^"Nanum Gothic Coding"/);
      expect(family).not.toMatch(/"Nanum Gothic Coding".*"Nanum Gothic Coding"/);
    }

    /* 큐레이트 4종은 선택 서체가 곧 첫 자리다. 커스텀은 사용자 이름이 첫 자리고 기본 Cascadia가
       그 뒤에 붙으므로, 한글 폴백은 라틴 후보를 전부 지나온 자리에 선다. */
    for (const font of CURATED_TERMINAL_FONTS) {
      expect(curatedTerminalFontFamily(font.id, "")).toMatch(new RegExp(`^"${font.familyName}", "Nanum Gothic Coding", `));
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

    expect(JSON.parse(serialized)).toEqual({ source: "custom", id: null, customName: "Installed Mono", cjkFallbackName: "", size: 16 });
    expect(parseTerminalFontSettingsValue(JSON.parse(serialized))).toEqual(settings);
    expect(parseTerminalFontSettingsValue({ source: "system", familyName: "Installed Mono", size: 16 })).toBeNull();
  });

  /* CJK 폴백은 "체인 어딘가"가 아니라 자리가 계약이다. 사용자가 고른 서체는 선택 서체 바로 뒤,
     번들 서체 바로 앞에 선다 — 뒤로 밀리면 번들 한글이 먼저 잡아 사용자 선택이 한글에서는 무의미해지고,
     맨 앞으로 가면 라틴까지 가로챈다. */
  it("seats the chosen CJK fallback between the selected family and the bundled face", () => {
    const curated = createCuratedTerminalFontSettings("fira-code", 14, "D2Coding");
    const custom = createCustomTerminalFontSettings("MesloLGS NF", 14, "D2Coding");

    expect(curated.family).toBe("\"Fira Code Variable\", \"D2Coding\", \"Nanum Gothic Coding\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace");
    expect(custom.family).toBe("\"MesloLGS NF\", \"Cascadia Code Variable\", \"D2Coding\", \"Nanum Gothic Coding\", ui-monospace, \"SF Mono\", Menlo, \"Symbols Nerd Font Mono\", monospace");
  });

  /* 사용자 선택이 번들 서체를 대체하지 않고 그 앞에 서기만 하는 것이 핵심이다. 가나·한자만 있고
     한글이 없는 일본어 서체를 골랐을 때 번들을 치웠다면 한글이 다시 OS 폴백으로 샌다. */
  it("keeps the bundled Korean face behind every chosen fallback", () => {
    for (const chosen of ["Hiragino Sans", "PingFang SC", "D2Coding"]) {
      expect(terminalFontFallbackStack(chosen)).toMatch(new RegExp(`^"${chosen}", "Nanum Gothic Coding", `));
    }
  });

  it("never lists the bundled face twice when it is itself the chosen fallback", () => {
    expect(terminalFontFallbackStack(BUNDLED_CJK_FALLBACK_FAMILY)).toBe(terminalFontFallbackStack(""));
    expect(createCuratedTerminalFontSettings("cascadia", 14, BUNDLED_CJK_FALLBACK_FAMILY).family)
      .toBe(createCuratedTerminalFontSettings("cascadia", 14, "").family);
  });

  it("carries the CJK fallback through storage and treats an absent field as bundled-only", () => {
    const settings = createCuratedTerminalFontSettings("jetbrains", 16, "  D2Coding  ");
    expect(settings.cjkFallbackName).toBe("D2Coding");
    expect(parseTerminalFontSettingsValue(JSON.parse(serializeTerminalFontSettings(settings)))).toEqual(settings);

    // 이 필드가 생기기 전의 저장본. 판본 없이 읽히고, 번들 서체만 쓰던 그때의 체인을 그대로 낸다.
    const legacy = parseTerminalFontSettingsValue({ source: "curated", id: "jetbrains", customName: "", size: 16 });
    expect(legacy).toEqual(createCuratedTerminalFontSettings("jetbrains", 16, ""));
    expect(legacy?.cjkFallbackName).toBe("");
  });

  it("rebuilds the chain around a new fallback without disturbing the selected family or size", () => {
    const curated = createTerminalFontSettings(createCuratedTerminalFontSettings("source-code-pro", 18, ""), "Sarasa Mono K");
    const custom = createTerminalFontSettings(createCustomTerminalFontSettings("Berkeley Mono", 12, "D2Coding"), "");

    expect(curated).toMatchObject({ source: "curated", id: "source-code-pro", size: 18, cjkFallbackName: "Sarasa Mono K" });
    expect(curated.family).toContain("\"Source Code Pro Variable\", \"Sarasa Mono K\", ");
    expect(custom).toMatchObject({ source: "custom", customName: "Berkeley Mono", size: 12, cjkFallbackName: "" });
    expect(custom.family).toBe(createCustomTerminalFontSettings("Berkeley Mono", 12).family);
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
