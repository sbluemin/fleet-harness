import { CLI_DISPLAY_NAMES } from "../constants.js";
import {
  CONTROL_AND_C1_CHAR_PATTERN,
  sanitizeConfigKey,
} from "./sanitize.js";
import { readRawCarriers, updateCarriers } from "./state-io.js";

const DISPLAY_NAME_BIDI_CONTROL_PATTERN = /[\u202A-\u202E\u2066-\u2069]/g;
const DISPLAY_NAME_ZERO_WIDTH_PATTERN = /[\u200B-\u200D\uFEFF]/g;
const DISPLAY_NAME_MAX_LENGTH = 50;

/**
 * 디스크에서 carrier displayName 오버라이드 맵을 로드합니다.
 * 유효한 carrier ID와 displayName 값만 필터링하여 반환합니다.
 */
export function loadCarrierDisplayNameOverrides(validIds?: Set<string>): Record<string, string> {
  const displayNames = Object.fromEntries(
    Object.entries(readRawCarriers().carriers ?? {})
      .filter(([, state]) => !!sanitizeCarrierDisplayName(state.displayName))
      .map(([id, state]) => [id, sanitizeCarrierDisplayName(state.displayName)!]),
  );
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
  const sanitizedCarrierId = sanitizeConfigKey(carrierId, CONTROL_AND_C1_CHAR_PATTERN);
  if (!sanitizedCarrierId) return;

  const sanitizedDisplayName = sanitizeCarrierDisplayName(displayName);
  const sanitizedSourceDefault = sanitizeCarrierDisplayName(sourceDefaultDisplayName)
    ?? CLI_DISPLAY_NAMES[sanitizedCarrierId]
    ?? sanitizedCarrierId;

  updateCarriers((states) => {
    const carriers = { ...(states.carriers ?? {}) };
    const current = carriers[sanitizedCarrierId] ?? {};
    const next = { ...current };
    if (!sanitizedDisplayName || sanitizedDisplayName === sanitizedSourceDefault) {
      delete next.displayName;
    } else {
      next.displayName = sanitizedDisplayName;
    }
    carriers[sanitizedCarrierId] = next;
    states.carriers = carriers;
  });
}

export function normalizeCarrierDisplayNameInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (CONTROL_AND_C1_CHAR_PATTERN.test(value)) return null;

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
