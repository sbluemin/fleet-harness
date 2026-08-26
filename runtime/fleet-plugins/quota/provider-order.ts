export const PROVIDER_ORDER_DEFAULT = ["claude", "codex", "xai", "cursor", "opencode", "kimi", "antigravity"] as const;
export type ProviderId = (typeof PROVIDER_ORDER_DEFAULT)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return (PROVIDER_ORDER_DEFAULT as readonly unknown[]).includes(value);
}

/**
 * 저장된 순서는 릴리스 경계를 넘는다: 공급자가 추가·제거된 뒤에도 옛 설정이 남는다.
 * 읽기 쪽에서 모르는 id를 버리고 빠진 id를 기본 순서로 덧붙여야, 어떤 설정 파일이
 * 남아 있어도 카드가 전부 그리고 정확히 한 번씩 그려진다.
 */
export function sanitizeProviderOrder(value: unknown): ProviderId[] {
  const order: ProviderId[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isProviderId(entry) && !order.includes(entry)) order.push(entry);
    }
  }
  for (const id of PROVIDER_ORDER_DEFAULT) {
    if (!order.includes(id)) order.push(id);
  }
  return order;
}

/**
 * 접힘 집합도 릴리스 경계를 넘는다. 모르는 id를 버리고 중복을 걷어야 옛 설정 파일이
 * 남아 있어도 접힘이 실재하는 카드에만 붙는다. 순서와 달리 빠진 id는 채우지 않는다 —
 * 목록에 없다는 것이 곧 "펼침"이라는 뜻이기 때문이다. 반환은 늘 기본 순서로 정렬해
 * 같은 집합이 늘 같은 페이로드가 되게 한다.
 */
export function sanitizeFoldedProviders(value: unknown): ProviderId[] {
  const seen = new Set<ProviderId>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isProviderId(entry)) seen.add(entry);
    }
  }
  return PROVIDER_ORDER_DEFAULT.filter((id) => seen.has(id));
}

/** 한 공급자의 접힘을 뒤집는다. 결과는 sanitize와 같은 기본 순서를 유지한다. */
export function toggledFoldedProviders(
  folded: readonly ProviderId[],
  id: ProviderId,
): ProviderId[] {
  const next = new Set(folded);
  if (!next.delete(id)) next.add(id);
  return PROVIDER_ORDER_DEFAULT.filter((entry) => next.has(entry));
}
