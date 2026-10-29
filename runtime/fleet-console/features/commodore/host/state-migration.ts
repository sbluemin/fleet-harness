/** 옛 자동 운영·간격·종료 예약은 버린다. 옛 `directive` 키는 `description` 으로 접는다. 나머지는 각 reader의 strict 스키마가 검증한다. */
export function migrateCommodoreState(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { autonomy: _autonomy, patrolMinutes: _patrol, stopAt: _stop, directive: _directive, description: _description, ...rest } = value as Record<string, unknown>;
  // 저장 이관 B: `directive` 만 있으면 `description` 으로 옮기고, 둘 다 있으면 `description` 을 지키고 `directive` 를 버린다.
  // 이미 접힌 값은 그대로다(멱등). 새 파일에는 `description` 만 남는다.
  if (_description !== undefined) return { ...rest, description: _description };
  if (_directive !== undefined) return { ...rest, description: _directive };
  return rest;
}
