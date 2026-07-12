import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { desktopThemeSnapshot } from "../core/host/desktop-theme.js";

const CONSOLE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Console Desktop theme mapping", () => {
  it("keeps native title bar colors in parity with the Console CSS theme tokens", () => {
    const css = fs.readFileSync(path.join(CONSOLE_PACKAGE_ROOT, "core", "client", "src", "styles", "theme.css"), "utf8");
    expect(desktopThemeSnapshot("instrument").titleBarOverlay).toMatchObject({
      color: oklchToHex(readToken(css, "base", "canvas-sea-core")),
      symbolColor: oklchToHex(readToken(css, "base", "text-secondary")),
      height: 43,
    });
    for (const theme of ["maritime", "carbon"] as const) {
      expect(desktopThemeSnapshot(theme).titleBarOverlay).toMatchObject({
        color: oklchToHex(readToken(css, theme, "ink-deep")),
        symbolColor: oklchToHex(readToken(css, theme, "ink-spectral")),
        height: 43,
      });
    }
  });
});

function readToken(css: string, theme: "base" | "maritime" | "carbon", token: string): [number, number, number] {
  const tokenPattern = new RegExp(`--${token}: oklch\\(([^%]+)% ([^ ]+) ([^)]+)\\);`, "u");
  const blocks = theme === "base"
    ? [css.slice(0, css.indexOf(':root[data-theme="instrument"]'))]
    : [...css.matchAll(new RegExp(`:root\\[data-theme="${theme}"\\][^{]*\\{([^}]*)\\}`, "gu"))].map((match) => match[1] ?? "");
  for (const block of blocks) {
    const match = block.match(tokenPattern);
    if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  throw new Error(`missing_theme_token:${theme}:${token}`);
}

function oklchToHex([lightnessPercent, chroma, hue]: [number, number, number]): string {
  const lightness = lightnessPercent / 100;
  const a = chroma * Math.cos(hue * Math.PI / 180);
  const b = chroma * Math.sin(hue * Math.PI / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${channels.map(toSrgbByte).map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function toSrgbByte(value: number): number {
  const srgb = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, srgb)) * 255);
}
