/**
 * 그룹 접힘(대화 순환 순서가 읽는다)과 Objective 액센트(제목 잉크).
 * 영속 키는 예전 캔버스 저장(`fleet-console.canvas.<theaterId>`)을 유지하고,
 * 그 JSON의 다른 필드는 지우지 않는다 — 퇴역한 최소화 필드만 첫 로드에 걷는다.
 */
const STORAGE_KEY_PREFIX = "fleet-console.canvas.";
// 캔버스가 퇴역하며 함께 사라진 최소화 상태 — 같은 키 JSON의 `minimized` 필드와 탭 세션의 부팅 최소화 표식.
const LEGACY_MINIMIZED_FIELD = "minimized";
const LEGACY_BOOT_MINIMIZED_SESSION_KEY = "fleet.console.boot-minimized-theaters";
dropLegacyMinimizedState();

export interface GroupCollapseSlice {
  readonly collapsedGroups: readonly string[];
  readonly objectiveRecordAccent: Readonly<Record<string, string>>;
}

const EMPTY_SLICE: GroupCollapseSlice = { collapsedGroups: [], objectiveRecordAccent: {} };

/** Theater마다 분리된 표시 상태를 읽는다. */
export function getTheaterGroupCollapse(theaterId: string): GroupCollapseSlice { return readSlice(theaterId); }
export function forgetTheaterGroupCollapse(theaterId: string): void {
  try { window.localStorage.removeItem(storageKey(theaterId)); } catch { /* 보기 선호의 실패는 삭제를 막지 않는다. */ }
}

/** 사라진 Objective의 액센트만 해당 Theater의 저장에서 걷는다. */
export function pruneObjectiveAccents(theaterId: string, validIds: ReadonlySet<string>): void {
  const stored = readSlice(theaterId);
  const objectiveRecordAccent = Object.fromEntries(Object.entries(stored.objectiveRecordAccent).filter(([id]) => validIds.has(id)));
  if (Object.keys(objectiveRecordAccent).length === Object.keys(stored.objectiveRecordAccent).length) return;
  writeSlice(theaterId, { ...stored, objectiveRecordAccent });
}

function storageKey(theaterId: string): string {
  return `${STORAGE_KEY_PREFIX}${theaterId}`;
}

function readSlice(theaterId: string): GroupCollapseSlice {
  const parsed = readRaw(theaterId);
  if (!parsed) return EMPTY_SLICE;
  return {
    collapsedGroups: normalizeStringArray(parsed.collapsedGroups),
    objectiveRecordAccent: normalizeObjectiveAccent(parsed.objectiveRecordAccent),
  };
}

function readRaw(theaterId: string): Record<string, unknown> | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(storageKey(theaterId));
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSlice(theaterId: string, next: GroupCollapseSlice): void {
  if (typeof window === "undefined") return;
  try {
    const existing = readRaw(theaterId) ?? {};
    window.localStorage.setItem(storageKey(theaterId), JSON.stringify({
      ...existing,
      collapsedGroups: next.collapsedGroups,
      objectiveRecordAccent: next.objectiveRecordAccent,
    }));
  } catch {
    // 저장 실패는 접힘 복구성만 낮추므로 런타임 흐름을 막지 않는다.
  }
}

function normalizeStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function normalizeObjectiveAccent(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const objectiveRecordAccent: Record<string, string> = {};
  for (const [id, accentKey] of Object.entries(value)) {
    if (typeof accentKey !== "string") continue;
    objectiveRecordAccent[id] = accentKey;
  }
  return objectiveRecordAccent;
}

/** 모든 Theater 키에서 `minimized` 필드만 지운다. collapsedGroups·objectiveRecordAccent·objectiveRecordOrder 등 나머지는 그대로 둔다. */
function dropLegacyMinimizedState(): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(LEGACY_BOOT_MINIMIZED_SESSION_KEY); } catch { /* ignore */ }
  try {
    const storage = window.localStorage;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      try {
        const raw = storage.getItem(key);
        if (!raw) continue;
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || !(LEGACY_MINIMIZED_FIELD in parsed)) continue;
        delete parsed[LEGACY_MINIMIZED_FIELD];
        storage.setItem(key, JSON.stringify(parsed));
      } catch {
        // 손상된 값은 readRaw가 이미 빈 상태로 읽으므로 그대로 두고 다음 키로 간다.
      }
    }
  } catch {
    // 브라우저 저장소를 쓸 수 없으면 정리만 건너뛴다.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
