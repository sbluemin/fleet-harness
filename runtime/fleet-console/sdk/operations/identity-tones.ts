/**
 * 정체성 톤 — Operation 강조색과 사이드바 그룹 색이 함께 쓰는 여덟 키. 각 키는 테마의 `--id-<key>` 토큰이다.
 *
 * 그룹 색은 이 키 중 하나여야 영속 상태에 남는다(목록 밖 색을 가진 그룹은 불러올 때 버려진다). 그래서 그룹이나 강조색을
 * 쓰는 쪽(호스트 메뉴·Console Use·플러그인 라우트)은 사본을 두지 않고 이 목록으로 검사한다.
 */
export const IDENTITY_TONES = ["crimson", "amber", "moss", "teal", "cerulean", "indigo", "plum", "rose"] as const;

export type IdentityTone = (typeof IDENTITY_TONES)[number];

export function isIdentityTone(value: unknown): value is IdentityTone {
  return typeof value === "string" && (IDENTITY_TONES as readonly string[]).includes(value);
}

// 구 16키 → 8톤 매핑(hue 최근접). 영속 스키마는 그대로 — 저장된 구키는 읽는 시점에 바꿔 보이고,
// 새 선택은 8톤 키로 저장된다. 모르는 키는 null(톤 없음)이다.
const LEGACY_TONES: Readonly<Record<string, IdentityTone>> = {
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

/** 저장된 키를 지금의 여덟 톤 중 하나로 — 구키는 가장 가까운 톤으로, 모르는 키와 빈 값은 null. */
export function normalizeIdentityTone(value: string | null | undefined): IdentityTone | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (isIdentityTone(value)) return value;
  return LEGACY_TONES[value] ?? null;
}
