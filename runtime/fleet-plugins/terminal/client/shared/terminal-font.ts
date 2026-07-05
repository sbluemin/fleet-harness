import type { TerminalFontId, TerminalFontSettings } from "./types.js";

export interface CuratedTerminalFont {
  readonly id: TerminalFontId;
  readonly name: string;
  readonly familyName: string;
  readonly family: string;
  readonly meta: string;
}

export interface TerminalFontResolution {
  readonly status: "self-hosted" | "resolved" | "fallback";
  readonly fallbackName: string;
}

interface StoredTerminalFontSettings {
  readonly source?: unknown;
  readonly id?: unknown;
  readonly customName?: unknown;
  readonly size?: unknown;
}

const SYMBOLS_NERD_FONT_MONO_FAMILY = "Symbols Nerd Font Mono";
const TERMINAL_FONT_FALLBACK_STACK = `ui-monospace, "SF Mono", Menlo, "${SYMBOLS_NERD_FONT_MONO_FAMILY}", monospace`;
const DEFAULT_TERMINAL_FONT_SIZE = 14;
const MIN_TERMINAL_FONT_SIZE = 10;
const MAX_TERMINAL_FONT_SIZE = 22;
const MAX_CUSTOM_FONT_NAME_LENGTH = 128;
const FONT_RESOLVE_THRESHOLD_PX = 0.5;
const FONT_RESOLVE_PROBE = "mmmmmmmmmmwwwwiIl1 0O-_|┌ABCxyz";
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1F\x7F]/g;

export const TERMINAL_FONT_SIZE_RANGE = {
  min: MIN_TERMINAL_FONT_SIZE,
  max: MAX_TERMINAL_FONT_SIZE,
};

export const DEFAULT_TERMINAL_FONT_ID: TerminalFontId = "cascadia";

export const CURATED_TERMINAL_FONTS: readonly CuratedTerminalFont[] = [
  {
    id: "cascadia",
    name: "Cascadia Code",
    familyName: "Cascadia Code Variable",
    family: `"Cascadia Code Variable", ${TERMINAL_FONT_FALLBACK_STACK}`,
    meta: "Variable · terminal tuned",
  },
  {
    id: "jetbrains",
    name: "JetBrains Mono",
    familyName: "JetBrains Mono Variable",
    family: `"JetBrains Mono Variable", ${TERMINAL_FONT_FALLBACK_STACK}`,
    meta: "Variable · console mono",
  },
  {
    id: "fira-code",
    name: "Fira Code",
    familyName: "Fira Code Variable",
    family: `"Fira Code Variable", ${TERMINAL_FONT_FALLBACK_STACK}`,
    meta: "Variable · ligatures",
  },
  {
    id: "source-code-pro",
    name: "Source Code Pro",
    familyName: "Source Code Pro Variable",
    family: `"Source Code Pro Variable", ${TERMINAL_FONT_FALLBACK_STACK}`,
    meta: "Variable · Adobe mono",
  },
];

export const DEFAULT_TERMINAL_FONT = CURATED_TERMINAL_FONTS[0] as CuratedTerminalFont;

export function curatedTerminalFontById(id: TerminalFontId | null): CuratedTerminalFont {
  return CURATED_TERMINAL_FONTS.find((font) => font.id === id) ?? DEFAULT_TERMINAL_FONT;
}

export function createDefaultTerminalFontSettings(): TerminalFontSettings {
  return {
    source: "curated",
    id: DEFAULT_TERMINAL_FONT_ID,
    customName: "",
    family: DEFAULT_TERMINAL_FONT.family,
    size: DEFAULT_TERMINAL_FONT_SIZE,
  };
}

export function createCuratedTerminalFontSettings(id: TerminalFontId | null, size: number): TerminalFontSettings {
  const font = curatedTerminalFontById(id);
  return {
    source: "curated",
    id: font.id,
    customName: "",
    family: font.family,
    size: clampTerminalFontSize(size),
  };
}

export function createCustomTerminalFontSettings(customName: string, size: number): TerminalFontSettings {
  const sanitizedName = sanitizeCustomFontFamilyName(customName);
  return {
    source: "custom",
    id: null,
    customName: sanitizedName,
    family: sanitizedName ? `"${escapeFontFamilyName(sanitizedName)}", ${DEFAULT_TERMINAL_FONT.family}` : DEFAULT_TERMINAL_FONT.family,
    size: clampTerminalFontSize(size),
  };
}

export function parseTerminalFontSettingsValue(value: unknown): TerminalFontSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const stored = value as StoredTerminalFontSettings;
  const size = clampTerminalFontSize(typeof stored.size === "number" ? stored.size : DEFAULT_TERMINAL_FONT_SIZE);
  if (stored.source === "custom" && typeof stored.customName === "string") {
    return createCustomTerminalFontSettings(stored.customName, size);
  }
  if (typeof stored.id === "string" && isTerminalFontId(stored.id)) {
    return createCuratedTerminalFontSettings(stored.id, size);
  }
  return null;
}

export function parseStoredTerminalFontSettings(raw: string | null): TerminalFontSettings {
  if (!raw) return createDefaultTerminalFontSettings();
  try {
    const parsed = parseTerminalFontSettingsValue(JSON.parse(raw) as unknown);
    if (parsed !== null) return parsed;
  } catch {
    // 손상된 localStorage 값은 기본 Cascadia self-hosted 설정으로 복구한다.
  }
  return createDefaultTerminalFontSettings();
}

export function serializeTerminalFontSettings(settings: TerminalFontSettings): string {
  return JSON.stringify({
    source: settings.source,
    id: settings.id,
    customName: settings.customName,
    size: settings.size,
  });
}

export function clampTerminalFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(size)));
}

export function resolveTerminalFont(settings: TerminalFontSettings): TerminalFontResolution {
  if (settings.source === "curated") {
    return { status: "self-hosted", fallbackName: DEFAULT_TERMINAL_FONT.name };
  }
  if (!settings.customName) {
    return { status: "fallback", fallbackName: DEFAULT_TERMINAL_FONT.name };
  }
  return {
    status: fontResolves(settings.customName) ? "resolved" : "fallback",
    fallbackName: DEFAULT_TERMINAL_FONT.name,
  };
}

function fontResolves(name: string): boolean {
  if (typeof document === "undefined") return false;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return false;
  for (const generic of ["monospace", "serif", "sans-serif"]) {
    const candidateWidth = measureFontWidth(context, `"${escapeFontFamilyName(name)}", ${generic}`);
    const genericWidth = measureFontWidth(context, generic);
    if (Math.abs(candidateWidth - genericWidth) > FONT_RESOLVE_THRESHOLD_PX) return true;
  }
  return false;
}

function measureFontWidth(context: CanvasRenderingContext2D, family: string): number {
  context.font = `28px ${family}`;
  return context.measureText(FONT_RESOLVE_PROBE).width;
}

function isTerminalFontId(value: string): value is TerminalFontId {
  return CURATED_TERMINAL_FONTS.some((font) => font.id === value);
}

function sanitizeCustomFontFamilyName(name: string): string {
  return name.replace(CONTROL_CHARACTER_PATTERN, "").trim().slice(0, MAX_CUSTOM_FONT_NAME_LENGTH);
}

function escapeFontFamilyName(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
