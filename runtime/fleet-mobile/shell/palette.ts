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
    surface: "#20201f",
    chip: "#313131",
    selected: "#414141",
    hairline: "#212120",
    hairlineStrong: "#3d3c3a",
    text: "#f9f9f7",
    textNav: "#c3c2b7",
    textMuted: "#97958d",
    textFaint: "#898781",
    inverse: "#f9f9f7",
    onInverse: "#282827",
    danger: "#e66767",
    awaiting: "#6fc6d6",
    running: "#d9b46a",
    runningRing: "#d9b46a4d",
    idle: "#74c99a",
    scrim: "rgba(0,0,0,0.5)",
    handle: "#4a4a48",
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
    bgDeep: "#efeee9",
    bg: "#f7f6f2",
    surface: "#ffffff",
    chip: "#ebe9e3",
    selected: "#e2e0d8",
    hairline: "#e4e2da",
    hairlineStrong: "#d3d0c6",
    text: "#1b1b19",
    textNav: "#45443f",
    textMuted: "#64625b",
    textFaint: "#706e66",
    inverse: "#1f1f1d",
    onInverse: "#f9f9f7",
    danger: "#b8352f",
    awaiting: "#0f7487",
    running: "#8f6512",
    runningRing: "#8f65124d",
    idle: "#1a7a4b",
    scrim: "rgba(20,20,18,0.32)",
    handle: "#ebe9e3",
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
 * (dark #151515 under 50% black → #0a0a0a, light #f7f6f2 under rgb(20 20 18 / .32) → #aeadaa).
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
