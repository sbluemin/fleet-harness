import type { CarrierSubagentMode } from "./types.js";

export const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
export const CONTROL_AND_C1_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export function sanitizeGeneration(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) return 0;
  return value as number;
}

export function sanitizeConfigKey(
  value: string,
  controlPattern: RegExp = CONTROL_CHAR_PATTERN,
): string | null {
  const trimmed = value.trim();
  if (!trimmed || controlPattern.test(trimmed)) return null;
  return trimmed;
}

export function sanitizeFreeformText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || CONTROL_CHAR_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeCarrierModes(value: unknown): Record<string, CarrierSubagentMode> {
  if (!isRecord(value)) return {};
  const result: Record<string, CarrierSubagentMode> = {};
  for (const [carrierId, mode] of Object.entries(value)) {
    const sanitizedCarrierId = sanitizeConfigKey(carrierId);
    if (sanitizedCarrierId && mode === "subagent") result[sanitizedCarrierId] = "subagent";
  }
  return result;
}
