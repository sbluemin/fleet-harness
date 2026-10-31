/**
 * The mobile palette for the native screens. Values copy the web `--m-*` tokens one for one
 * (design-system §2, impl-spec §1-1); a native view has no CSS variables to share them through.
 */

export type Scheme = "dark" | "light";

export const ID_TONES = ["crimson", "amber", "moss", "teal", "cerulean", "indigo", "plum", "rose"] as const;
export type IdTone = (typeof ID_TONES)[number];

export interface Palette {
  readonly scheme: Scheme;
  readonly bgDeep: string;
  readonly bg: string;
  readonly surface: string;
  readonly chip: string;
  readonly selected: string;
  readonly hairline: string;
  readonly hairlineStrong: string;
  readonly text: string;
  readonly textNav: string;
  readonly textMuted: string;
  readonly textFaint: string;
  readonly inverse: string;
  readonly onInverse: string;
  readonly danger: string;
  readonly awaiting: string;
  readonly running: string;
  /** `--m-running` at 30%: the resting ring of the running glyph. */
  readonly runningRing: string;
  readonly idle: string;
  readonly scrim: string;
  readonly handle: string;
  /** The input field face; the web sets white on light rather than the surface token. */
  readonly field: string;
  /** `bg` under `scrim`: the bar colour while the page dims for a sheet (bridge chrome "scrim", v1.5). */
  readonly bgUnderScrim: string;
  readonly id: Readonly<Record<IdTone, string>>;
}

export const PALETTE: Readonly<Record<Scheme, Palette>> = {
  dark: withScrimBar({
    scheme: "dark",
    bgDeep: "#111111",
    bg: "#151515",
    surface: "#1f1f1f",
    chip: "rgba(245,245,245,0.06)",
    selected: "rgba(245,245,245,0.08)",
    hairline: "rgba(245,245,245,0.1)",
    hairlineStrong: "#3d3d3d",
    text: "#f5f5f5",
    textNav: "rgba(245,245,245,0.66)",
    textMuted: "rgba(245,245,245,0.54)",
    textFaint: "rgba(245,245,245,0.54)",
    inverse: "#f5f5f5",
    onInverse: "#282828",
    danger: "#e66767",
    awaiting: "#6fc6d6",
    running: "#d9b46a",
    runningRing: "#d9b46a4d",
    idle: "#74c99a",
    scrim: "rgba(0,0,0,0.697)",
    handle: "#4a4a4a",
    field: "#151515",
    id: {
      crimson: "#d49a95",
      amber: "#c8a47a",
      moss: "#94b68c",
      teal: "#75b9b4",
      cerulean: "#7fb2d1",
      indigo: "#a0a7d7",
      plum: "#be9dc8",
      rose: "#ce99b1",
    },
  }),
  light: withScrimBar({
    scheme: "light",
    bgDeep: "#f5f5f5",
    bg: "#fcfcfc",
    surface: "#ffffff",
    chip: "rgba(28,28,28,0.06)",
    selected: "rgba(28,28,28,0.08)",
    hairline: "rgba(28,28,28,0.12)",
    hairlineStrong: "#d3d3d3",
    text: "#1c1c1c",
    textNav: "rgba(28,28,28,0.68)",
    textMuted: "rgba(28,28,28,0.56)",
    textFaint: "rgba(28,28,28,0.56)",
    inverse: "#1c1c1c",
    onInverse: "#ffffff",
    danger: "#b8352f",
    awaiting: "#0f7487",
    running: "#8f6512",
    runningRing: "#8f65124d",
    idle: "#1a7a4b",
    scrim: "rgba(0,0,0,0.5)",
    handle: "#ebebeb",
    field: "#ffffff",
    id: {
      crimson: "#924c47",
      amber: "#85581b",
      moss: "#44703b",
      teal: "#00746f",
      cerulean: "#1c6b91",
      indigo: "#575d99",
      plum: "#7a5186",
      rose: "#8b4b6b",
    },
  }),
};

function withScrimBar(palette: Omit<Palette, "bgUnderScrim">): Palette {
  return { ...palette, bgUnderScrim: overlay(palette.bg, palette.scrim) };
}

/**
 * Lays an `rgba()` colour over an opaque `#rrggbb`, the way the WebView paints the page's scrim: the alpha
 * is quantised to 8 bits first and each channel rounded, so the bars match the dimmed page to the digit
 * (dark #151515 under 69.7% black → #060606, light #fcfcfc under 50% black → #7e7e7e).
 */
export function overlay(base: string, rgba: string): string {
  const under = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(base);
  const over = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(rgba);
  if (!under || !over) return base;
  const alpha = Math.round(Number(over[4]) * 255) / 255;
  const channel = (index: number) => {
    const value = Math.round(parseInt(under[index]!, 16) * (1 - alpha) + Number(over[index]) * alpha);
    return value.toString(16).padStart(2, "0");
  };
  return `#${channel(1)}${channel(2)}${channel(3)}`;
}

/** The scanner is a camera context and stays dark whatever the mode (impl-spec S-24). */
export const SCANNER = {
  bg: "#0d0f0e",
  ink: "#f9f9f7",
  caption: "#d7d5ce",
  button: "rgba(255,255,255,0.14)",
  inverseInk: "#151515",
  danger: PALETTE.dark.danger,
} as const;

/** A stable identity tone per Console, so the same Console keeps its colour across launches. */
export function toneFor(key: string): IdTone {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ID_TONES[(hash >>> 0) % ID_TONES.length] ?? "indigo";
}

export function monogramFor(label: string): string {
  const first = Array.from(label.trim())[0];
  return first ? first.toLocaleUpperCase() : "?";
}
