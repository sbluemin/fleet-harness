import { sanitizeFontFamilyName, withFontFallback } from "@fleet-console/font-picker/resolve";

import type { UiFontId, UiFontSettings } from "./types.js";

export interface UiFontBuiltIn {
  readonly id: UiFontId;
  readonly label: string;
  readonly name: string;
  readonly family: string;
  readonly aliases: readonly string[];
}

export const UI_FONT_SIZE_RANGE = { min: 12, max: 18, step: 1, defaultValue: 14 } as const;

export const DEFAULT_UI_FONT: UiFontSettings = { source: "builtin", id: "manrope", size: UI_FONT_SIZE_RANGE.defaultValue };

export const UI_FONT_BUILT_INS: readonly UiFontBuiltIn[] = [
  { id: "manrope", label: "Fleet UI", name: "Manrope", family: '"Manrope Variable", "Manrope", "Pretendard Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', aliases: ["Manrope", "Fleet UI"] },
  { id: "jetbrains-mono", label: "Instrument Mono", name: "JetBrains Mono", family: '"JetBrains Mono Variable", "Manrope Variable", "Manrope", "Pretendard Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', aliases: ["JetBrains Mono", "Instrument Mono"] },
  { id: "source-code-pro", label: "Source Mono", name: "Source Code Pro", family: '"Source Code Pro Variable", "Manrope Variable", "Manrope", "Pretendard Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', aliases: ["Source Code Pro", "Source Mono"] },
];

/** 내장 글꼴 설명 카탈로그 키 — 소비처에서 t()로 해석한다. */
export const UI_FONT_DESCRIPTION_KEYS = {
  manrope: "settings.typography.font.manrope",
  "jetbrains-mono": "settings.typography.font.jetbrains-mono",
  "source-code-pro": "settings.typography.font.source-code-pro",
} as const;

export function normalizeUiFont(value: unknown): UiFontSettings {
  if (!value || typeof value !== "object") return DEFAULT_UI_FONT;
  const candidate = value as { readonly source?: unknown; readonly id?: unknown; readonly familyName?: unknown; readonly size?: unknown };
  const size = normalizeUiFontSize(candidate.size);
  if (candidate.source === "builtin" && isUiFontId(candidate.id)) return { source: "builtin", id: candidate.id, size };
  if (candidate.source === "system" && typeof candidate.familyName === "string") {
    const familyName = sanitizeFontFamilyName(candidate.familyName);
    if (familyName) return { source: "system", familyName, size };
  }
  return DEFAULT_UI_FONT;
}

export function normalizeUiFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < UI_FONT_SIZE_RANGE.min || value > UI_FONT_SIZE_RANGE.max) return UI_FONT_SIZE_RANGE.defaultValue;
  return value;
}

export function uiFontFamily(value: UiFontSettings): string {
  if (value.source === "system") return withFontFallback(value.familyName, UI_FONT_BUILT_INS[0]!.family);
  return builtInUiFont(value.id).family;
}

export function builtInUiFont(id: UiFontId): UiFontBuiltIn {
  return UI_FONT_BUILT_INS.find((font) => font.id === id) ?? UI_FONT_BUILT_INS[0]!;
}

function isUiFontId(value: unknown): value is UiFontId {
  return value === "manrope" || value === "jetbrains-mono" || value === "source-code-pro";
}
