import { fetchSearch } from "./codex/api.js";

export interface ReaderSession {
  readonly entryId: string;
  readonly scrollTop: number;
  readonly expanded: boolean;
}

const READER_SESSION_PREFIX = "fleet.codex.reader.session.";
// 삭제 확인 뒤에도 화면 사본은 살아 있다. 스크롤·닫기 저장이 삭제된 세션을 되살리지 않게 한다.
const theaterEntries = new Map<string, ReadonlySet<string>>();

export function reconcileReaderSession(theaterId: string | null, entries: readonly { readonly id: string }[]): void {
  if (!theaterId) return;
  const indexedEntries = new Set(entries.map((entry) => entry.id));
  theaterEntries.set(theaterId, indexedEntries);
  const session = readReaderSession(theaterId);
  if (session && !indexedEntries.has(session.entryId)) clearReaderSession(theaterId, session.entryId);
}

/** 복원은 필터 없는 서버 index로 확인한다. 통신 실패를 문서 삭제로 해석하지 않는다. */
export async function validateReaderEntry(theaterId: string, workspaceId: string, entryId: string, signal: AbortSignal): Promise<boolean> {
  const result = await fetchSearch(workspaceId, { signal });
  if (signal.aborted) return false;
  const exists = result.entries.some((entry) => entry.id === entryId);
  if (!exists) clearReaderSession(theaterId, entryId);
  return exists;
}

export function clearReaderSession(theaterId: string, entryId: string): void {
  if (readReaderSession(theaterId)?.entryId !== entryId) return;
  try {
    localStorage.removeItem(`${READER_SESSION_PREFIX}${theaterId}`);
  } catch {
    // Storage is optional.
  }
}

export function readReaderSession(theaterId: string): ReaderSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(`${READER_SESSION_PREFIX}${theaterId}`) ?? "null") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.entryId !== "string" || record.entryId.length === 0) return null;
    if (typeof record.scrollTop !== "number" || !Number.isFinite(record.scrollTop) || record.scrollTop < 0) return null;
    return { entryId: record.entryId, scrollTop: record.scrollTop, expanded: record.expanded === true };
  } catch {
    return null;
  }
}

export function writeReaderSession(theaterId: string, session: ReaderSession): void {
  const indexedEntries = theaterEntries.get(theaterId);
  if (indexedEntries && !indexedEntries.has(session.entryId)) return;
  try {
    localStorage.setItem(`${READER_SESSION_PREFIX}${theaterId}`, JSON.stringify(session));
  } catch {
    // Storage is optional.
  }
}
