/** 옛 자동 운영·간격·종료 예약은 버린다. 옛 `directive` 키는 `description` 으로 접는다. 나머지는 각 reader의 strict 스키마가 검증한다. */
export function migrateCommodoreState(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const { autonomy: _autonomy, patrolMinutes: _patrol, stopAt: _stop, directive: _directive, description: _description, routines, ...rest } = record;
  // 이관 C: 사람 요청 출처(`requestedBy`)는 보드 보관 권한과 함께 사라졌다. 옛 루틴에서 걷어낸다(멱등).
  const migratedRoutines = Array.isArray(routines) ? routines.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("requestedBy" in entry)) return entry;
    const { requestedBy: _drop, ...kept } = entry as Record<string, unknown>;
    return kept;
  }) : routines;
  const state = { ...rest, ...(routines !== undefined ? { routines: migratedRoutines } : {}) };
  // 저장 이관 B: `directive` 만 있으면 `description` 으로 옮기고, 둘 다 있으면 `description` 을 지키고 `directive` 를 버린다.
  // 이미 접힌 값은 그대로다(멱등). 새 파일에는 `description` 만 남는다.
  if (_description !== undefined) return { ...state, description: _description };
  if (_directive !== undefined) return { ...state, description: _directive };
  return state;
}
