export const PROVIDER_ORDER_DEFAULT = ["claude", "codex", "xai", "cursor", "opencode", "antigravity", "muse-code"] as const;
export type ProviderId = (typeof PROVIDER_ORDER_DEFAULT)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return (PROVIDER_ORDER_DEFAULT as readonly unknown[]).includes(value);
}

/**
 * 공급자 집합(도구모음에 세울 공급자)은 릴리스 경계를 넘는다. 모르는 id를 버리고 중복을 걷어야
 * 옛 설정 파일이 남아 있어도 실재하는 공급자만 남는다. 빠진 id는 채우지 않는다 — 목록에 없다는 것이
 * 곧 "고르지 않음"이다. 반환은 늘 기본 순서로 정렬해 같은 집합이 늘 같은 페이로드가 되게 한다.
 */
export function sanitizeProviderSet(value: unknown): ProviderId[] {
  const seen = new Set<ProviderId>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isProviderId(entry)) seen.add(entry);
    }
  }
  return PROVIDER_ORDER_DEFAULT.filter((id) => seen.has(id));
}

/** 한 공급자를 집합에 넣거나 뺀다. 결과는 sanitize와 같은 기본 순서를 유지한다. */
export function toggledProviderSet(
  set: readonly ProviderId[],
  id: ProviderId,
): ProviderId[] {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return PROVIDER_ORDER_DEFAULT.filter((entry) => next.has(entry));
}
