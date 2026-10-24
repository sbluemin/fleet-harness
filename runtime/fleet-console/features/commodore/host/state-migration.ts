/**
 * 이전 state.json의 자율 운영 스위치를 순찰 설정으로 접는다. 저장소·엔티티·디렉터리 이전이 같은 변환을 쓴다.
 * 나머지 필드는 그대로 두어 각 reader의 strict 스키마가 검증한다. 원본은 여기서 쓰거나 지우지 않는다.
 */
export function migrateCommodorePatrolState(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const state = value as Record<string, unknown>;
  if (typeof state.autonomy !== "boolean") return value;
  const { autonomy, stopAt, ...rest } = state;
  // 켜져 있던 상태는 기존 간격(미설정 60분), 꺼져 있던 상태는 안 함으로 잇는다.
  const patrolMinutes = autonomy ? (rest.patrolMinutes ?? 60) : "off";
  return { ...rest, patrolMinutes, ...(patrolMinutes !== "off" && stopAt !== undefined ? { stopAt } : {}) };
}
