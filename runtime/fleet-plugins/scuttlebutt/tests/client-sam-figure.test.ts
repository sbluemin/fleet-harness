import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const figure = readFileSync(new URL("../client/sam-figure.tsx", import.meta.url), "utf8");
const mascot = readFileSync(new URL("../client/mascot.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../client/styles.css", import.meta.url), "utf8");

describe("Admiral Sam figure", () => {
  it("keeps the approved inline SVG geometry, token fills, and accessibility boundary", () => {
    expect(figure).toContain('className="scuttlebutt-sam"');
    expect(figure).toContain('viewBox="0 0 76 92"');
    expect(figure).toContain('aria-hidden="true"');
    expect(figure).not.toMatch(/role="img"|aria-label=/);

    for (const className of [
      "scuttlebutt-sam-all",
      "scuttlebutt-sam-tail",
      "scuttlebutt-sam-arm-l",
      "scuttlebutt-sam-arm-r",
      "scuttlebutt-sam-body",
      "scuttlebutt-sam-head",
      "scuttlebutt-sam-ear-l",
      "scuttlebutt-sam-ear-r",
      "scuttlebutt-sam-eyes",
      "scuttlebutt-sam-happy",
      "scuttlebutt-sam-spark",
    ]) {
      expect(figure).toContain(`className="${className}"`);
    }

    for (const path of [
      "M54 74 C66 74 70 64 68 54 C67 49 63 47 61 50 C59 53 62 55 63 59 C64 65 60 68 53 68 Z",
      "M20 92 L20 68 C20 61 26 57 38 57 C50 57 56 61 56 68 L56 92 Z",
      "M31 57 L38 70 L45 57 Z",
      "M17 26 L20 9 L33 20 Z",
      "M59 26 L56 9 L43 20 Z",
      "M13 30 C13 16 23 8 38 8 C53 8 63 16 63 30 Z",
      "M10 36 C10 33 66 33 66 36 C66 41 55 44 38 44 C21 44 10 41 10 36 Z",
      "M38 13 v9 M33 16 h10 M32 21 c0 4 12 4 12 0",
      "M22 53 c2.4 -4.4 8.2 -4.4 10.6 0",
      "M44 53 c2.4 -4.4 8.2 -4.4 10.6 0",
      "M38 57 l-2.4 2.4 h4.8 Z",
      "M6 50 h7 M6 56 h7 M63 50 h7 M63 56 h7",
      "M8 30 l1.6 4 4 1.6 -4 1.6 -1.6 4 -1.6 -4 -4 -1.6 4 -1.6 Z",
      "M68 26 l1.3 3.2 3.2 1.3 -3.2 1.3 -1.3 3.2 -1.3 -3.2 -3.2 -1.3 3.2 -1.3 Z",
    ]) {
      expect(figure).toContain(`d="${path}"`);
    }

    expect(figure).not.toMatch(/fill="#|stroke="#|rgb\(|hsl\(/);
    expect(figure.match(/(?:fill|stroke)="var\(--(?:ink-pearl|ink-veil|ink-rim|ink-abyss|brass)\)"/g))
      .toHaveLength(27);
  });

  it("maps every mascot phase and reduced motion to the approved vector behavior", () => {
    expect(styles).toMatch(/\.scuttlebutt-sam\s*\{[^}]*width: auto;[^}]*height: 72px;/s);
    expect(styles).toContain("transform-origin: 96% 2%");
    expect(styles).toContain("transform-origin: 4% 2%");
    expect(styles).toContain(
      ".scuttlebutt-mascot:not(.is-thinking):not(.is-ready):not(.is-cheering) .scuttlebutt-sam-eyes",
    );
    expect(styles).toContain(".scuttlebutt-mascot.is-thinking .scuttlebutt-sam-head");
    expect(styles).toMatch(
      /\.scuttlebutt-mascot\.is-ready \.scuttlebutt-sam-eyes\s*\{\s*opacity: 0;/,
    );
    expect(styles).toMatch(
      /\.scuttlebutt-mascot\.is-ready \.scuttlebutt-sam-happy\s*\{\s*opacity: 1;/,
    );
    expect(styles).toContain(
      "animation: scuttlebutt-sam-hop 1.25s var(--ease-spring) 1",
    );
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.scuttlebutt-sam \*[\s\S]*animation: none !important;/,
    );
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.is-cheering \.scuttlebutt-sam-happy\s*\{\s*opacity: 1;/,
    );
  });

  it("removes the pixel sprite while preserving live element measurement", () => {
    expect(mascot).toContain("<SamFigure />");
    expect(mascot).toContain("mascotRef.current?.getBoundingClientRect()");
    expect(`${mascot}\n${styles}`).not.toMatch(
      /scuttlebutt-(?:cat|pixel|fur|eyes|arms|blink|cheer)(?!ing)|--scuttlebutt-pixel-size/,
    );
  });
});
