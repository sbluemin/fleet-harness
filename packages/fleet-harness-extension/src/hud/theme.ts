/**
 * core-hud/theme.ts — 테마 시스템 + 색상 헬퍼 + 아이콘 + 구분자 + 프리셋
 *
 * Colors are resolved in order:
 * 1. User overrides from theme.json (if exists)
 * 2. Preset colors
 * 3. Default colors
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ColorScheme,
  ColorValue,
  PresetDef,
  SemanticColor,
  SeparatorDef,
  StatusLinePreset,
  StatusLineSeparatorStyle,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// AnsiColors (colors.ts)
// ═══════════════════════════════════════════════════════════════════════════

export interface AnsiColors {
  getBgAnsi(r: number, g: number, b: number): string;
  getFgAnsi(r: number, g: number, b: number): string;
  getFgAnsi256(code: number): string;
  reset: string;
}

type ColorName = "sep";

export const ansi: AnsiColors = {
  getBgAnsi: (r, g, b) => `\x1b[48;2;${r};${g};${b}m`,
  getFgAnsi: (r, g, b) => `\x1b[38;2;${r};${g};${b}m`,
  getFgAnsi256: (code) => `\x1b[38;5;${code}m`,
  reset: "\x1b[0m",
};

const THEME: Record<ColorName, string | number> = {
  sep: 244,
};

export function fgOnly(color: ColorName, text: string): string {
  const code = getAnsiCode(color);
  return code ? `${code}${text}` : text;
}

export function getFgAnsiCode(color: ColorName): string {
  return getAnsiCode(color);
}

function getAnsiCode(color: ColorName): string {
  const value = THEME[color as keyof typeof THEME];

  if (value === undefined || value === "") {
    return "";
  }

  if (typeof value === "number") {
    return ansi.getFgAnsi256(value);
  }

  if (typeof value === "string" && value.startsWith("#")) {
    const [r, g, b] = hexToRgb(value);
    return ansi.getFgAnsi(r, g, b);
  }

  return "";
}

// ═══════════════════════════════════════════════════════════════════════════
// Theme (theme.ts)
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_COLORS: Required<ColorScheme> = {
  pi: "accent",
  model: "#d787af",
  path: "#00afaf",
  git: "success",
  gitDirty: "warning",
  gitClean: "success",
  thinking: "muted",
  thinkingHigh: "accent",
  cost: "text",
  tokens: "muted",
  separator: "dim",
  border: "borderMuted",
};

const GEEK_COLORS: Required<ColorScheme> = {
  pi: "#FDF500",
  model: "#BB9AF7",
  path: "#73DACA",
  git: "#9ECE6A",
  gitDirty: "#E0AF68",
  gitClean: "#9ECE6A",
  thinking: "#F7768E",
  thinkingHigh: "#FF9E64",
  cost: "#FF9E64",
  tokens: "#565F89",
  separator: "#3D59A1",
  border: "#3D59A1",
};

const RAINBOW_COLORS = [
  "#b281d6", "#d787af", "#febc38", "#e4c00f",
  "#89d281", "#00afaf", "#178fb9", "#b281d6",
];
const CACHE_TTL = 5000;

let userThemeCache: ColorScheme | null = null;
let userThemeCacheTime = 0;

export function resolveColor(
  semantic: SemanticColor,
  presetColors?: ColorScheme
): ColorValue {
  const userTheme = loadUserTheme();

  return userTheme[semantic]
    ?? presetColors?.[semantic]
    ?? DEFAULT_COLORS[semantic];
}

export function applyColor(
  theme: Theme,
  color: ColorValue,
  text: string
): string {
  if (isHexColor(color)) {
    return `${hexToAnsi(color)}${text}\x1b[0m`;
  }
  return theme.fg(color as ThemeColor, text);
}

export function fg(
  theme: Theme,
  semantic: SemanticColor,
  text: string,
  presetColors?: ColorScheme
): string {
  const color = resolveColor(semantic, presetColors);
  return applyColor(theme, color, text);
}

export function rainbow(text: string): string {
  let result = "";
  let colorIndex = 0;
  for (const char of text) {
    if (char === " " || char === ":") {
      result += char;
    } else {
      result += hexToAnsi(RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length]) + char;
      colorIndex++;
    }
  }
  return result + "\x1b[0m";
}

export function getDefaultColors(): Required<ColorScheme> {
  return { ...DEFAULT_COLORS };
}

export function getGeekColors(): Required<ColorScheme> {
  return { ...GEEK_COLORS };
}

function getThemePath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return join(homeDir, ".pi", "agent", "hud-theme.json");
}

function loadUserTheme(): ColorScheme {
  const now = Date.now();
  if (userThemeCache !== null && now - userThemeCacheTime < CACHE_TTL) {
    return userThemeCache;
  }

  const themePath = getThemePath();
  try {
    if (existsSync(themePath)) {
      const content = readFileSync(themePath, "utf-8");
      const parsed = JSON.parse(content);
      userThemeCache =
        parsed?.colors && typeof parsed.colors === "object"
          ? parsed.colors as ColorScheme
          : {};
      userThemeCacheTime = now;
      return userThemeCache;
    }
  } catch {
    // Ignore errors, use defaults
  }

  userThemeCache = {};
  userThemeCacheTime = now;
  return userThemeCache;
}

function isHexColor(color: ColorValue): color is `#${string}` {
  return typeof color === "string" && color.startsWith("#");
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function hexToAnsi(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Icons (icons.ts)
// ═══════════════════════════════════════════════════════════════════════════

export interface IconSet {
  pi: string;
  model: string;
  folder: string;
  branch: string;
  git: string;
  tokens: string;
  cost: string;
  time: string;
  agents: string;
  cache: string;
  input: string;
  output: string;
  host: string;
  session: string;
  auto: string;
  warning: string;
}

export interface SeparatorChars {
  arrowLeft: string;
  arrowRight: string;
  arrowThinLeft: string;
  arrowThinRight: string;
  slash: string;
  pipe: string;
  block: string;
  space: string;
  asciiLeft: string;
  asciiRight: string;
  dot: string;
}

export const SEP_DOT = " · ";

export const THINKING_TEXT_UNICODE: Record<string, string> = {
  minimal: "[min]",
  low: "[low]",
  medium: "[med]",
  high: "[high]",
  xhigh: "[xhi]",
};

export const THINKING_TEXT_NERD: Record<string, string> = {
  minimal: "\u{F0E7} min",
  low: "\u{F10C} low",
  medium: "\u{F192} med",
  high: "\u{F111} high",
  xhigh: "\u{F06D} xhi",
};

export const NERD_ICONS: IconSet = {
  pi: "\uE22C",
  model: "\uEC19",
  folder: "\uF115",
  branch: "\uF126",
  git: "\uF1D3",
  tokens: "\uE26B",
  cost: "\uF155",
  time: "\uF017",
  agents: "\uF0C0",
  cache: "\uF1C0",
  input: "\uF090",
  output: "\uF08B",
  host: "\uF109",
  session: "\uF550",
  auto: "\u{F0068}",
  warning: "\uF071",
};

export const ASCII_ICONS: IconSet = {
  pi: "[π]",
  model: "◈",
  folder: "📁",
  branch: "⎇",
  git: "⎇",
  tokens: "⊛",
  cost: "$",
  time: "◷",
  agents: "AG",
  cache: "cache",
  input: "in:",
  output: "out:",
  host: "host",
  session: "id",
  auto: "⚡",
  warning: "⚠",
};

export const NERD_SEPARATORS: SeparatorChars = {
  arrowLeft: "\uE0B0",
  arrowRight: "\uE0B2",
  arrowThinLeft: "\uE0B1",
  arrowThinRight: "\uE0B3",
  slash: "/",
  pipe: "|",
  block: "█",
  space: " ",
  asciiLeft: ">",
  asciiRight: "<",
  dot: "·",
};

export const ASCII_SEPARATORS: SeparatorChars = {
  arrowLeft: ">",
  arrowRight: "<",
  arrowThinLeft: "|",
  arrowThinRight: "|",
  slash: "/",
  pipe: "|",
  block: "#",
  space: " ",
  asciiLeft: ">",
  asciiRight: "<",
  dot: ".",
};

export function getThinkingText(level: string): string | undefined {
  if (hasNerdFonts()) {
    return THINKING_TEXT_NERD[level];
  }
  return THINKING_TEXT_UNICODE[level];
}

export function hasNerdFonts(): boolean {
  if (process.env.HUD_CORE_NERD_FONTS === "1") return true;
  if (process.env.HUD_CORE_NERD_FONTS === "0") return false;

  if (process.env.GHOSTTY_RESOURCES_DIR) return true;

  const term = (process.env.TERM_PROGRAM || "").toLowerCase();
  const nerdTerms = ["iterm", "wezterm", "kitty", "ghostty", "alacritty"];
  return nerdTerms.some(t => term.includes(t));
}

export function getIcons(): IconSet {
  return hasNerdFonts() ? NERD_ICONS : ASCII_ICONS;
}

export function getSeparatorChars(): SeparatorChars {
  return hasNerdFonts() ? NERD_SEPARATORS : ASCII_SEPARATORS;
}

// ═══════════════════════════════════════════════════════════════════════════
// Separators (separators.ts)
// ═══════════════════════════════════════════════════════════════════════════

export function getSeparator(style: StatusLineSeparatorStyle): SeparatorDef {
  const chars = getSeparatorChars();

  switch (style) {
    case "arrow":
      return {
        left: chars.arrowLeft,
        right: chars.arrowRight,
        endCaps: {
          left: chars.arrowRight,
          right: chars.arrowLeft,
          useBgAsFg: true,
        },
      };

    case "arrow-thin":
      return {
        left: chars.arrowThinLeft,
        right: chars.arrowThinRight,
        endCaps: {
          left: chars.arrowRight,
          right: chars.arrowLeft,
          useBgAsFg: true,
        },
      };

    case "slash":
      return { left: ` ${chars.slash} `, right: ` ${chars.slash} ` };

    case "pipe":
      return { left: ` ${chars.pipe} `, right: ` ${chars.pipe} ` };

    case "block":
      return { left: chars.block, right: chars.block };

    case "none":
      return { left: chars.space, right: chars.space };

    case "ascii":
      return { left: chars.asciiLeft, right: chars.asciiRight };

    case "dot":
      return { left: chars.dot, right: chars.dot };

    case "chevron":
      return { left: "›", right: "‹" };

    case "star":
      return { left: "✦", right: "✦" };

    default:
      return getSeparator("arrow-thin");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Presets (presets.ts)
// ═══════════════════════════════════════════════════════════════════════════

export const PRESETS: Record<StatusLinePreset, PresetDef> = {
  sbluemin: {
    leftSegments: ["pi", "model", "thinking", "path", "git"],
    rightSegments: ["cost", "time_spent"],
    secondarySegments: ["extension_statuses"],
    separator: "chevron",
    colors: getGeekColors(),
    segmentOptions: {
      pi: { label: "Fleet" },
      model: { showThinkingLevel: false },
      path: { mode: "abbreviated", maxLength: 35 },
      git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
    },
  },
};

export function getPreset(name: StatusLinePreset): PresetDef {
  return PRESETS[name] ?? PRESETS.sbluemin;
}
