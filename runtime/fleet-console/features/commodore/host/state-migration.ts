/** 옛 자동 운영·간격·종료 예약은 버린다. 나머지는 각 reader의 strict 스키마가 검증한다. */
export function migrateCommodoreState(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { autonomy: _autonomy, patrolMinutes: _patrol, stopAt: _stop, ...rest } = value as Record<string, unknown>;
  return rest;
}
