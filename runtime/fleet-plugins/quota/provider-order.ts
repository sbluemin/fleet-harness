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
