export const PROVIDER_ORDER_DEFAULT = ["claude", "anthropic", "codex", "xai", "muse-code", "opencode", "gemini"] as const;
export type ProviderId = (typeof PROVIDER_ORDER_DEFAULT)[number];

/**
 * Console이 로그인을 소유하는 공급자 — 키가 없거나 만료되면 한도 대신 로그인 카드가 선다.
 * 플러그인 경로와 Gateway 마운트(`ai-gateway/oauth/<id>`)의 조각이기도 하다.
 */
export const LOGIN_PROVIDERS = ["codex", "xai", "muse-code"] as const satisfies readonly ProviderId[];
export type LoginProvider = (typeof LOGIN_PROVIDERS)[number];

export function isLoginProvider(value: unknown): value is LoginProvider {
  return (LOGIN_PROVIDERS as readonly unknown[]).includes(value);
}

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

/**
 * 사용자가 고른 표시 순서. 집합과 달리 저장 순서를 유지한다.
 * 모르는 id와 중복은 버리고, 빠진 id는 기본 순서대로 뒤에 붙인다.
 * 배열이 아니면(키 없음·다른 타입) 기본 순서다 — 릴리스가 공급자를 더하거나 빼도 목록이 비지 않는다.
 */
export function sanitizeProviderOrder(value: unknown): ProviderId[] {
  const ordered: ProviderId[] = [];
  const seen = new Set<ProviderId>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isProviderId(entry) || seen.has(entry)) continue;
      seen.add(entry);
      ordered.push(entry);
    }
  }
  for (const id of PROVIDER_ORDER_DEFAULT) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

export function sameProviderOrder(left: readonly ProviderId[], right: readonly ProviderId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** 한 칸 이웃과 바꾼다. 줄의 끝이면 순서를 바꾸지 않는다. */
export function shiftProviderOrder(
  order: readonly ProviderId[],
  id: ProviderId,
  delta: -1 | 1,
): ProviderId[] {
  const next = sanitizeProviderOrder([...order]);
  const from = next.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= next.length) return next;
  const swapped = next.slice();
  const moving = swapped[from];
  const neighbor = swapped[to];
  if (moving === undefined || neighbor === undefined) return next;
  swapped[from] = neighbor;
  swapped[to] = moving;
  return swapped;
}
