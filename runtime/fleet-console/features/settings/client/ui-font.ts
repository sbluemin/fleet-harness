import { sanitizeFontFamilyName } from "@fleet-console/font-picker/resolve";

import type { UiFontId, UiFontSettings } from "../../../core/client/src/integration/types.js";
import { UI_FONT_SIZE_RANGE } from "../shared/fonts.js";

export const DEFAULT_UI_FONT: UiFontSettings = { source: "builtin", id: "manrope", size: UI_FONT_SIZE_RANGE.defaultValue };

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

function normalizeUiFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < UI_FONT_SIZE_RANGE.min || value > UI_FONT_SIZE_RANGE.max) return UI_FONT_SIZE_RANGE.defaultValue;
  return value;
}

function isUiFontId(value: unknown): value is UiFontId {
  return value === "manrope" || value === "jetbrains-mono" || value === "source-code-pro";
}
