/**
 * 서버 order가 생기기 전 브라우저에 남아 있던 Objective 순서.
 * 키는 예전 캔버스 저장(`fleet-console.canvas.<theaterId>`)의 `objectiveRecordOrder` 필드다.
 */

const STORAGE_KEY_PREFIX = "fleet-console.canvas.";

export function readLegacyObjectiveOrder(theaterId: string): readonly string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(theaterId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? normalizeObjectiveOrder(parsed.objectiveRecordOrder) : [];
  } catch {
    return [];
  }
}

export function clearLegacyObjectiveOrder(theaterId: string): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(storageKey(theaterId));
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !("objectiveRecordOrder" in parsed)) return;
    delete parsed.objectiveRecordOrder;
    window.localStorage.setItem(storageKey(theaterId), JSON.stringify(parsed));
  } catch {
    // 브라우저 저장소를 쓸 수 없으면 다음 수화에서 다시 시도한다.
  }
}

function storageKey(theaterId: string): string {
  return `${STORAGE_KEY_PREFIX}${theaterId}`;
}

function normalizeObjectiveOrder(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const objectiveRecordOrder: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    objectiveRecordOrder.push(id);
  }
  return objectiveRecordOrder;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
