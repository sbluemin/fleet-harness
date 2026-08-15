import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const figure = readFileSync(new URL("../client/quaker-figure.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../client/styles.css", import.meta.url), "utf8");

describe("Quaker admiral figures", () => {
  it("keeps the approved inline SVG accessibility and part contract", () => {
    expect(figure).toContain('viewBox="0 0 260 300"');
    expect(figure).toContain('aria-hidden="true"');
    expect(figure).not.toMatch(/role="img"|aria-label=/);

    for (const className of [
      "scuttlebutt-qk-tail",
      "scuttlebutt-qk-wing",
      "scuttlebutt-qk-wing-l",
      "scuttlebutt-qk-wing-r",
      "scuttlebutt-qk-feet",
      "scuttlebutt-qk-foot-l",
      "scuttlebutt-qk-foot-r",
      "scuttlebutt-qk-head",
      "scuttlebutt-qk-eyes",
      "scuttlebutt-qk-happy",
      "scuttlebutt-qk-zzz",
      "scuttlebutt-qk-mark",
      "scuttlebutt-qk-spark",
      "scuttlebutt-qk-ln",
      "scuttlebutt-qk-cap-ln",
    ]) {
      expect(figure).toContain(className);
    }

    expect(figure).not.toMatch(/fill="#|stroke="#|rgb\(|hsl\(/);
  });

  it("defines every morph and approved ancestor state", () => {
    for (const morph of ["tori", "bori", "dori"]) {
      expect(styles).toMatch(
        new RegExp(`\\.scuttlebutt-qk\\[data-morph="${morph}"\\]`),
      );
    }

    expect(styles).toMatch(/\.scuttlebutt-qk\s*\{[^}]*overflow: visible;/s);
    for (const state of [
      "cruise",
      "grab",
      "walk",
      "sleep",
      "think",
      "salute",
      "alert",
      "cheer",
      "preen",
    ]) {
      expect(styles).toContain(`.scuttlebutt-bird.is-${state}`);
    }
  });

  it("consumes only immutable mascot source tokens for QK colors", () => {
    const qkPalette = styles.slice(
      styles.indexOf(".scuttlebutt-qk {"),
      styles.indexOf(".scuttlebutt-qk * {"),
    );
    const sourceReferences = new Set(
      [...qkPalette.matchAll(/var\((--scuttlebutt-qk-[a-z-]+)\)/g)].map(
        ([, token]) => token,
      ),
    );

    expect(sourceReferences).toEqual(
      new Set([
        "--scuttlebutt-qk-ink-abyss",
        "--scuttlebutt-qk-ink-deep",
        "--scuttlebutt-qk-ink-veil",
        "--scuttlebutt-qk-ink-rim",
        "--scuttlebutt-qk-ink-spectral",
        "--scuttlebutt-qk-ink-pearl",
        "--scuttlebutt-qk-brass",
        "--scuttlebutt-qk-brass-deep",
        "--scuttlebutt-qk-id-crimson",
        "--scuttlebutt-qk-id-amber",
        "--scuttlebutt-qk-id-moss",
        "--scuttlebutt-qk-id-cerulean",
        "--scuttlebutt-qk-id-rose",
      ]),
    );
    expect(qkPalette).not.toMatch(/var\(--(?:ink|id|brass)(?:-[a-z-]+)?\)/);
  });

  it("holds Bori's alert on the mark without hop or mark-pop", () => {
    expect(styles).toMatch(
      /\.scuttlebutt-bird\.is-alert \.scuttlebutt-qk:not\(\[data-morph="bori"\]\)\s*\{\s*animation: scuttlebutt-qk-hop/,
    );
    expect(styles).toMatch(
      /\.scuttlebutt-bird\.is-alert \.scuttlebutt-qk:not\(\[data-morph="bori"\]\) \.scuttlebutt-qk-wing-l/,
    );
    expect(styles).toMatch(
      /\.scuttlebutt-bird\.is-alert \.scuttlebutt-qk\[data-morph="bori"\] \.scuttlebutt-qk-wing-l[\s\S]*?animation: none;/,
    );
    expect(styles).toMatch(
      /\.scuttlebutt-bird\.is-alert \.scuttlebutt-qk-mark\s*\{\s*opacity: 1;/,
    );
    expect(styles).toMatch(
      /\.scuttlebutt-bird\.is-alert \.scuttlebutt-qk:not\(\[data-morph="bori"\]\) \.scuttlebutt-qk-mark\s*\{\s*animation: scuttlebutt-qk-markpop/,
    );
  });

  it("preserves the four reduced-motion pose fallbacks", () => {
    const reducedMotion = styles.slice(
      styles.indexOf("@media (prefers-reduced-motion: reduce)"),
    );

    expect(reducedMotion).toMatch(
      /\.scuttlebutt-qk,\s*\.scuttlebutt-qk \*[\s\S]*animation: none !important;/,
    );
    expect(reducedMotion).toMatch(
      /\.scuttlebutt-bird\.is-cheer \.scuttlebutt-qk-eyes\s*\{\s*opacity: 0;/,
    );
    expect(reducedMotion).toMatch(
      /\.scuttlebutt-bird\.is-cheer \.scuttlebutt-qk-happy\s*\{\s*opacity: 1;/,
    );
    expect(reducedMotion).toMatch(
      /\.scuttlebutt-bird\.is-sleep \.scuttlebutt-qk-zzz\s*\{\s*opacity: 1;/,
    );
    expect(reducedMotion).toMatch(
      /\.scuttlebutt-bird\.is-alert \.scuttlebutt-qk-mark\s*\{\s*opacity: 1;/,
    );
  });
});
