import { CLI_DISPLAY_NAMES } from "../constants.js";
import { readStatesSnapshot, updateStates } from "./state-io.js";

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const DISPLAY_NAME_BIDI_CONTROL_PATTERN = /[\u202A-\u202E\u2066-\u2069]/g;
const DISPLAY_NAME_ZERO_WIDTH_PATTERN = /[\u200B-\u200D\uFEFF]/g;
const DISPLAY_NAME_MAX_LENGTH = 50;

/**
 * 디스크에서 carrier displayName 오버라이드 맵을 로드합니다.
 * 유효한 carrier ID와 displayName 값만 필터링하여 반환합니다.
 */
export function loadCarrierDisplayNames(validIds?: Set<string>): Record<string, string> {
  const displayNames = sanitizeCarrierDisplayNames(readStatesSnapshot().carrierDisplayNames);
  if (!validIds) return displayNames;
  return Object.fromEntries(
    Object.entries(displayNames).filter(([id]) => validIds.has(id)),
  );
}

/**
 * 단일 carrier의 displayName 오버라이드를 저장하거나 기본값이면 제거합니다.
 */
export function updateCarrierDisplayName(
  carrierId: string,
  displayName: string,
  sourceDefaultDisplayName: string,
): void {
  const sanitizedCarrierId = sanitizeConfigKey(carrierId);
  if (!sanitizedCarrierId) return;

  const sanitizedDisplayName = sanitizeCarrierDisplayName(displayName);
  const sanitizedSourceDefault = sanitizeCarrierDisplayName(sourceDefaultDisplayName)
    ?? CLI_DISPLAY_NAMES[sanitizedCarrierId]
    ?? sanitizedCarrierId;

  updateStates((states) => {
    const displayNames = sanitizeCarrierDisplayNames(states.carrierDisplayNames);
    if (!sanitizedDisplayName || sanitizedDisplayName === sanitizedSourceDefault) {
      delete displayNames[sanitizedCarrierId];
    } else {
      displayNames[sanitizedCarrierId] = sanitizedDisplayName;
    }

    if (Object.keys(displayNames).length > 0) {
      states.carrierDisplayNames = displayNames;
    } else {
      delete states.carrierDisplayNames;
    }
  });
}

export function normalizeCarrierDisplayNameInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (CONTROL_CHAR_PATTERN.test(value)) return null;

  const normalized = value
    .replace(DISPLAY_NAME_BIDI_CONTROL_PATTERN, "")
    .replace(DISPLAY_NAME_ZERO_WIDTH_PATTERN, "")
    .slice(0, DISPLAY_NAME_MAX_LENGTH);

  return normalized;
}

export function sanitizeCarrierDisplayName(value: unknown): string | null {
  const normalized = normalizeCarrierDisplayNameInput(value);
  if (normalized == null) return null;

  const trimmed = normalized.trim();
  if (!trimmed) return null;
  return trimmed;
}

function sanitizeCarrierDisplayNames(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [id, displayName] of Object.entries(value)) {
    const sanitizedId = sanitizeConfigKey(id);
    const sanitizedDisplayName = sanitizeCarrierDisplayName(displayName);
    if (!sanitizedId || !sanitizedDisplayName) continue;
    result[sanitizedId] = sanitizedDisplayName;
  }
  return result;
}

function sanitizeConfigKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || CONTROL_CHAR_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
