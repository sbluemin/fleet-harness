import { sanitizeFontFamilyName, withFontFallback } from "@fleet-console/font-picker/resolve";

import type { UiFontId, UiFontSettings } from "./types.js";

export interface UiFontBuiltIn {
  readonly id: UiFontId;
  readonly label: string;
  readonly name: string;
  readonly description: string;
  readonly family: string;
  readonly aliases: readonly string[];
}

export const UI_FONT_SIZE_RANGE = { min: 12, max: 18, step: 1, defaultValue: 14 } as const;

export const DEFAULT_UI_FONT: UiFontSettings = { source: "builtin", id: "manrope", size: UI_FONT_SIZE_RANGE.defaultValue };

export const UI_FONT_BUILT_INS: readonly UiFontBuiltIn[] = [
  { id: "manrope", label: "Fleet UI", name: "Manrope", description: "Balanced · Fleet default", family: '"Manrope Variable", "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', aliases: ["Manrope", "Fleet UI"] },
  { id: "jetbrains-mono", label: "Instrument Mono", name: "JetBrains Mono", description: "Uniform · technical scan", family: '"JetBrains Mono Variable", "Manrope Variable", "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', aliases: ["JetBrains Mono", "Instrument Mono"] },
  { id: "source-code-pro", label: "Source Mono", name: "Source Code Pro", description: "Open forms · compact", family: '"Source Code Pro Variable", "Manrope Variable", "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', aliases: ["Source Code Pro", "Source Mono"] },
];

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
