import type { OperationNode } from "../types.js";

export interface AccentOption {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

// 8톤 정체성 팔레트 — theme.css의 --id-* 토큰을 참조해 테마별 채도 봉투를 그대로 추종한다.
// 정체성은 스파인·명판 마크·틱·도트 채널만 소유하고, 보더/링/beacon/glow는 상태 신호 전용이다.
export const OPERATION_ACCENTS: readonly AccentOption[] = [
  { key: "crimson", label: "Crimson", color: "var(--id-crimson)" },
  { key: "amber", label: "Amber", color: "var(--id-amber)" },
  { key: "moss", label: "Moss", color: "var(--id-moss)" },
  { key: "teal", label: "Teal", color: "var(--id-teal)" },
  { key: "cerulean", label: "Cerulean", color: "var(--id-cerulean)" },
  { key: "indigo", label: "Indigo", color: "var(--id-indigo)" },
  { key: "plum", label: "Plum", color: "var(--id-plum)" },
  { key: "rose", label: "Rose", color: "var(--id-rose)" },
] as const;

// 구 16키 → 8톤 매핑(hue 최근접). durable 스키마는 불변 — 저장된 구키는 읽기 시점에 변환되고,
// 새 선택은 8톤 키로 저장된다. 미지 키는 null(accent 없음)로 폴백한다.
const LEGACY_ACCENT_KEYS: Readonly<Record<string, string>> = {
  red: "crimson",
  orange: "amber",
  yellow: "amber",
  lime: "moss",
  green: "moss",
  emerald: "teal",
  cyan: "teal",
  sky: "cerulean",
  blue: "cerulean",
  violet: "plum",
  purple: "plum",
  magenta: "rose",
};

export function normalizeAccentKey(accentKey: string | null | undefined): string | null {
  if (typeof accentKey !== "string" || accentKey.length === 0) return null;
  if (OPERATION_ACCENTS.some((accent) => accent.key === accentKey)) return accentKey;
  return LEGACY_ACCENT_KEYS[accentKey] ?? null;
}

export function resolveAccentColor(accentKey: string): string | null {
  const normalized = normalizeAccentKey(accentKey);
  if (!normalized) return null;
  return OPERATION_ACCENTS.find((accent) => accent.key === normalized)?.color ?? null;
}

export function operationAccentFromNode(operation: OperationNode): string | null {
  return typeof operation.accent === "string" ? operation.accent : null;
}
